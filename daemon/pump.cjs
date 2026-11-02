/* ZCode Token 用量状态条 — 主进程泵。
 * 由 asar 注入行动态 import（本文件必须在 asar 之外，路径稳定）。
 * 职责：
 *   1) 向每个聊天窗口注入 bar.js（executeJavaScript；mtime 变化自动热重载）
 *   2) 监听 db 目录写入（fs.watch + 心跳；去抖 300ms、限频 1500ms），
 *      触发时 spawn python 统计引擎（一次性短进程），把快照按窗口推送：
 *      每个窗口带 mine（本窗焦点会话 id，旁听客户端自带 IPC 通道
 *      zcode:sync-active-task-session）
 *   3) 诊断：~/.zcode/ztu-statusbar/{pump.log,diag.json}——GUI 进程的
 *      console.error 不可见，排障必须落盘。
 *   4) 任何失败只记日志，绝不影响宿主。
 * 协议：渲染端 window.__ztuUpdate(payload)。 */
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const { app, webContents, ipcMain } = require("electron");
const HERE = __dirname;
const BAR = path.join(HERE, "bar.js");
const CONFIG = path.join(HERE, "config.json");
const LOGFILE = path.join(HERE, "pump.log");
const DIAG = path.join(HERE, "diag.json");

/* ---------- 诊断落盘 ---------- */
const diag = {
  bootAt: new Date().toISOString(),
  version: 3,
  pulls: 0, engineOk: 0, engineErr: 0,
  lastEngineError: "", lastSids: [], windows: {}, rendererDiag: null,
};
function logWrite(msg) {
  try {
    let cur = "";
    try { cur = fs.readFileSync(LOGFILE, "utf8"); } catch (e) { }
    if (cur.length > 65536) cur = cur.slice(-32768);   // 超限砍半，防无限膨胀
    fs.writeFileSync(LOGFILE,
      cur + "[" + new Date().toISOString() + "] " + msg + "\n", "utf8");
  } catch (e) { }
}
function diagFlush() {
  try {
    diag.windows = {};
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      let url = "";
      try { url = String(wc.getURL() || "").slice(0, 120); } catch (e) { }
      diag.windows[wc.id] = { type: wc.getType(), url, attached: !!wc.__ztuAttached };
    }
    fs.writeFileSync(DIAG, JSON.stringify(diag, null, 1), "utf8");
  } catch (e) { logWrite("diag flush failed: " + e.message); }
}
function LOG(...a) {
  const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  logWrite(s);
  console.error("[ztu]", s);
}

/* ---------- 配置 ---------- */
function readCfg() {
  const c = {};
  try { Object.assign(c, JSON.parse(fs.readFileSync(CONFIG, "utf8"))); } catch (e) { }
  c.debounce_ms = Math.max(50, c.debounce_ms | 0 || 300);
  c.rate_ms = Math.max(200, c.rate_ms | 0 || 1500);
  c.heartbeat_ms = Math.max(5000, c.heartbeat_ms | 0 || 30000);
  c.engine = path.join(HERE, "usage_engine.py");
  return c;
}
const cfg = readCfg();

let pythonCmd = null;   // 启动时探测，见 resolvePython()
let pythonExtraArgs = [];

function resolvePython() {
  if (cfg.python_path) {
    pythonCmd = cfg.python_path;
    LOG("python from config:", pythonCmd);
    diagFlush();
    return;
  }
  const cands = process.platform === "win32"
    ? [["python", []], ["py", ["-3"]]]
    : [["python3", []], ["python", []]];
  let i = 0;
  (function next() {
    if (i >= cands.length) {
      LOG("no python found; engine disabled (set python_path in config.json)");
      diagFlush();
      return;
    }
    const [cmd, extra] = cands[i++];
    execFile(cmd, extra.concat(["--version"]), { timeout: 8000, windowsHide: true },
      (err) => {
        if (!err) {
          pythonCmd = cmd; pythonExtraArgs = extra;
          LOG("python resolved:", cmd, extra.join(" "));
          diagFlush();
        } else next();
      });
  })();
}

/* ---------- db 目录监听 ---------- */
function dbDir() {
  return path.join(app.getPath("home"), ".zcode", "cli", "db");
}
function dbStamp() {
  let m = 0;
  const dir = dbDir();
  for (const f of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) {
    try { m = Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs); } catch (e) { }
  }
  return m;
}

let watcher = null;
let lastStamp = 0;
let lastSpawn = 0;
let debounceTimer = null;
let catchupTimer = null;
let inFlight = false;
let pendingSince = 0;

function onDbActivity() {
  const stamp = dbStamp();
  if (stamp === lastStamp) return;
  lastStamp = stamp;
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    tryPull();
  }, cfg.debounce_ms);
}

