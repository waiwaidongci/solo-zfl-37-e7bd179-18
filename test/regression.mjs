// 墨锭试磨室回归测试：node test/regression.mjs（或 npm test）
// 独立临时库运行，不触碰 data/ink-stick-testing.json
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const PORT = 3957;
const BASE = `http://localhost:${PORT}`;
const serverPath = fileURLToPath(new URL("../server.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ink-regression-"));
const dbPath = join(dir, "db.json");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("PASS:", name);
  } catch (error) {
    failed += 1;
    console.log("FAIL:", name, "-", error.message);
  }
}
const get = async path => {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.json() };
};
const post = async (path, data, key) => {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["Idempotency-Key"] = key;
  const res = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(data || {}) });
  return { status: res.status, body: await res.json() };
};
const readDb = () => JSON.parse(readFileSync(dbPath, "utf8"));
const instrument = async code => (await get("/api/instruments")).body.find(i => i.code === code);
const item = async code => (await get("/api/items")).body.find(i => i.code === code);

function startServer(port, db, extraEnv = {}) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port), DB_PATH: db, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", d => process.stderr.write(d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 8000);
    child.stdout.on("data", d => {
      if (String(d).includes("listening")) { clearTimeout(timer); resolve(child); }
    });
    child.on("exit", code => { clearTimeout(timer); reject(new Error("服务异常退出 code=" + code)); });
  });
}

const server = await startServer(PORT, dbPath);

