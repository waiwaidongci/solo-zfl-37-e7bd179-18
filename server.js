import http from "node:http";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "ink-stick-testing.json");
const port = Number(process.env.PORT || 3037);
const seed = {
  "items": [
    {
      "code": "IS-001",
      "smokeSource": "黄山松烟",
      "glueRatio": "7.5%",
      "ageYears": 8,
      "storage": "恒湿柜B",
      "status": "已试磨",
      "logs": [
        {
          "at": "2026-06-11",
          "step": "试磨",
          "note": "宣纸20滴水，出墨快，评分86",
          "score": 86
        }
      ]
    },
    {
      "code": "IS-002",
      "smokeSource": "桐油烟",
      "glueRatio": "8%",
      "ageYears": 3,
      "storage": "试样盒C",
      "status": "待试磨",
      "logs": []
    }
  ],
  "standards": [
    {
      "id": "STD-ROOT",
      "code": "STD-001",
      "name": "一等标准砝码组",
      "parameter": "质量",
      "uncertainty": 0.002,
      "parentId": null,
      "refName": "省计量科学研究院质量基准",
      "refUncertainty": 0.001,
      "validUntil": "2027-12-31",
      "certificateNo": "JJF-2026-0001"
    },
    {
      "id": "STD-WORK",
      "code": "STD-002",
      "name": "F1级工作砝码",
      "parameter": "质量",
      "uncertainty": 0.005,
      "parentId": "STD-ROOT",
      "refName": "",
      "refUncertainty": 0,
      "validUntil": "2027-06-30",
      "certificateNo": "JJF-2026-0002"
    }
  ],
  "instruments": [
    {
      "id": "INS-BALANCE",
      "code": "INS-001",
      "name": "电子天平",
      "parameter": "质量",
      "range": "0-500 g",
      "cycleMonths": 12,
      "status": "在用",
      "calibrations": [
        {
          "id": "CAL-SEED-1",
          "at": "2026-03-01",
          "kind": "校准",
          "result": "合格",
          "error": 0.01,
          "correction": -0.01,
          "uncertainty": 0.008,
          "standardId": "STD-WORK",
          "standardCode": "STD-002",
          "validUntil": "2027-03-01",
          "chainOk": true,
          "combinedUncertainty": 0.0097
        }
      ],
      "logs": [
        { "at": "2026-03-01", "step": "校准", "note": "合格，示值误差0.01，不确定度0.008，标准器STD-002" }
      ]
    },
    {
      "id": "INS-RULER",
      "code": "INS-002",
      "name": "标准研墨尺",
      "parameter": "长度",
      "range": "0-150 mm",
      "cycleMonths": 24,
      "status": "在用",
      "calibrations": [],
      "logs": []
    }
  ],
  "impacts": [],
  "requests": {}
};
const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
const stages = ["待试磨","已试磨","重点观察"];
const statLabels = ["待试磨","已试磨","重点观察"];
const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"]];
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const uid = prefix => prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const round1 = n => Number(n.toFixed(1));
const round4 = n => Number(n.toFixed(4));
const clampScore = n => Math.min(100, Math.max(0, round1(n)));

function addMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCMonth(d.getUTCMonth() + Number(months || 0));
  return d.toISOString().slice(0, 10);
}