function startWatch() {
  try {
    const dir = dbDir();
    if (!fs.existsSync(dir)) { LOG("db dir missing:", dir); return; }
    lastStamp = dbStamp();
    watcher = fs.watch(dir, { persistent: false }, () => {
      try { onDbActivity(); } catch (e) { }
    });
    watcher.on("error", (e) => LOG("watch error:", e.message));
    LOG("watching", dir);
  } catch (e) {
    LOG("watch setup failed:", e.message);
  }
  // 心跳：fs.watch 事件不保证送达（Node 官方文档），兜底防漏
  setInterval(() => {
    try { onDbActivity(); } catch (e) { }
  }, cfg.heartbeat_ms);
  // 轻量定时：热重载检查 + 心跳兜底之外的补拉检查
  setInterval(() => {
    try {
      hotReloadIfChanged();
      const stamp = dbStamp();
      if (stamp !== lastStamp) onDbActivity();
      else if (pendingSince && Date.now() - lastSpawn >= cfg.rate_ms) tryPull();
    } catch (e) { }
  }, 2000);
}

/* ---------- 查询（一次性短进程） ---------- */
const IPC_ACTIVE_SID = "zcode:sync-active-task-session";
const activeSid = new Map();   // webContents.id → 会话 id

function wantedSids() {
  const sids = [];
  for (const v of activeSid.values()) {
    if (v && sids.indexOf(v) < 0) sids.push(v);
  }
  return sids;
}