try {
  // ---------- 缺陷1：空库并发首次初始化只能发生一次 ----------
  await test("空库并发首次初始化：并行请求全部成功且只初始化一次", async () => {
    const results = await Promise.all([
      get("/api/items"), get("/api/instruments"), get("/api/standards"), get("/api/stats"),
      post("/api/items", { code: "IS-INIT", smokeSource: "松烟", status: "待试磨" })
    ]);
    for (const r of results) assert.ok(r.status === 200 || r.status === 201, "状态码异常: " + r.status + " " + JSON.stringify(r.body));
    assert.ok(existsSync(dbPath), "库文件未生成");
    const db = readDb();
    assert.equal(db.instruments.length, 2, "种子仪器应初始化一次");
    assert.equal(db.standards.length, 2, "种子标准器应初始化一次");
    assert.equal(db.items.filter(i => i.code === "IS-INIT").length, 1, "并发中的建档应成功一次");
    assert.equal(readdirSync(dir).filter(f => f.endsWith(".tmp")).length, 0, "不应残留临时文件");
  });

  await test("页面可访问且包含仪器校准入口", async () => {
    const res = await fetch(BASE + "/");
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(html.includes("仪器校准") && html.includes("溯源链") && html.includes("viewport"), "页面缺少关键元素");
  });

  // ---------- 溯源强制 ----------
  await test("标准器必须能追溯到上级基准（无上级无基准被拒）", async () => {
    const r = await post("/api/standards", { code: "STD-X", name: "无溯源砝码", uncertainty: 0.1 });
    assert.equal(r.status, 400);
    assert.ok(r.body.error.includes("追溯到上级基准"));
  });
  await test("创建子级标准器", async () => {
    const r = await post("/api/standards", { code: "STD-003", name: "二等砝码", parameter: "质量", uncertainty: 0.003, parentId: "STD-ROOT", validUntil: "2027-01-01", certificateNo: "JJF-3" });
    assert.equal(r.status, 201);
    assert.equal(r.body.code, "STD-003");
  });
  await test("标准器编号重复被拒", async () => {
    const r = await post("/api/standards", { code: "STD-003", name: "重复", uncertainty: 0.1, refName: "x" });
    assert.equal(r.status, 409);
  });
  await test("标准器溯源链与链上合成不确定度", async () => {
    const standards = (await get("/api/standards")).body;
    const s2 = standards.find(s => s.code === "STD-002");
    assert.equal(s2.chainOk, true);
    assert.deepEqual(s2.chainPath, ["STD-002", "STD-001"]);
    assert.equal(s2.topRef, "省计量科学研究院质量基准");
    assert.equal(s2.chainUncertainty, 0.0055); // sqrt(0.005^2+0.002^2+0.001^2)
  });

  // ---------- 仪器建档 ----------
  await test("创建仪器", async () => {
    const r = await post("/api/instruments", { code: "INS-003", name: "分析天平", parameter: "质量", range: "0-200g", cycleMonths: 6 });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, "在用");
  });
  await test("仪器编号重复被拒", async () => {
    const r = await post("/api/instruments", { code: "INS-003", name: "重复", cycleMonths: 6 });
    assert.equal(r.status, 409);
  });

  // ---------- 试磨与仪器联动 ----------
  await test("试磨记录保存原值并按修正值校正评分", async () => {
    const r = await post("/api/items/IS-001/action", { paper: "宣纸", score: "86", instrumentId: "INS-BALANCE" });
    assert.equal(r.status, 201);
    const t = r.body.tests.at(-1);
    assert.equal(t.rawScore, 86);
    assert.equal(t.score, 86); // 86 + (-0.01) 修约为 86
    assert.equal(t.correction, -0.01);
    assert.equal(t.reviewStatus, "正常");
  });
  await test("未校准仪器不能用于试磨结论", async () => {
    const r = await post("/api/items/IS-001/action", { paper: "宣纸", score: "80", instrumentId: "INS-RULER" });
    assert.equal(r.status, 409);
    assert.ok(r.body.reasons.includes("未校准"));
  });

  // ---------- 失准 -> 待复核 -> 复校 -> 复核 ----------
  await test("校准超差：受影响试磨记录标为待复核并生成影响记录", async () => {
    const r = await post("/api/instruments/INS-BALANCE/calibrations", { result: "超差", error: 2.5, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-09-01" });
    assert.equal(r.status, 201);
    assert.equal(r.body.marked, 1);
    assert.equal(r.body.impact.cause, "校准超差");
    assert.equal((await get("/api/impacts")).body.length, 1);
    assert.equal((await instrument("INS-001")).pendingReview, 1);
  });
  await test("超差仪器不能用于试磨结论", async () => {
    const r = await post("/api/items/IS-001/action", { paper: "宣纸", score: "90", instrumentId: "INS-BALANCE" });
    assert.equal(r.status, 409);
    assert.ok(r.body.reasons.includes("校准超差"));
  });
  await test("未复校合格前不能复核", async () => {
    const r = await post("/api/instruments/INS-BALANCE/review");
    assert.equal(r.status, 409);
    assert.ok(r.body.error.includes("尚未复校合格"));
  });
  await test("复校合格：各级不确定度按方和根合成", async () => {
    const r = await post("/api/instruments/INS-BALANCE/calibrations", { kind: "复校", result: "合格", error: -3, uncertainty: 0.006, standardId: "STD-003", at: "2026-09-10" });
    assert.equal(r.status, 201);
    assert.equal(r.body.calibration.combinedUncertainty, 0.0071); // sqrt(0.006^2 + 0.003^2+0.002^2+0.001^2)
    assert.equal(r.body.calibration.correction, 3);
  });
  await test("复核按原值重算并保留前后版本", async () => {
    const r = await post("/api/instruments/INS-BALANCE/review");
    assert.equal(r.status, 200);
    assert.equal(r.body.recalculated, 1);
    assert.equal(r.body.tests[0].before, 86);
    assert.equal(r.body.tests[0].after, 89); // 原值86 + 修正值3
    const it = await item("IS-001");
    const t = it.tests.at(-1);
    assert.equal(t.reviewStatus, "已复核");
    assert.equal(t.versions.length, 2);
    assert.equal(t.versions[0].score, 86);
    assert.equal(t.versions[1].score, 89);
    assert.equal(it.status, "已试磨"); // 89 >= 85
    assert.equal((await get("/api/impacts")).body[0].status, "已复核");
  });
  await test("复核自然幂等：重复复核重算 0 条", async () => {
    const r = await post("/api/instruments/INS-BALANCE/review");
    assert.equal(r.status, 200);
    assert.equal(r.body.recalculated, 0);
  });

  // ---------- 幂等与并发 ----------
  await test("相同幂等键的重复校准只入账一次", async () => {
    const key = "reg-key-1";
    await post("/api/instruments/INS-BALANCE/calibrations", { result: "合格", error: 0.1, uncertainty: 0.005, standardId: "STD-WORK" }, key);
    const r2 = await post("/api/instruments/INS-BALANCE/calibrations", { result: "合格", error: 0.1, uncertainty: 0.005, standardId: "STD-WORK" }, key);
    assert.equal(r2.body.deduplicated, true);
    assert.equal((await instrument("INS-001")).calibrations.length, 4);
  });
  await test("并发同键停用只成功一次", async () => {
    const key = "reg-key-conc";
    const results = await Promise.all(Array.from({ length: 5 }, () => post("/api/instruments/INS-BALANCE/deactivate", {}, key)));
    assert.equal(results.filter(r => r.body.deduplicated).length, 4);
    const ins = await instrument("INS-001");
    assert.equal(ins.status, "停用");
    assert.equal(ins.logs.filter(l => l.step === "停用").length, 1);
  });
  await test("无键重复停用自然幂等", async () => {
    const r = await post("/api/instruments/INS-BALANCE/deactivate");
    assert.equal(r.body.already, true);
    await post("/api/instruments/INS-BALANCE/activate");
    assert.equal((await instrument("INS-001")).status, "在用");
  });

  // ---------- 过期与断链 ----------
  await test("校准过期的仪器不可用于试磨结论", async () => {
    await post("/api/instruments/INS-003/calibrations", { result: "合格", error: 0.1, uncertainty: 0.005, standardId: "STD-WORK", at: "2025-01-01", validUntil: "2025-07-01" });
    const ins = await instrument("INS-003");
    assert.equal(ins.usable, false);
    assert.ok(ins.reasons.includes("校准已过期"));
  });
  await test("标准器证书过期导致溯源链断裂", async () => {
    await post("/api/standards", { code: "STD-OLD", name: "过期砝码", parameter: "质量", uncertainty: 0.001, refName: "国家基准", validUntil: "2020-01-01" });
    await post("/api/instruments/INS-003/calibrations", { result: "合格", error: 0.1, uncertainty: 0.005, standardId: "STD-OLD", at: "2026-09-01" });
    const ins = await instrument("INS-003");
    assert.ok(ins.reasons.includes("溯源链断裂"));
    assert.equal(ins.combinedUncertainty, null);
  });

  // ---------- 缺陷2：补录过去日期的校准不覆盖最新状态 ----------
  await test("最新校准状态按校准日期选择，补录旧日期不覆盖", async () => {
    const ins = (await post("/api/instruments", { code: "INS-DATE", name: "日期仪", parameter: "质量", cycleMonths: 12 })).body;
    await post(`/api/instruments/${ins.id}/calibrations`, { result: "合格", error: 1, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-03-01" });
    await post(`/api/instruments/${ins.id}/calibrations`, { result: "合格", error: 0.2, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-09-01" });
    const backfill = await post(`/api/instruments/${ins.id}/calibrations`, { result: "超差", error: 9, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-01-01" });
    assert.equal(backfill.status, 201);
    const got = await instrument("INS-DATE");
    assert.equal(got.latest.at, "2026-09-01", "最新校准应按日期取 2026-09-01");
    assert.equal(got.latest.error, 0.2);
    assert.equal(got.correction, -0.2);
    assert.equal(got.usable, true, "补录的过去超差不影响当前可用性");
  });
  await test("补录超差仅标记该校准间隔内的试磨记录", async () => {
    const ins = (await post("/api/instruments", { code: "INS-W", name: "窗口仪", parameter: "质量", cycleMonths: 12 })).body;
    await post(`/api/instruments/${ins.id}/calibrations`, { result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-01-01" });
    await post(`/api/instruments/${ins.id}/calibrations`, { result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-09-01" });
    await post("/api/items", { code: "IS-W1", smokeSource: "松烟", status: "已试磨" });
    // 直接注入三条不同日期的历史试磨（API 不提供补录试磨日期）
    const db = readDb();
    const target = db.items.find(i => i.code === "IS-W1");
    const mk = (id, at) => ({ id, at, paper: "宣纸", water: "", speed: "", colorLayer: "", sediment: "", instrumentId: ins.id, score: 80, rawScore: 80, reviewStatus: "正常", versions: [{ at, score: 80, correction: 0, reason: "录入" }] });
    target.tests = [mk("TST-W-BEFORE", "2025-12-15T00:00:00.000Z"), mk("TST-W-IN", "2026-03-15T00:00:00.000Z"), mk("TST-W-AFTER", "2026-10-15T00:00:00.000Z")];
    writeFileSync(dbPath, JSON.stringify(db, null, 2));
    const r = await post(`/api/instruments/${ins.id}/calibrations`, { result: "超差", error: 2, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-06-01" });
    assert.equal(r.body.marked, 1, "窗口内只有 2026-03-15 一条");
    const it = await item("IS-W1");
    const byId = Object.fromEntries(it.tests.map(t => [t.id, t.reviewStatus]));
    assert.equal(byId["TST-W-BEFORE"], "正常", "窗口之前的不受影响");
    assert.equal(byId["TST-W-IN"], "待复核", "窗口内的标为待复核");
    assert.equal(byId["TST-W-AFTER"], "正常", "窗口之后（已有更晚合格校准）的不受影响");
  });

  // ---------- 缺陷3：复核较早记录后整锭状态按全部当前有效记录重算 ----------
  await test("复核较早高分记录后，整锭状态仍由最新记录决定", async () => {
    const ins = (await post("/api/instruments", { code: "INS-REV", name: "复核仪", parameter: "质量", cycleMonths: 12 })).body;
    await post(`/api/instruments/${ins.id}/calibrations`, { result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-08-01" });
    await post("/api/items", { code: "IS-REV", smokeSource: "油烟", status: "待试磨" });
    await post("/api/items/IS-REV/action", { paper: "宣纸", score: "90", instrumentId: ins.id }); // 较早高分
    await post("/api/items/IS-REV/action", { paper: "棉连纸", score: "70" });                    // 更晚低分（不用仪器）
    assert.equal((await item("IS-REV")).status, "重点观察");
    await post(`/api/instruments/${ins.id}/calibrations`, { result: "超差", error: 5, uncertainty: 0.01, standardId: "STD-WORK" });
    await post(`/api/instruments/${ins.id}/calibrations`, { kind: "复校", result: "合格", error: -5, uncertainty: 0.01, standardId: "STD-WORK" });
    const review = await post(`/api/instruments/${ins.id}/review`);
    assert.equal(review.body.recalculated, 1);
    assert.equal(review.body.tests[0].after, 95); // 原值90 + 修正值5
    const it = await item("IS-REV");
    assert.equal(it.tests[0].score, 95, "较早记录被重算为更高分");
    assert.equal(it.status, "重点观察", "整锭状态必须由更晚的低分记录决定，不能被改高");
  });

  // ---------- 缺陷4：未来日期的校准不能作为当前有效证据 ----------
  await test("未来日期的校准被拒绝且不影响仪器状态", async () => {
    const before = await instrument("INS-001");
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const r = await post("/api/instruments/INS-BALANCE/calibrations", { result: "超差", error: 9, uncertainty: 0.01, standardId: "STD-WORK", at: tomorrow });
    assert.equal(r.status, 400);
    assert.ok(r.body.error.includes("当天"), "应提示不能晚于当天: " + r.body.error);
    const after = await instrument("INS-001");
    assert.equal(after.calibrations.length, before.calibrations.length, "被拒绝的校准不应入账");
    assert.equal(after.latest.at, before.latest.at, "最新状态不应变化");
    assert.equal(after.usable, before.usable, "可用性不应变化");
  });
  await test("库中已存在的未来日期校准不作为当前有效证据", async () => {
    const db = readDb();
    const ins = db.instruments.find(i => i.id === "INS-BALANCE");
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    ins.calibrations.push({ id: "CAL-FUTURE", at: future, kind: "校准", result: "超差", error: 9, correction: -9, uncertainty: 0.01, standardId: "STD-WORK", standardCode: "STD-002", validUntil: "2099-01-01", chainOk: true, combinedUncertainty: 0.01 });
    writeFileSync(dbPath, JSON.stringify(db, null, 2));
    const got = await instrument("INS-001");
    assert.notEqual(got.latest.at, future, "未来校准不应成为最新状态");
    assert.equal(got.usable, true, "未来的超差记录不影响当前可用性");
    const restored = readDb();
    const list = restored.instruments.find(i => i.id === "INS-BALANCE");
    list.calibrations = list.calibrations.filter(c => c.id !== "CAL-FUTURE");
    writeFileSync(dbPath, JSON.stringify(restored, null, 2));
    assert.equal((await instrument("INS-001")).usable, true);
  });

  // ---------- 缺陷5：月末加月回落到目标月最后一天 ----------
  await test("校准周期从月末加月回落到目标月最后一天", async () => {
    const ins1 = (await post("/api/instruments", { code: "INS-EOM", name: "月末仪", parameter: "质量", cycleMonths: 1 })).body;
    const r1 = await post(`/api/instruments/${ins1.id}/calibrations`, { result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-01-31" });
    assert.equal(r1.body.calibration.validUntil, "2026-02-28", "1月31日+1月应落在2月28日");
    const r2 = await post(`/api/instruments/${ins1.id}/calibrations`, { result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-WORK", at: "2024-01-31" });
    assert.equal(r2.body.calibration.validUntil, "2024-02-29", "闰年应落在2月29日");
    const ins3 = (await post("/api/instruments", { code: "INS-EOM3", name: "季末仪", parameter: "质量", cycleMonths: 3 })).body;
    const r3 = await post(`/api/instruments/${ins3.id}/calibrations`, { result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-01-31" });
    assert.equal(r3.body.calibration.validUntil, "2026-04-30", "1月31日+3月应落在4月30日");
    const r4 = await post(`/api/instruments/${ins3.id}/calibrations`, { result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-01-15" });
    assert.equal(r4.body.calibration.validUntil, "2026-04-15", "非月末日期不受影响");
  });

  // ---------- 缺陷6：整条溯源链的测量参数必须一致 ----------
  await test("登记标准器时参数与上级不一致被拒", async () => {
    const created = await post("/api/standards", { code: "STD-LEN", name: "线纹尺", parameter: "长度", uncertainty: 0.001, refName: "国家长度基准", validUntil: "2028-01-01" });
    assert.equal(created.status, 201);
    const r = await post("/api/standards", { code: "STD-BADMIX", name: "错配砝码", parameter: "质量", uncertainty: 0.001, parentId: "STD-LEN" });
    assert.equal(r.status, 400);
    assert.ok(r.body.error.includes("一致"), "应提示参数必须一致: " + r.body.error);
  });
  await test("上级标准器测量不同物理量时整条链判为断裂", async () => {
    // 创建入口已拦截，直接注入历史遗留的跨物理量链
    const db = readDb();
    db.standards.push(
      { id: "STD-BAD-P", code: "STD-BAD-P", name: "长度基准尺", parameter: "长度", uncertainty: 0.001, parentId: null, refName: "国家长度基准", refUncertainty: 0.0005, validUntil: "2028-01-01", certificateNo: "X1" },
      { id: "STD-BAD-C", code: "STD-BAD-C", name: "错配工作砝码", parameter: "质量", uncertainty: 0.002, parentId: "STD-BAD-P", refName: "", refUncertainty: 0, validUntil: "2028-01-01", certificateNo: "X2" }
    );
    writeFileSync(dbPath, JSON.stringify(db, null, 2));
    const std = (await get("/api/standards")).body.find(s => s.code === "STD-BAD-C");
    assert.equal(std.chainOk, false, "跨物理量的链应判为断裂");
    assert.ok(std.chainReason.includes("参数不一致"), "应报告参数不一致: " + std.chainReason);
    const ins = (await post("/api/instruments", { code: "INS-MIX", name: "错配仪", parameter: "质量", cycleMonths: 12 })).body;
    await post(`/api/instruments/${ins.id}/calibrations`, { result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-BAD-C", at: "2026-09-01" });
    const got = await instrument("INS-MIX");
    assert.equal(got.usable, false, "链断裂的仪器不可用于试磨结论");
    assert.ok(got.reasons.includes("溯源链断裂"));
    assert.equal(got.combinedUncertainty, null, "断链时无法合成不确定度");
  });

  // ---------- 缺陷7：不存在的日期必须拒绝 ----------
  await test("不存在的日期（如2月30日）必须拒绝", async () => {
    for (const bad of ["2026-02-30", "2026-02-29", "2026-13-01", "2026-04-31", "2026-00-10"]) {
      const r = await post("/api/instruments/INS-BALANCE/calibrations", { result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-WORK", at: bad });
      assert.equal(r.status, 400, bad + " 应被拒绝");
      assert.ok(r.body.error.includes("不存在") || r.body.error.includes("格式"), bad + " 应提示日期非法: " + r.body.error);
    }
    const r2 = await post("/api/instruments/INS-BALANCE/calibrations", { result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-WORK", validUntil: "2027-02-30" });
    assert.equal(r2.status, 400, "有效期也不允许不存在的日期");
    const r3 = await post("/api/standards", { code: "STD-BADDATE", name: "错期砝码", uncertainty: 0.001, refName: "x", validUntil: "2027-02-30" });
    assert.equal(r3.status, 400, "标准器证书有效期同样校验");
    const ok = await post("/api/instruments/INS-BALANCE/calibrations", { result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-WORK", at: "2024-02-29" });
    assert.equal(ok.status, 201, "闰年2月29日应合法");
  });

  // ---------- 缺陷8：当天按业务时区判断（固定时钟） ----------
  await test("固定时钟：上海凌晨的本地当天不被误判为未来日期", async () => {
    const tzDir = mkdtempSync(join(tmpdir(), "ink-tz-"));
    const tzDb = join(tzDir, "db.json");
    // UTC 2026-09-15 22:30 = 上海 2026-09-16 06:30
    const srv = await startServer(PORT + 2, tzDb, { INK_FIXED_NOW: "2026-09-15T22:30:00.000Z" });
    const postTz = data => fetch(`http://localhost:${PORT + 2}/api/instruments/INS-BALANCE/calibrations`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }).then(r => r.status);
    try {
      assert.equal(await postTz({ result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-09-16" }), 201, "上海当地当天 2026-09-16 不应被拒");
      assert.equal(await postTz({ result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-09-17" }), 400, "业务时区的明天仍是未来日期");
      assert.equal(await postTz({ result: "合格", error: 0, uncertainty: 0.01, standardId: "STD-WORK", at: "2026-09-15" }), 201, "昨天可补录");
      const ins = (await (await fetch(`http://localhost:${PORT + 2}/api/instruments`)).json()).find(i => i.id === "INS-BALANCE");
      assert.equal(ins.latest.at, "2026-09-16", "业务当天的证书即为当前有效证据");
      assert.equal(ins.usable, true);
    } finally {
      srv.kill();
      rmSync(tzDir, { recursive: true, force: true });
    }
  });

  // ---------- 缺陷9：页面与服务端月末加月结果一致 ----------
  await test("页面与服务端月末加月结果一致（多浏览器时区）", async () => {
    const html = await (await fetch(BASE + "/")).text();
    const match = html.match(/function addMonthsStr[\s\S]*?\n    \}/);
    assert.ok(match, "页面应包含 addMonthsStr");
    const cases = [["2026-01-31", 1, "2026-02-28"], ["2024-01-31", 1, "2024-02-29"], ["2026-01-31", 3, "2026-04-30"], ["2026-10-31", 1, "2026-11-30"], ["2026-01-15", 1, "2026-02-15"], ["2026-12-31", 1, "2027-01-31"]];
    for (const tz of ["Asia/Shanghai", "UTC", "America/New_York", "Pacific/Kiritimati"]) {
      const out = execFileSync(process.execPath, ["-e",
        `const addMonthsStr = ${match[0]};console.log(JSON.stringify(${JSON.stringify(cases.map(c => [c[0], c[1]]))}.map(([d, m]) => addMonthsStr(d, m))));`
      ], { env: { ...process.env, TZ: tz } });
      assert.deepEqual(JSON.parse(String(out)), cases.map(c => c[2]), tz + " 下页面加月结果应与服务端月末一致");
    }
  });

  // ---------- 原子写盘：写失败不留半条记录 ----------
  await test("写盘失败返回500且不留半条仪器/证书/影响记录", async () => {
    const roDir = mkdtempSync(join(tmpdir(), "ink-ro-"));
    const roDb = join(roDir, "db.json");
    copyFileSync(dbPath, roDb);
    const before = readDb().instruments.find(i => i.id === "INS-BALANCE").calibrations.length;
    chmodSync(roDir, 0o555);
    const srv = await startServer(PORT + 1, roDb);
    try {
      const res = await fetch(`http://localhost:${PORT + 1}/api/instruments/INS-BALANCE/calibrations`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result: "合格", error: 0.2, uncertainty: 0.004, standardId: "STD-WORK" })
      });
      assert.equal(res.status, 500);
      const alive = await fetch(`http://localhost:${PORT + 1}/api/instruments`);
      assert.equal(alive.status, 200, "写失败后服务应存活");
    } finally {
      srv.kill();
    }
    const db = JSON.parse(readFileSync(roDb, "utf8"));
    assert.equal(db.instruments.find(i => i.id === "INS-BALANCE").calibrations.length, before, "校准次数不应变化");
    assert.equal(readdirSync(roDir).filter(f => f.includes(".tmp")).length, 0, "不应残留临时文件");
    chmodSync(roDir, 0o755);
    rmSync(roDir, { recursive: true, force: true });
  });
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n===== 通过 ${passed} 项, 失败 ${failed} 项 =====`);
process.exit(failed ? 1 : 0);