// 原子写盘：唯一临时文件 + rename，失败时清理临时文件，原文件保持完整
let tmpCounter = 0;
async function writeAtomic(filePath, text) {
  const tmp = filePath + "." + process.pid + "." + (tmpCounter++) + ".tmp";
  try {
    await writeFile(tmp, text);
    await rename(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
// 空库初始化单例：并发首访共享同一次初始化，失败时复位允许下次重试
let initPromise = null;
function ensureDbFile() {
  if (!initPromise) {
    initPromise = (async () => {
      if (!existsSync(dbPath)) {
        await mkdir(dirname(dbPath), { recursive: true });
        await writeAtomic(dbPath, JSON.stringify(seed, null, 2));
      }
    })().catch(error => { initPromise = null; throw error; });
  }
  return initPromise;
}
async function loadDb() {
  await ensureDbFile();
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.items ||= [];
  db.instruments ||= [];
  db.standards ||= [];
  db.impacts ||= [];
  db.requests ||= {};
  return db;
}
async function saveDb(db) { await writeAtomic(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}

// 写操作串行队列：并发的校准/停用/复校/复核请求依次执行，配合幂等键只成功一次
let queue = Promise.resolve();
function enqueue(task) {
  const result = queue.then(task);
  queue = result.then(() => {}, () => {});
  return result;
}
async function mutate(req, res, handler) {
  const key = req.headers["idempotency-key"];
  await enqueue(async () => {
    try {
      const db = await loadDb();
      if (key && db.requests[key]) {
        const saved = db.requests[key];
        return send(res, saved.status, { ...saved.body, deduplicated: true });
      }
      const result = await handler(db);
      if (key && result.status < 300) {
        db.requests[key] = { at: nowIso(), status: result.status, body: result.body };
      }
      await saveDb(db);
      send(res, result.status, result.body);
    } catch (error) {
      // 校验或写盘失败：不落盘、不留半条记录，进程不崩溃
      if (res.headersSent) return console.error(error);
      if (error instanceof HttpError) return send(res, error.status, { error: error.message, ...(error.extra || {}) });
      console.error(error);
      send(res, 500, { error: "写入失败，数据未变更：" + error.message });
    }
  });
}

function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}

// ---------- 仪器校准与量值溯源 ----------
function findItem(db, id) { return db.items.find(x => x.id === id || x.code === id); }
function findInstrument(db, id) { return db.instruments.find(x => x.id === id || x.code === id); }
function findStandard(db, id) { return db.standards.find(x => x.id === id || x.code === id); }
function eachTest(db, fn) {
  for (const item of db.items) {
    for (const test of item.tests || []) fn(item, test);
  }
}

// 沿标准器逐级上溯到上级基准，校验溯源链并合成链上不确定度（方和根）
function traceChain(db, standardId, today) {
  const chain = [];
  const seen = new Set();
  let current = findStandard(db, standardId);
  if (!current) return { ok: false, reason: "标准器不存在", chain };
  let sumSquares = 0;
  while (current) {
    if (seen.has(current.id)) return { ok: false, reason: "溯源链存在循环", chain };
    seen.add(current.id);
    const expired = !!(current.validUntil && current.validUntil < today);
    chain.push({ ...current, expired });
    if (expired) return { ok: false, reason: "标准器" + current.code + "证书已过期", chain };
    sumSquares += Number(current.uncertainty || 0) ** 2;
    if (current.parentId) {
      const parent = findStandard(db, current.parentId);
      if (!parent) return { ok: false, reason: "标准器" + current.code + "的上级标准器缺失", chain };
      current = parent;
    } else {
      if (!current.refName) return { ok: false, reason: "标准器" + current.code + "未追溯到上级基准", chain };
      sumSquares += Number(current.refUncertainty || 0) ** 2;
      // 链上合成保留全精度，仅在展示与落盘时修约，避免中间舍入误差
      return { ok: true, chain, topRef: current.refName, chainUncertainty: Math.sqrt(sumSquares) };
    }
  }
}

// 最新校准按校准日期选择（并列时取后录入者），与数组顺序无关，补录旧日期不会覆盖当前状态
function latestCalibration(calibrations) {
  let best = null, bestIdx = -1;
  (calibrations || []).forEach((c, i) => {
    const at = c.at || "";
    if (!best || at > (best.at || "") || (at === (best.at || "") && i > bestIdx)) { best = c; bestIdx = i; }
  });
  return best;
}

// 仪器可用性：停用、未校准、超差、过期、溯源链断裂均不可用于试磨结论
function instrumentState(db, instrument, today) {
  const latest = latestCalibration(instrument.calibrations);
  const state = { latest, validUntil: latest ? latest.validUntil : null, reasons: [], chain: null, combinedUncertainty: null, correction: 0, usable: false };
  if (instrument.status === "停用") state.reasons.push("已停用");
  if (!latest) {
    state.reasons.push("未校准");
  } else {
    state.correction = Number(latest.correction ?? -Number(latest.error || 0));
    if (latest.result !== "合格") state.reasons.push("校准超差");
    if (latest.validUntil && latest.validUntil < today) state.reasons.push("校准已过期");
    const traced = traceChain(db, latest.standardId, today);
    state.chain = traced;
    if (!traced.ok) state.reasons.push("溯源链断裂");
    else state.combinedUncertainty = round4(Math.hypot(Number(latest.uncertainty || 0), traced.chainUncertainty));
  }
  state.usable = state.reasons.length === 0;
  return state;
}

// 录入校准/复校结果；超差时把上次校准以来的试磨记录标为待复核并生成影响记录
function recordCalibration(db, instrument, input) {
  const result = input.result;
  if (!["合格", "超差"].includes(result)) throw new HttpError(400, "校准结果必须为 合格 或 超差");
  const error = Number(input.error);
  const uncertainty = Number(input.uncertainty);
  if (!Number.isFinite(error)) throw new HttpError(400, "示值误差必须为数字");
  if (!Number.isFinite(uncertainty) || uncertainty < 0) throw new HttpError(400, "不确定度必须为不小于0的数字");
  if (input.at && !dateRe.test(input.at)) throw new HttpError(400, "校准日期格式应为 YYYY-MM-DD");
  if (input.validUntil && !dateRe.test(input.validUntil)) throw new HttpError(400, "有效期格式应为 YYYY-MM-DD");
  const standard = findStandard(db, input.standardId);
  if (!standard) throw new HttpError(400, "标准器不存在");
  if (instrument.parameter && standard.parameter && instrument.parameter !== standard.parameter) {
    throw new HttpError(400, "标准器测量参数（" + standard.parameter + "）与仪器（" + instrument.parameter + "）不匹配");
  }
  const today = todayStr();
  const at = input.at || today;
  const validUntil = input.validUntil || addMonths(at, instrument.cycleMonths || 12);
  const traced = traceChain(db, standard.id, today);
  const calibration = {
    id: uid("CAL"),
    at,
    kind: input.kind === "复校" ? "复校" : "校准",
    result,
    error,
    correction: round4(-error),
    uncertainty,
    standardId: standard.id,
    standardCode: standard.code,
    validUntil,
    chainOk: traced.ok,
    combinedUncertainty: traced.ok ? round4(Math.hypot(uncertainty, traced.chainUncertainty)) : null
  };
  instrument.calibrations ||= [];
  instrument.calibrations.push(calibration);
  instrument.logs ||= [];
  instrument.logs.push({ at: nowIso(), step: calibration.kind, note: result + "，示值误差" + error + "，不确定度" + uncertainty + "，标准器" + standard.code + (traced.ok ? "" : "（溯源链断裂：" + traced.reason + "）") });
  let impact = null;
  let marked = 0;
  if (result === "超差") {
    // 影响窗口按校准日期定位：[上一次校准日期, 下一次校准日期)，补录旧日期时不会错误波及其余记录
    const others = instrument.calibrations.filter(c => c !== calibration);
    const earlier = others.map(c => c.at || "").filter(d => d < at).sort();
    const later = others.map(c => c.at || "").filter(d => d > at).sort();
    const since = earlier.length ? earlier[earlier.length - 1] : "";
    const until = later.length ? later[0] : "";
    const tests = [];
    eachTest(db, (item, test) => {
      if (test.instrumentId !== instrument.id && test.instrumentId !== instrument.code) return;
      if (test.reviewStatus === "已复核") return;
      if (since && (test.at || "") < since) return;
      if (until && (test.at || "") >= until) return;
      if (test.reviewStatus !== "待复核") { test.reviewStatus = "待复核"; marked += 1; }
      tests.push({ testId: test.id || null, itemId: item.id || item.code, itemCode: item.code, at: test.at, rawScore: test.rawScore ?? test.score, score: test.score });
      item.logs ||= [];
      item.logs.push({ at: nowIso(), step: "待复核", note: "仪器" + instrument.code + "校准超差，该试磨记录待复核" });
    });
    if (tests.length) {
      impact = { id: uid("IMP"), at: nowIso(), instrumentId: instrument.id, instrumentCode: instrument.code, cause: "校准超差", calibrationId: calibration.id, since: since || null, until: until || null, tests, status: "待复核" };
      db.impacts.push(impact);
      instrument.logs.push({ at: nowIso(), step: "失准", note: "校准超差，" + tests.length + "条试磨记录标为待复核" });
    }
  }
  return { calibration, impact, marked, chainOk: traced.ok, chainReason: traced.reason || null };
}

// 整锭状态由全部当前有效记录中最新一条的评分决定，不被较早记录的重算覆盖
function recomputeItemStatus(item) {
  const tests = item.tests || [];
  if (!tests.length) return;
  let latest = tests[0];
  for (const test of tests) {
    if ((test.at || "") >= (latest.at || "")) latest = test;
  }
  item.status = latest.score >= 85 ? "已试磨" : "重点观察";
}

// 复核：复校合格后按原值重算受影响试磨记录，保留前后版本
function reviewInstrument(db, instrument) {
  const today = todayStr();
  const state = instrumentState(db, instrument, today);
  if (!state.latest || state.latest.result !== "合格") throw new HttpError(409, "仪器尚未复校合格，不能复核");
  if (state.reasons.includes("校准已过期")) throw new HttpError(409, "复校证书已过期，请重新校准后再复核");
  if (state.reasons.includes("溯源链断裂")) throw new HttpError(409, "溯源链断裂，无法确认复校有效，暂缓复核");
  const correction = state.correction;
  const now = nowIso();
  const recalculated = [];
  const touchedItems = new Set();
  eachTest(db, (item, test) => {
    if (test.instrumentId !== instrument.id && test.instrumentId !== instrument.code) return;
    if (test.reviewStatus !== "待复核") return;
    const before = test.score;
    const after = clampScore((test.rawScore ?? test.score) + correction);
    test.versions ||= [{ at: test.at, score: before, correction: test.correction ?? 0, reason: "录入" }];
    test.versions.push({ at: now, score: after, correction, reason: "复核重算", previousScore: before });
    test.score = after;
    test.correction = correction;
    test.reviewStatus = "已复核";
    test.reviewedAt = now;
    touchedItems.add(item);
    item.logs ||= [];
    item.logs.push({ at: now, step: "复核", note: "仪器" + instrument.code + "复校后按原值" + (test.rawScore ?? before) + "重算：评分" + before + "→" + after, score: after });
    recalculated.push({ testId: test.id || null, itemId: item.id || item.code, itemCode: item.code, before, after });
  });
  for (const item of touchedItems) recomputeItemStatus(item);
  for (const impact of db.impacts) {
    if (impact.instrumentId === instrument.id && impact.status === "待复核") {
      impact.status = "已复核";
      impact.reviewAt = now;
    }
  }
  instrument.logs ||= [];
  instrument.logs.push({ at: now, step: "复核", note: "复核重算" + recalculated.length + "条试磨记录，修正值" + correction });
  return { recalculated: recalculated.length, tests: recalculated, correction };
}

function enrichInstrument(db, instrument, today) {
  const state = instrumentState(db, instrument, today);
  const affected = [];
  let pendingReview = 0;
  eachTest(db, (item, test) => {
    if (test.instrumentId !== instrument.id && test.instrumentId !== instrument.code) return;
    const row = {
      testId: test.id || null,
      itemId: item.id || item.code,
      itemCode: item.code,
      at: test.at,
      rawScore: test.rawScore ?? test.score,
      score: test.score,
      reviewStatus: test.reviewStatus || "正常",
      versions: (test.versions || []).map(v => ({ score: v.score, reason: v.reason }))
    };
    if (row.reviewStatus === "待复核") pendingReview += 1;
    if (row.reviewStatus !== "正常") affected.push(row);
  });
  const daysLeft = state.validUntil ? Math.ceil((Date.parse(state.validUntil) - Date.parse(today)) / 86400000) : null;
  const chain = state.chain && state.chain.chainUncertainty != null
    ? { ...state.chain, chainUncertainty: round4(state.chain.chainUncertainty) }
    : state.chain;
  return { ...instrument, ...state, chain, daysLeft, pendingReview, affected };
}

function enrichStandard(db, standard, today) {
  const traced = traceChain(db, standard.id, today);
  return {
    ...standard,
    expired: !!(standard.validUntil && standard.validUntil < today),
    chainOk: traced.ok,
    chainReason: traced.reason || null,
    chainUncertainty: traced.chainUncertainty == null ? null : round4(traced.chainUncertainty),
    chainPath: traced.chain.map(s => s.code),
    topRef: traced.topRef || standard.refName || null
  };
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>墨锭试磨室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; flex-wrap:wrap; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    [hidden] { display:none !important; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button:disabled { opacity:.55; cursor:default; }
    .tabs { display:flex; gap:8px; } .tabs button { background:#e4e9e1; color:var(--ink); } .tabs button.active { background:var(--accent); color:#fff; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; margin:2px 2px 2px 0; }
    .pill.ok { background:#e3efe0; border-color:#b9d2b3; color:#3c5c34; } .pill.bad { background:#f5e3de; border-color:#dfb7ab; color:var(--warn); }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .chain { border-left:3px solid var(--line); padding-left:10px; display:grid; gap:4px; font-size:13px; }
    .chain .arrow { color:var(--muted); padding-left:14px; }
    .btnrow { display:flex; gap:8px; flex-wrap:wrap; } .btnrow button { flex:1; min-width:96px; }
    details { border-top:1px solid var(--line); padding-top:6px; font-size:13px; overflow-x:auto; } summary { cursor:pointer; color:var(--muted); }
    table { width:100%; border-collapse:collapse; font-size:13px; margin-top:6px; } td,th { border-bottom:1px solid var(--line); padding:4px 6px; text-align:left; white-space:nowrap; }
    #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#2c332b; color:#fff; padding:10px 18px; border-radius:8px; opacity:0; transition:opacity .2s; pointer-events:none; max-width:90vw; z-index:9; }
    #toast.show { opacity:1; } #toast.error { background:var(--warn); }
    .result-box { background:#eef4ea; border:1px solid var(--line); border-radius:8px; padding:10px; font-size:13px; margin-bottom:12px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} .tabs{margin:12px 0;} .tabs button{flex:1;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>墨锭试磨室</h1><div class="meta">墨锭建档、试磨记录、评分统计与仪器校准溯源</div></div>
    <nav class="tabs"><button data-tab="grinding" class="active">试磨管理</button><button data-tab="calibration">仪器校准</button></nav>
    <button id="reload">刷新</button>
  </header>
  <main id="tab-grinding">
    <section>
      <form id="createForm"><h2>新增墨锭</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存墨锭</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>创建试磨记录</h2><label>选择墨锭</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><label>所用仪器（超差、过期或溯源链断裂的仪器不可用于试磨结论）</label><select name="instrumentId" id="testInstrument"></select><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>选择墨锭后录入试磨记录，系统会保留多次试磨结果并更新评分状态。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <main id="tab-calibration" hidden>
    <section>
      <form id="instrumentForm"><h2>新增仪器</h2><label>仪器编号</label><input name="code" required><label>名称</label><input name="name" required><label>测量参数</label><input name="parameter" placeholder="如：质量 / 长度"><label>量程</label><input name="range"><label>校准周期（月）</label><input name="cycleMonths" type="number" min="1" value="12"><button>保存仪器</button></form>
      <form id="standardForm" style="margin-top:14px"><h2>新增标准器</h2><label>标准器编号</label><input name="code" required><label>名称</label><input name="name" required><label>测量参数</label><input name="parameter"><label>不确定度 U</label><input name="uncertainty" type="number" step="any" min="0" required><label>证书编号</label><input name="certificateNo"><label>证书有效期至</label><input name="validUntil" type="date"><label>上级标准器</label><select name="parentId" id="stdParent"></select><label>上级基准名称（无上级标准器时必填）</label><input name="refName" placeholder="如：省计量院质量基准"><label>上级基准不确定度</label><input name="refUncertainty" type="number" step="any" min="0"><button>保存标准器</button></form>
      <form id="calibrationForm" style="margin-top:14px"><h2>录入校准 / 复校</h2><label>仪器</label><select name="instrumentId" id="calInstrument"></select><label>类型</label><select name="kind" id="calKind"><option>校准</option><option>复校</option></select><label>校准日期</label><input name="at" id="calAt" type="date"><label>校准结果</label><select name="result"><option>合格</option><option>超差</option></select><label>示值误差（修正值 = -误差）</label><input name="error" type="number" step="any" required><label>校准不确定度 U</label><input name="uncertainty" type="number" step="any" min="0" required><label>所用标准器</label><select name="standardId" id="calStandard"></select><label>有效期至（留空按周期推算）</label><input name="validUntil" id="calValidUntil" type="date"><button>提交校准结果</button></form>
    </section>
    <section>
      <div class="stats" id="calStats"></div>
      <div id="calResult"></div>
      <div class="panel"><h2>仪器（有效期、合成不确定度、溯源链与受影响记录）</h2><div class="grid" id="instrumentCards"></div></div>
      <div class="panel" style="margin-top:14px"><h2>标准器与溯源链</h2><div class="grid" id="standardCards"></div></div>
    </section>
  </main>
  <div id="toast"></div>
  <script>
    const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
    const stages = ["待试磨","已试磨","重点观察"];
    const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"]];
    const $ = s => document.querySelector(s);
    let items = [], instruments = [], standards = [];
    const formKeys = {};
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
    function toast(msg, isError) {
      const el = $('#toast');
      el.textContent = msg;
      el.className = 'show' + (isError ? ' error' : '');
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.className = ''; }, 3600);
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.error || '请求失败'); err.data = data; throw err; }
      return data;
    }
    function keyFor(name) {
      if (!formKeys[name]) formKeys[name] = Date.now().toString(36) + Math.random().toString(36).slice(2);
      return formKeys[name];
    }
    async function postJson(path, body, keyName) {
      const headers = { 'Content-Type': 'application/json' };
      if (keyName) headers['Idempotency-Key'] = keyFor(keyName);
      const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.error || '请求失败'); err.data = data; throw err; }
      if (keyName) delete formKeys[keyName];
      if (data.deduplicated) toast('重复请求已忽略，返回首次处理结果');
      return data;
    }
    function renderForms() {
      $('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      $('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'"'+(key==='score'?' type="number"':'')+'>').join('');
    }
    function render() {
      const itemSelect = $('#itemSelect');
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+esc(item.code || item.id)+' · '+esc(item.smokeSource || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      $('#stats').innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = $('#statusFilter').value;
      const q = $('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      $('#cards').innerHTML = visible.map(cardHtml).join('') || '<div class="meta">暂无墨锭</div>';
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { try { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); } catch (e) { toast(e.message, true); } });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const note = prompt('记录备注'); if (note) { try { await api('/api/items/'+btn.dataset.note+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } catch (e) { toast(e.message, true); } } });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+esc(item[key] ?? '')+'</div>').join('');
      const pending = (item.tests || []).filter(t => t.reviewStatus === '待复核').length;
      const tests = (item.tests || []).slice(-3).map(t => '<div class="meta">试磨 '+String(t.at).slice(0,10)+' · 评分'+t.score+(t.rawScore != null && t.rawScore !== t.score ? '（原值'+t.rawScore+'）' : '')+(t.reviewStatus === '待复核' ? ' · <span class="warn">待复核</span>' : (t.reviewStatus === '已复核' ? ' · 已复核' : ''))+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+esc(l.step)+'：'+esc(l.note)+'</div>').join('');
      return '<article class="card"><h3>'+esc(item.code || item.id)+'</h3><div><span class="pill">'+esc(item.status)+'</span>'+(pending ? '<span class="pill bad">待复核 '+pending+'</span>' : '')+'</div>'+main+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button>'+tests+'<div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function reasonPills(ins) {
      if (ins.usable) return '<span class="pill ok">可用于试磨结论</span>';
      return ins.reasons.map(r => '<span class="pill bad">'+esc(r)+'</span>').join('');
    }
    function chainHtml(ins) {
      if (!ins.latest) return '<div class="meta">尚未校准，无溯源链</div>';
      const chain = (ins.chain && ins.chain.chain) || [];
      if (!chain.length) return '<div class="meta">无溯源链信息</div>';
      let out = chain.map((s, i) => {
        const valid = s.validUntil ? (s.expired ? ' · 证书已过期' : ' · 有效期至'+s.validUntil) : '';
        return (i ? '<div class="arrow">↑ 溯源</div>' : '') + '<div><b>'+esc(s.code)+'</b> '+esc(s.name)+' <span class="meta">U=±'+(s.uncertainty ?? '—')+valid+'</span></div>';
      }).join('');
      const top = chain[chain.length-1];
      if (ins.chain.ok && top.refName) out += '<div class="arrow">↑ 溯源</div><div><b>基准</b> '+esc(top.refName)+(top.refUncertainty ? ' <span class="meta">U=±'+top.refUncertainty+'</span>' : '')+'</div>';
      const label = ins.chain.ok ? '溯源链有效 · 链上合成 U=±'+ins.chain.chainUncertainty : '溯源链断裂：'+ins.chain.reason;
      return '<div class="chain">'+out+'</div><div><span class="pill '+(ins.chain.ok ? 'ok' : 'bad')+'">'+esc(label)+'</span></div>';
    }
    function instrumentCard(ins) {
      const status = '<span class="pill">'+esc(ins.status || '在用')+'</span>' + reasonPills(ins);
      const valid = ins.validUntil ? ('有效期至 '+ins.validUntil+(ins.daysLeft != null ? (ins.daysLeft >= 0 ? '（剩余 '+ins.daysLeft+' 天）' : '（已过期 '+(-ins.daysLeft)+' 天）') : '')) : '未校准，无有效期';
      const u = ins.combinedUncertainty != null ? '合成不确定度 U=±'+ins.combinedUncertainty : '合成不确定度：无法合成（溯源链断裂或未校准）';
      const latest = ins.latest ? ('最近'+(ins.latest.kind || '校准')+'：'+ins.latest.at+' · '+ins.latest.result+' · 误差'+ins.latest.error+' · 修正值'+ins.latest.correction) : '暂无校准记录';
      const affected = ins.affected.length
        ? '<details><summary>受影响试磨记录 '+ins.affected.length+' 条（待复核 '+ins.pendingReview+'）</summary><table><tr><th>墨锭</th><th>日期</th><th>原值</th><th>现评分</th><th>状态</th><th>版本变迁</th></tr>'+ins.affected.map(t => '<tr><td>'+esc(t.itemCode)+'</td><td>'+esc(String(t.at).slice(0,10))+'</td><td>'+t.rawScore+'</td><td>'+t.score+'</td><td>'+esc(t.reviewStatus)+'</td><td class="meta">'+(t.versions || []).map(v => v.score).join(' → ')+'</td></tr>').join('')+'</table></details>'
        : '<div class="meta">暂无受影响试磨记录</div>';
      const history = (ins.calibrations || []).length
        ? '<details><summary>校准历史 '+ins.calibrations.length+' 次</summary>'+ins.calibrations.map(c => '<div class="meta">'+c.at+' · '+(c.kind || '校准')+' · '+c.result+' · 误差'+c.error+' · U=±'+c.uncertainty+(c.combinedUncertainty != null ? ' · 合成U=±'+c.combinedUncertainty : '')+' · 标准器'+esc(c.standardCode || '')+' · 有效期至'+c.validUntil+'</div>').join('')+'</details>'
        : '';
      return '<article class="card"><h3>'+esc(ins.code)+' · '+esc(ins.name)+'</h3><div>'+status+'</div>'
        + '<div class="meta">测量参数 '+esc(ins.parameter || '—')+' · 量程 '+esc(ins.range || '—')+' · 校准周期 '+ins.cycleMonths+' 个月</div>'
        + '<div><b>'+valid+'</b></div><div>'+u+'</div><div class="meta">'+latest+'</div>'
        + chainHtml(ins) + affected + history
        + '<div class="btnrow"><button data-cal="'+ins.id+'">录入校准</button><button class="secondary" data-toggle="'+ins.id+'">'+(ins.status === '停用' ? '启用' : '停用')+'</button><button class="secondary" data-review="'+ins.id+'">复核重算('+ins.pendingReview+')</button></div></article>';
    }
    function standardCard(s) {
      const chain = s.chainOk ? '<span class="pill ok">溯源链有效 · 链上合成 U=±'+s.chainUncertainty+'</span>' : '<span class="pill bad">溯源链断裂：'+esc(s.chainReason)+'</span>';
      const parent = s.parentId ? '上级标准器：'+esc(((standards.find(x => x.id === s.parentId) || {}).code) || s.parentId) : '上级基准：'+esc(s.refName || '—');
      const valid = s.validUntil ? (s.expired ? '<span class="warn">证书已过期（'+s.validUntil+'）</span>' : '证书有效期至 '+s.validUntil) : '未登记证书有效期';
      return '<article class="card"><h3>'+esc(s.code)+' · '+esc(s.name)+'</h3>'
        + '<div class="meta">测量参数 '+esc(s.parameter || '—')+' · 不确定度 U=±'+s.uncertainty+' · 证书 '+esc(s.certificateNo || '—')+'</div>'
        + '<div>'+valid+'</div><div class="meta">'+parent+'</div>'
        + '<div class="meta">溯源路径：'+esc(s.chainPath.join(' → '))+(s.topRef && s.chainOk ? ' → '+esc(s.topRef) : '')+'</div>'
        + '<div>'+chain+'</div></article>';
    }
    function renderCalStats() {
      const usable = instruments.filter(i => i.usable).length;
      const stopped = instruments.filter(i => i.status === '停用').length;
      const pending = instruments.reduce((n, i) => n + i.pendingReview, 0);
      $('#calStats').innerHTML = [['仪器总数', instruments.length], ['可用于试磨', usable], ['停用', stopped], ['待复核记录', pending]].map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
    }
    function renderInstruments() {
      $('#instrumentCards').innerHTML = instruments.map(instrumentCard).join('') || '<div class="meta">暂无仪器，请先登记</div>';
      document.querySelectorAll('[data-cal]').forEach(b => b.onclick = () => {
        $('#calInstrument').value = b.dataset.cal;
        const ins = instruments.find(i => i.id === b.dataset.cal);
        $('#calKind').value = ins && ins.latest && ins.latest.result === '超差' ? '复校' : '校准';
        updateValidUntil();
        $('#calibrationForm').scrollIntoView({ behavior: 'smooth' });
      });
      document.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => toggleInstrument(b.dataset.toggle, b.textContent.trim() === '停用' ? 'deactivate' : 'activate', b));
      document.querySelectorAll('[data-review]').forEach(b => b.onclick = () => doReview(b.dataset.review, b));
    }
    function renderStandards() {
      $('#standardCards').innerHTML = standards.map(standardCard).join('') || '<div class="meta">暂无标准器，请先登记</div>';
    }
    function fillSelects() {
      $('#calInstrument').innerHTML = instruments.map(i => '<option value="'+i.id+'">'+esc(i.code)+' · '+esc(i.name)+'</option>').join('');
      $('#calStandard').innerHTML = standards.map(s => '<option value="'+s.id+'">'+esc(s.code)+' · '+esc(s.name)+(s.chainOk ? '（链有效）' : '（链断裂）')+'</option>').join('');
      $('#stdParent').innerHTML = '<option value="">无 — 直接追溯上级基准</option>' + standards.map(s => '<option value="'+s.id+'">'+esc(s.code)+' · '+esc(s.name)+'</option>').join('');
      const testSel = $('#testInstrument');
      const cur = testSel.value;
      testSel.innerHTML = '<option value="">不使用仪器</option>' + instruments.map(i => i.usable
        ? '<option value="'+i.id+'">'+esc(i.code)+' · '+esc(i.name)+'（U=±'+i.combinedUncertainty+'）</option>'
        : '<option disabled>'+esc(i.code)+' · '+esc(i.name)+'（不可用：'+i.reasons.join('、')+'）</option>').join('');
      testSel.value = cur;
    }
    function addMonthsStr(dateStr, months) {
      const d = new Date(dateStr + 'T00:00:00');
      if (isNaN(d)) return '';
      d.setMonth(d.getMonth() + Number(months || 0));
      return d.toISOString().slice(0, 10);
    }
    function updateValidUntil() {
      const ins = instruments.find(i => i.id === $('#calInstrument').value);
      const at = $('#calAt').value;
      $('#calValidUntil').placeholder = ins && at ? '默认 ' + addMonthsStr(at, ins.cycleMonths) : '留空按周期推算';
    }
    function setCalDefaults() {
      $('#calAt').value = new Date().toISOString().slice(0, 10);
      updateValidUntil();
    }
    async function toggleInstrument(id, action, btn) {
      btn.disabled = true;
      try {
        const data = await postJson('/api/instruments/' + id + '/' + action, {}, 'toggle-' + action + '-' + id);
        toast(data.already ? '仪器已处于该状态，未重复操作' : '操作成功');
        await load();
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    }
    async function doReview(id, btn) {
      btn.disabled = true;
      try {
        const data = await postJson('/api/instruments/' + id + '/review', {}, 'review-' + id);
        const lines = (data.tests || []).map(t => esc(t.itemCode) + '：' + t.before + ' → ' + t.after);
        $('#calResult').innerHTML = '<div class="result-box"><b>复核完成</b>：按原值重算 '+data.recalculated+' 条试磨记录（修正值 '+data.correction+'）'+(lines.length ? '<br>'+lines.join('<br>') : '')+'</div>';
        toast('复核完成，重算 '+data.recalculated+' 条记录');
        await load();
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    }
    async function load() {
      const results = await Promise.all([api('/api/items'), api('/api/instruments'), api('/api/standards')]);
      items = results[0]; instruments = results[1]; standards = results[2];
      render();
      renderCalStats();
      renderInstruments();
      renderStandards();
      fillSelects();
      updateValidUntil();
    }
    function switchTab(name) {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
      $('#tab-grinding').hidden = name !== 'grinding';
      $('#tab-calibration').hidden = name !== 'calibration';
      localStorage.setItem('ink-tab', name);
    }
    document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
    $('#createForm').onsubmit = async event => {
      event.preventDefault();
      try { await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target).entries())) }); event.target.reset(); await load(); } catch (e) { toast(e.message, true); }
    };
    $('#actionForm').onsubmit = async event => {
      event.preventDefault();
      try {
        await api('/api/items/'+$('#itemSelect').value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target).entries())) });
        event.target.reset();
        await load();
      } catch (e) {
        toast(e.data && e.data.reasons ? '仪器不可用于试磨结论：'+e.data.reasons.join('、') : e.message, true);
      }
    };
    $('#instrumentForm').onsubmit = async event => {
      event.preventDefault();
      try { await postJson('/api/instruments', Object.fromEntries(new FormData(event.target).entries()), 'instrument'); event.target.reset(); event.target.cycleMonths.value = 12; toast('仪器已登记'); await load(); } catch (e) { toast(e.message, true); }
    };
    $('#standardForm').onsubmit = async event => {
      event.preventDefault();
      try { await postJson('/api/standards', Object.fromEntries(new FormData(event.target).entries()), 'standard'); event.target.reset(); toast('标准器已登记'); await load(); } catch (e) { toast(e.message, true); }
    };
    $('#calibrationForm').onsubmit = async event => {
      event.preventDefault();
      const fd = Object.fromEntries(new FormData(event.target).entries());
      if (!fd.validUntil) delete fd.validUntil;
      if (!fd.at) delete fd.at;
      try {
        const data = await postJson('/api/instruments/' + fd.instrumentId + '/calibrations', fd, 'calibration');
        toast(data.calibration.result === '超差' ? '校准超差，已标记 '+data.marked+' 条试磨记录待复核' : '校准结果已录入');
        event.target.reset();
        setCalDefaults();
        await load();
      } catch (e) { toast(e.message, true); }
    };
    $('#calInstrument').onchange = updateValidUntil;
    $('#calAt').onchange = updateValidUntil;
    $('#statusFilter').onchange = render;
    $('#search').oninput = render;
    $('#reload').onclick = () => load().catch(e => toast(e.message, true));
    renderForms();
    setCalDefaults();
    if (localStorage.getItem('ink-tab') === 'calibration') switchTab('calibration');
    load().catch(e => toast(e.message, true));
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    if (req.method === "GET" && path === "/") return html(res, page());
    if (req.method === "GET" && path === "/api/items") { const db = await loadDb(); return send(res, 200, db.items.map(summarize)); }
    if (req.method === "GET" && path === "/api/stats") { const db = await loadDb(); return send(res, 200, computeStats(db.items)); }
    if (req.method === "GET" && path === "/api/instruments") { const db = await loadDb(); const today = todayStr(); return send(res, 200, db.instruments.map(i => enrichInstrument(db, i, today))); }
    if (req.method === "GET" && path === "/api/standards") { const db = await loadDb(); const today = todayStr(); return send(res, 200, db.standards.map(s => enrichStandard(db, s, today))); }
    if (req.method === "GET" && path === "/api/impacts") { const db = await loadDb(); return send(res, 200, db.impacts); }

    if (req.method === "POST" && path === "/api/items") {
      const input = await body(req);
      return mutate(req, res, async db => {
        const item = { id: uid("IS"), ...input, logs: [{ at: nowIso(), step: "建档", note: "创建墨锭" }] };
        db.items.unshift(item);
        return { status: 201, body: item };
      });
    }
    const patch = path.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const input = await body(req);
      return mutate(req, res, async db => {
        const item = findItem(db, patch[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        Object.assign(item, input);
        item.logs ||= [];
        item.logs.push({ at: nowIso(), step: "状态", note: "更新为" + item.status });
        return { status: 200, body: item };
      });
    }
    const log = path.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const input = await body(req);
      return mutate(req, res, async db => {
        const item = findItem(db, log[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        item.logs ||= [];
        item.logs.push({ at: nowIso(), step: input.step || "记录", note: input.note || "" });
        return { status: 201, body: item };
      });
    }
    const action = path.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const input = await body(req);
      return mutate(req, res, async db => {
        const item = findItem(db, action[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        const score = Number(input.score || 0);
        const now = nowIso();
        const test = { id: uid("TST"), at: now, paper: input.paper || "", water: input.water || "", speed: input.speed || "", colorLayer: input.colorLayer || "", sediment: input.sediment || "", instrumentId: input.instrumentId || "" };
        item.logs ||= [];
        item.tests ||= [];
        if (test.instrumentId) {
          const instrument = findInstrument(db, test.instrumentId);
          if (!instrument) throw new HttpError(404, "instrument_not_found");
          const state = instrumentState(db, instrument, todayStr());
          if (!state.usable) throw new HttpError(409, "仪器不可用于试磨结论", { reasons: state.reasons });
          test.rawScore = score;
          test.correction = state.correction;
          test.score = clampScore(score + state.correction);
          test.reviewStatus = "正常";
          test.versions = [{ at: now, score: test.score, correction: state.correction, reason: "录入" }];
          item.logs.push({ at: now, step: "试磨", note: (input.paper || "试纸") + "，评分" + test.score + "（原值" + score + "，仪器" + instrument.code + "修正" + state.correction + "）", score: test.score });
        } else {
          test.score = score;
          test.rawScore = score;
          test.reviewStatus = "正常";
          test.versions = [{ at: now, score, correction: 0, reason: "录入" }];
          item.logs.push({ at: now, step: "试磨", note: (input.paper || "试纸") + "，评分" + score, score });
        }
        item.tests.push(test);
        recomputeItemStatus(item);
        return { status: 201, body: item };
      });
    }

    if (req.method === "POST" && path === "/api/instruments") {
      const input = await body(req);
      return mutate(req, res, async db => {
        if (!input.code || !input.name) throw new HttpError(400, "仪器编号和名称必填");
        if (db.instruments.some(x => x.code === input.code)) throw new HttpError(409, "仪器编号已存在");
        const cycleMonths = Number(input.cycleMonths || 12);
        if (!Number.isFinite(cycleMonths) || cycleMonths <= 0) throw new HttpError(400, "校准周期必须为大于0的月数");
        const instrument = { id: uid("INS"), code: input.code, name: input.name, parameter: input.parameter || "", range: input.range || "", cycleMonths, status: "在用", calibrations: [], logs: [{ at: nowIso(), step: "建档", note: "登记仪器" }] };
        db.instruments.push(instrument);
        return { status: 201, body: instrument };
      });
    }
    if (req.method === "POST" && path === "/api/standards") {
      const input = await body(req);
      return mutate(req, res, async db => {
        if (!input.code || !input.name) throw new HttpError(400, "标准器编号和名称必填");
        if (db.standards.some(x => x.code === input.code)) throw new HttpError(409, "标准器编号已存在");
        const uncertainty = Number(input.uncertainty);
        if (!Number.isFinite(uncertainty) || uncertainty < 0) throw new HttpError(400, "不确定度必须为不小于0的数字");
        let parent = null;
        if (input.parentId) {
          parent = findStandard(db, input.parentId);
          if (!parent) throw new HttpError(400, "上级标准器不存在");
          if (parent.code === input.code) throw new HttpError(400, "上级标准器不能是自身");
        }
        if (!parent && !input.refName) throw new HttpError(400, "标准器必须能追溯到上级基准：请选择上级标准器或填写上级基准名称");
        const standard = { id: uid("STD"), code: input.code, name: input.name, parameter: input.parameter || "", uncertainty, parentId: parent ? parent.id : null, refName: parent ? "" : (input.refName || ""), refUncertainty: parent ? 0 : Number(input.refUncertainty || 0), validUntil: input.validUntil || "", certificateNo: input.certificateNo || "" };
        db.standards.push(standard);
        return { status: 201, body: standard };
      });
    }
    const cal = path.match(/^\/api\/instruments\/([^/]+)\/calibrations$/);
    if (cal && req.method === "POST") {
      const input = await body(req);
      return mutate(req, res, async db => {
        const instrument = findInstrument(db, cal[1]);
        if (!instrument) throw new HttpError(404, "instrument_not_found");
        const outcome = recordCalibration(db, instrument, input);
        return { status: 201, body: outcome };
      });
    }
    const toggle = path.match(/^\/api\/instruments\/([^/]+)\/(deactivate|activate)$/);
    if (toggle && req.method === "POST") {
      const input = await body(req);
      return mutate(req, res, async db => {
        const instrument = findInstrument(db, toggle[1]);
        if (!instrument) throw new HttpError(404, "instrument_not_found");
        const target = toggle[2] === "deactivate" ? "停用" : "在用";
        if (instrument.status === target) return { status: 200, body: { ok: true, already: true, status: target } };
        instrument.status = target;
        instrument.logs ||= [];
        instrument.logs.push({ at: nowIso(), step: toggle[2] === "deactivate" ? "停用" : "启用", note: (input && input.reason) || (toggle[2] === "deactivate" ? "仪器停用" : "仪器重新启用") });
        return { status: 200, body: { ok: true, already: false, status: target } };
      });
    }
    const review = path.match(/^\/api\/instruments\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      return mutate(req, res, async db => {
        const instrument = findInstrument(db, review[1]);
        if (!instrument) throw new HttpError(404, "instrument_not_found");
        const outcome = reviewInstrument(db, instrument);
        return { status: 200, body: { ok: true, ...outcome } };
      });
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    if (!res.headersSent) send(res, 500, { error: error.message });
    else console.error(error);
  }
});
server.listen(port, () => console.log("墨锭试磨室 listening on http://localhost:" + port));