function tryPull() {
  if (inFlight) { pendingSince = Date.now(); return; }
  if (!pythonCmd) { pendingSince = Date.now(); return; }
  const now = Date.now();
  if (now - lastSpawn < cfg.rate_ms) {
    pendingSince = pendingSince || now;
    if (!catchupTimer) {
      catchupTimer = setTimeout(() => {
        catchupTimer = null;
        tryPull();
      }, cfg.rate_ms - (now - lastSpawn) + 20);
    }
    return;
  }
  lastSpawn = now;
  pendingSince = 0;
  const sids = wantedSids();
  diag.lastSids = sids;
  let py;
  try {
    const args = pythonExtraArgs.concat([
      cfg.engine, "--format", "json", "--sids", JSON.stringify(sids)]);
    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
    py = spawn(pythonCmd, args, { windowsHide: true, env: env });
  } catch (e) {
    diag.engineErr++;
    diag.lastEngineError = e.message;
    LOG("spawn failed:", e.message);
    diagFlush();
    return;
  }
  inFlight = true;
  let out = "", err = "";
  const timer = setTimeout(() => { try { py.kill(); } catch (e) { } }, 15000);
  py.stdout.on("data", (d) => { out += d; });
  py.stderr.on("data", (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
  py.on("error", (e) => {
    clearTimeout(timer); inFlight = false;
    diag.engineErr++; diag.lastEngineError = e.message;
    LOG("engine error:", e.message);
    diagFlush();
  });
  py.on("close", (code) => {
    clearTimeout(timer); inFlight = false;
    diag.pulls++;
    if (code !== 0) {
      diag.engineErr++; diag.lastEngineError = "exit " + code + ": " + err.slice(0, 300);
      LOG("engine exit", code, err.slice(0, 400));
      diagFlush();
      return;
    }
    let snap;
    try { snap = JSON.parse(out); } catch (e) {
      diag.engineErr++; diag.lastEngineError = "parse: " + e.message;
      LOG("engine output parse failed:", e.message, "head:", out.slice(0, 200));
      diagFlush();
      return;
    }
    diag.engineOk++;
    payload = snap;
    pushAll(snap);
    diagFlush();
    if (pendingSince && Date.now() - lastSpawn >= cfg.rate_ms) {
      pendingSince = 0;
      tryPull();   // 限频窗口到点，补拉搁置期间的最新状态
    }
  });
}

/* ---------- 推送 ---------- */
const INJECTABLE_TYPES = new Set(["window", "browserView", "webview"]);
function isChatPage(wc) {
  try {
    if (wc.isDestroyed()) return false;
    if (!INJECTABLE_TYPES.has(wc.getType())) return false;
    const url = wc.getURL() || "";
    if (/^(devtools|chrome|about):/.test(url)) return false;
    return true;
  } catch (e) { return false; }
}
function pushAll(snap) {
  for (const wc of webContents.getAllWebContents()) {
    if (!isChatPage(wc)) continue;
    pushOnce(wc, snap);
  }
}
function pushOnce(wc, snap) {
  try {
    const obj = Object.assign({}, snap);
    if (activeSid.has(wc.id)) obj.mine = activeSid.get(wc.id) || "";
    const js = "window.__ztuUpdate && window.__ztuUpdate(" +
      JSON.stringify(obj).replace(/[\u2028\u2029]/g,
        (c) => (c === "\u2028" ? "\\u2028" : "\\u2029")) + ")";
    wc.executeJavaScript(js, true).then(() => {
      diag.windows[wc.id] = Object.assign(diag.windows[wc.id] || {}, { lastPushAt: Date.now() });
    }).catch((e) => {
      diag.windows[wc.id] = Object.assign(diag.windows[wc.id] || {}, { pushErr: String(e && e.message || e) });
    });
  } catch (e) { }
}

/* ---------- 渲染脚本注入 + 热重载 ---------- */
let barSrc = "";
let barMtime = 0;
function loadBar() {
  try {
    barMtime = fs.statSync(BAR).mtimeMs;
    const src = fs.readFileSync(BAR, "utf8");
    new Function(src);   // 语法校验，防止载入写了一半的文件
    barSrc = src;
    return true;
  } catch (e) {
    LOG("bar.js load failed:", e.message);
    return false;
  }
}
function fetchRendererDiag(wc) {
  wc.executeJavaScript("JSON.stringify(window.__ztuDiag||null)", true)
    .then((s) => {
      try { diag.rendererDiag = JSON.parse(s); } catch (e) { diag.rendererDiag = s; }
      diagFlush();
    }).catch(() => { });
}
function injectOverlay(wc, force) {
  if (!isChatPage(wc) || !barSrc) return;
  wc.executeJavaScript("typeof window.__ztuGen==='number' && window.__ztuGen>0 ? 1 : 0", true)
    .then((has) => {
      if (!force && has === 1) {
        if (payload) pushOnce(wc, payload);
        return null;
      }
      return wc.executeJavaScript(barSrc, true).then(() => {
        LOG("bar injected into wc#" + wc.id);
        if (payload) pushOnce(wc, payload);
        setTimeout(() => fetchRendererDiag(wc), 800);
      });
    })
    .catch((e) => {
      diag.windows[wc.id] = Object.assign(diag.windows[wc.id] || {}, { injectErr: String(e && e.message || e) });
      LOG("inject failed wc#" + wc.id + ":", e && e.message);
    });
}
let hotCheck = 0;
function hotReloadIfChanged() {
  if (Date.now() - hotCheck < 2000) return;
  hotCheck = Date.now();
  let m = 0;
  try { m = fs.statSync(BAR).mtimeMs; } catch (e) { return; }
  if (m === barMtime) return;
  if (!loadBar()) return;   // 语法没写完：保留旧 mtime，下轮重试
  LOG("bar.js changed, hot-reloading");
  for (const wc of webContents.getAllWebContents()) injectOverlay(wc, true);
}

/* ---------- IPC 旁听（每窗口焦点会话） ---------- */
function trustedSender(e) {
  try {
    return e && e.sender && !e.sender.isDestroyed() && isChatPage(e.sender);
  } catch (e2) { return false; }
}
try {
  ipcMain.on(IPC_ACTIVE_SID, (e, sid) => {
    if (!trustedSender(e)) return;
    const s = typeof sid === "string" ? sid.trim() : "";
    const val = s && s.length <= 255 && /^[A-Za-z0-9_-]+$/.test(s) ? s : "";
    const prev = activeSid.get(e.sender.id);
    activeSid.set(e.sender.id, val);
    if (prev !== val) setTimeout(() => tryPull(), 300);
  });
} catch (e) { LOG("ipc hook failed:", e.message); }

/* ---------- 窗口生命周期 ---------- */
let payload = null;
function attachWc(wc, immediate) {
  if (!isChatPage(wc)) return;
  if (wc.__ztuAttached) return;
  wc.__ztuAttached = true;
  if (immediate) injectOverlay(wc, false);   // 已存在的窗口：页面已加载，可立即注入
  // 新建窗口：创建时页面尚未加载，executeJavaScript 会失败，等 did-finish-load
  wc.on("did-finish-load", () => injectOverlay(wc, false));
  wc.on("destroyed", () => activeSid.delete(wc.id));
}
function attachAll() {
  for (const wc of webContents.getAllWebContents()) attachWc(wc, true);
}

function start() {
  resolvePython();
  if (!loadBar()) return;
  attachAll();
  // Electron 44：webContents.on('web-contents-created') 已移除，监听必须在 app 上
  app.on("web-contents-created", (e, wc) => attachWc(wc, false));
  startWatch();
  // 启动即拉一次（如有历史数据，条立即可见）
  setTimeout(() => tryPull(), 2500);
  LOG("pump started, engine:", cfg.engine);
  diagFlush();
  // diag 周期落盘（10s），rendererDiag 定期回读
  setInterval(() => {
    for (const wc of webContents.getAllWebContents()) {
      if (isChatPage(wc) && wc.__ztuAttached) fetchRendererDiag(wc);
    }
  }, 10000);
}

try {
  start();
} catch (e) {
  LOG("start failed:", e.message);
}
