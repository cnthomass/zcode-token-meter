/* ZCode Token 用量状态条（渲染端）。
 * 由 pump.cjs 注入每个窗口：body 级 position:fixed 条，rAF 跟随输入框卡片，
 * 显示 ⚡速度/上下文/本轮/会话累计/工具/今日/子智能体；数据经 __ztuUpdate 推送。
 * 设计要点（踩坑收敛，改代码前必读）：
 *  - 样式表必须挂在条元素内部（进 head 会被 React 清掉 → fixed 退化 static）
 *  - 不向 React 布局流插 DOM；条悬浮在输入框卡片下沿之外的空带
 *  - 条几何不得盖住「输入框中心点」（可见性判定用 elementFromPoint，自遮挡会周期性闪烁）
 *  - 更新走 textContent/签名幂等，不整条重建（tooltip 不闪）
 *  - rAF 循环必须 try/catch + finally 续帧；document.hidden 整帧跳过
 *  - 代际守卫 __ztuGen：热重载后旧实例闭包自动失效 */
(function () {
  "use strict";
  var GEN = (window.__ztuGen = (window.__ztuGen || 0) + 1);
  var MY_GEN = GEN;
  var disposed = false;
  function stale() { return disposed || MY_GEN !== window.__ztuGen; }

  /* ---------- 清理旧实例 ---------- */
  document.querySelectorAll(".ztu-root,.ztu-tip,.ztu-panel").forEach(function (el) { el.remove(); });

  /* ---------- 状态 ---------- */
  var payload = null;          // 泵推送的最新快照 {sessions, today, today_subagent, tools_today, ts}
  var mySid = "";              // 本窗口会话（mine > composer data-session-id > 引擎默认）
  var diag = (window.__ztuDiag = window.__ztuDiag || {});   // 只许原地更新
  function diagSet(k, v) { try { diag[k] = v; } catch (e) { } }

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function wan(n) {           // 1448500 -> 144.85万 / 341M -> 3.41亿 / 8300 -> 8,300
    n = Math.floor(n || 0);
    if (n >= 1e8) return trim(n / 1e8) + "亿";
    if (n >= 1e4) return trim(n / 1e4) + "万";
    return n.toLocaleString("en-US");
  }
  function trim(v) {
    var s = v >= 100 ? v.toFixed(0) : v.toFixed(2);
    return s.replace(/\.?0+$/, "");
  }
  function pct(a, b) { return b > 0 ? (a * 100 / b) : null; }
  function f1(v) { return v == null ? null : Math.round(v * 10) / 10; }
  function secs(ms) {
    if (!ms || ms <= 0) return "";
    var s = ms / 1000;
    if (s >= 60) return Math.floor(s / 60) + "m" + Math.round(s % 60) + "s";
    return (Math.round(s * 10) / 10) + "s";
  }
  function tsum(o) { return (o && o.tin ? o.tin : 0) + (o && o.tout ? o.tout : 0); }

  function speedColor(v) {
    if (!isFinite(v) || v == null || v <= 0) return null;
    if (v < 40) return "b-low"; if (v < 70) return "b-mid"; if (v < 150) return "b-ok";
    if (v < 400) return "b-fast"; return "b-ultra";
  }
  function ctxColor(p) {
    if (p == null) return null;
    if (p >= 90) return "b-low"; if (p >= 80) return "b-warn";
    if (p >= 50) return "b-fast"; return "b-ok";
  }

  /* ---------- DOM ---------- */
  var bar = document.createElement("div");
  bar.className = "ztu-root";
  bar.innerHTML =
    '<style>' +
    ".ztu-root{position:fixed;display:none;box-sizing:border-box;" +
    "font:12px/1.5 ui-sans-serif,system-ui,'Segoe UI','Microsoft YaHei UI','Segoe UI Emoji','Segoe UI Symbol',sans-serif;" +
    "border-radius:10px;padding:4px 10px 3px;z-index:50;" +
    "background:rgba(28,30,36,.92);color:#dfe3ea;border:1px solid rgba(255,255,255,.08);" +
    "box-shadow:0 4px 18px rgba(0,0,0,.25);backdrop-filter:blur(6px);" +
    "white-space:nowrap;overflow:hidden;user-select:none;cursor:default}" +
    ".ztu-root.zu-light{background:rgba(246,247,249,.94);color:#26292f;border-color:rgba(0,0,0,.08);box-shadow:0 4px 14px rgba(0,0,0,.10)}" +
    ".ztu-row{display:flex;align-items:flex-start;gap:2px;justify-content:center}" +
    ".ztu-seg{display:inline-flex;flex-direction:row;align-items:baseline;gap:0;" +
    "padding:0 9px;cursor:default;outline:none}" +
    ".ztu-seg+.ztu-seg{border-left:1px solid rgba(128,128,128,.25)}" +
    ".ztu-v{font-variant-numeric:tabular-nums;font-size:12.5px;font-weight:600;line-height:1.35}" +
    ".ztu-u{font-size:11px;opacity:.75;font-weight:400}" +
    ".ztu-ico{font-size:11.5px;opacity:.65;margin-right:4px;line-height:1.3}" +
    ".ztu-seg:focus-visible{outline:1px solid #4da3ff;border-radius:6px}" +
    ".b-low{color:#ff6b6b}.b-mid{color:#f5c518}.b-ok{color:#3ddc84}" +
    ".b-fast{color:#4da3ff}.b-ultra{color:#b18cff}" +
    ".zu-light .b-low{color:#d93737}.zu-light .b-mid{color:#b07d08}" +
    ".zu-light .b-ok{color:#14934c}.zu-light .b-fast{color:#1668c2}.zu-light .b-ultra{color:#7a3ff2}" +
    ".ztu-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#3ddc84;" +
    "margin:0 2px;vertical-align:middle;animation:ztuPulse 1.6s ease-in-out infinite}" +
    ".ztu-dot.err{background:#ff5d5d;animation:none}" +
    ".ztu-dot.off{background:#888;animation:none;opacity:.4}" +
    "@keyframes ztuPulse{0%,100%{opacity:1}50%{opacity:.35}}" +
    ".ztu-gear{cursor:pointer;opacity:.6;padding:0 6px}" +
    ".ztu-gear:hover{opacity:1}" +
    ".ztu-gear:focus-visible{outline:1px solid #4da3ff;border-radius:6px}" +
    "</style>" +
    '<div class="ztu-row" role="status"></div>';
  document.body.appendChild(bar);
  var row = bar.querySelector(".ztu-row");

  function segHTML(cls, ico, name) {
    return '<span class="ztu-seg ' + (cls || "") + '" tabindex="0" role="button"' +
      ' aria-label="' + esc(name || ico) + '" title="' + esc(name || ico) + '">' +
      '<span class="ztu-ico">' + esc(ico) + '</span><span class="ztu-v">–</span></span>';
  }
  row.innerHTML =
    segHTML("zu-speed", "⚡", "生成速度") +
    segHTML("zu-ctx", "🪟", "上下文窗口") +
    segHTML("zu-turn", "💬", "本轮（这次提问）") +
    segHTML("zu-sess", "📊", "会话累计") +
    segHTML("zu-tools", "🔧", "工具调用") +
    segHTML("zu-today", "📅", "今日合计") +
    segHTML("zu-sub", "🤖", "子智能体") +
    '<span class="ztu-gear" tabindex="0" role="button" aria-label="状态条设置">⚙</span>';
  var segs = {
    speed: row.querySelector(".zu-speed .ztu-v"),
    ctx: row.querySelector(".zu-ctx .ztu-v"),
    turn: row.querySelector(".zu-turn .ztu-v"),
    sess: row.querySelector(".zu-sess .ztu-v"),
    tools: row.querySelector(".zu-tools .ztu-v"),
    today: row.querySelector(".zu-today .ztu-v"),
    sub: row.querySelector(".zu-sub .ztu-v"),
  };

  /* ---------- tooltip（挂 body、捕获阶段 mousemove；字符串 textContent 防注入） ---------- */
  var tip = document.createElement("div");
  tip.className = "ztu-tip";
  tip.style.cssText = "position:fixed;display:none;z-index:2147483646;max-width:460px;" +
    "font:12px/1.6 ui-sans-serif,system-ui,'Segoe UI','Microsoft YaHei UI','Segoe UI Emoji','Segoe UI Symbol',sans-serif;" +
    "background:var(--color-tooltip,#1d2026);color:#e6e8ec;border:1px solid rgba(255,255,255,.12);" +
    "border-radius:8px;padding:8px 12px;white-space:pre-line;pointer-events:none;" +
    "box-shadow:0 8px 24px rgba(0,0,0,.35)";
  document.body.appendChild(tip);
  var tipSig = "";
  function tipHTML(rows) {
    var h = "";
    for (var i = 0; i < rows.length; i++) {
      h += '<div><b style="opacity:.65">' + esc(rows[i][0]) + "</b>  " + esc(rows[i][1]) + "</div>";
    }
    return h;
  }
  function showTip(el, rows) {
    var sig = JSON.stringify(rows);
    if (sig === tipSig && tip.style.display === "block") return;
    tipSig = sig;
    tip.innerHTML = tipHTML(rows);
    tip.style.display = "block";
    var r = el.getBoundingClientRect(), tr = { w: tip.offsetWidth, h: tip.offsetHeight };
    var x = Math.min(Math.max(8, r.left + r.width / 2 - tr.w / 2), window.innerWidth - tr.w - 8);
    var y = r.top - tr.h - 8;
    if (y < 8) y = r.bottom + 8;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  function hideTip() { tip.style.display = "none"; tipSig = ""; }
  document.addEventListener("mousemove", function (e) {
    if (tip.style.display !== "block") return;
    var t = e.target;
    if (t && (bar.contains(t) || t === tip)) return;
    hideTip();
  }, true);

  /* ---------- 数据 → 各分段（签名幂等） ---------- */
  var lastSig = "";
  function currentSession() {
    if (!payload || !payload.sessions) return null;
    if (mySid && payload.sessions[mySid]) return payload.sessions[mySid];
    var k = Object.keys(payload.sessions);
    return k.length ? payload.sessions[k[0]] : null;
  }
  function render() {
    var s = currentSession();
    var t = (s && s.turn) || null;
    var sess = (s && s.session) || {};
    var ctx = (s && s.context) || {};
    var sub = (s && s.subagent) || {};
    var today = (payload && payload.today) || {};
    var tools = sess.tools || {};
    var sig = JSON.stringify([s, today, payload && payload.today_subagent, mySid,
      Math.round((live.speed || 0) * 10), liveSpeedFresh(),
      bar.classList.contains("zu-light")]);
    if (sig === lastSig) return false;
    lastSig = sig;

    // 生成速度
    var sp = t && (t.last_speed != null ? t.last_speed : null);
    var liveOn = liveSpeedFresh() && live.speed > 0;
    var spv = liveOn ? f1(live.speed) : f1(sp);
    segs.speed.textContent = spv != null ? (liveOn ? "≈" : "") + spv.toFixed(1) : "–";
    segs.speed.parentElement.classList.forEach(function (c) {
      if (c.indexOf("b-") === 0) segs.speed.parentElement.classList.remove(c);
    });
    var sc = speedColor(spv);
    if (sc) segs.speed.parentElement.classList.add(sc);

    // 上下文
    var cp = ctx.tokens ? pct(ctx.tokens, ctx.limit) : null;
    segs.ctx.textContent = cp != null ? cp.toFixed(1) + "%" : "–";
    segs.ctx.parentElement.classList.forEach(function (c) {
      if (c.indexOf("b-") === 0) segs.ctx.parentElement.classList.remove(c);
    });
    var cc = ctxColor(cp);
    if (cc) segs.ctx.parentElement.classList.add(cc);

    // 本轮
    if (t && t.tout != null) {
      var tv = wan(t.tout);
      if (t.tin) tv += " " + Math.round(pct(t.cread || 0, t.tin)) + "%";
      tv += " " + (t.reqs || 0) + "次";
      segs.turn.textContent = tv;
    } else {
      segs.turn.textContent = "–";
    }

    // 会话累计
    if (sess.tin != null) {
      segs.sess.textContent = wan(tsum(sess)) +
        (sess.tin ? " " + Math.round(pct(sess.cread || 0, sess.tin)) + "%" : "") +
        " " + (sess.turns || 0) + "轮 " + (sess.reqs || 0) + "次";
    } else segs.sess.textContent = "–";

    // 工具
    segs.tools.textContent = (tools.total || 0) + " ";
    var err = tools.errors || 0;
    segs.tools.innerHTML = esc(String(tools.total || 0)) +
      (err ? ' <span class="ztu-dot err" title=""></span>' + esc(String(err)) : "");
    if (!err) segs.tools.textContent = String(tools.total || 0);

    // 今日
    segs.today.textContent = wan(tsum(today)) || "0";

    // 子智能体
    var subT = tsum(sub);
    var fmtVal = subT ? wan(subT) : "–";
    if (subT && sub.running) segs.sub.innerHTML = esc(fmtVal) + ' <span class="ztu-dot"></span>';
    else segs.sub.textContent = fmtVal;
    return true;
  }

  /* ---------- tooltip 内容 ---------- */
  function bindTips() {
    function tipRowsFor(key) {
      var s = currentSession(); if (!s) return null;
      var t = s.turn || {}, sess = s.session || {}, ctx = s.context || {}, sub = s.subagent || {};
      var today = payload.today || {}, tas = payload.today_subagent || {};
      switch (key) {
        case "zu-speed": {
          var rows = [];
          if (liveSpeedFresh() && live.speed > 0) rows.push(["实时(估算)", "≈" + live.speed.toFixed(1) + " token/s（DOM 采样）"]);
          rows.push(["本轮速度", (t.last_speed != null ? t.last_speed.toFixed(1) : "–") + " token/s"]);
          if (t.peak_speed != null) rows.push(["本轮峰值", t.peak_speed.toFixed(1) + " token/s（" + t.segments + " 段加权）"]);
          if (t.ttft) rows.push(["首字延迟", secs(t.ttft)]);
          if (t.dur) rows.push(["生成耗时", secs(t.dur)]);
          if (s.model) rows.push(["模型", s.model]);
          rows.push(["口径", "输出 token ÷ 生成窗口（含思考请求按 started→completed）"]);
          return rows;
        }
        case "zu-ctx": {
          if (!ctx.tokens) return [["上下文", "暂无数据"]];
          return [["已用", wan(ctx.tokens) + " token（最近一次请求输入，含缓存）"],
                  ["窗口", wan(ctx.limit)], ["占比", (pct(ctx.tokens, ctx.limit)).toFixed(1) + "%"],
                  ["说明", "会话压缩（compact）后自然回落"]];
        }
        case "zu-turn": {
          if (t.tout == null) return [["本轮", "暂无数据"]];
          return [["输出", wan(t.tout) + (t.think ? "（含思考 " + wan(t.think) + "）" : "")],
                  ["缓存命中", t.tin ? Math.round(pct(t.cread || 0, t.tin)) + "%" : "–"],
                  ["请求", (t.reqs || 0) + " 次" + (t.tool_errors ? " · 工具错误 " + t.tool_errors : "")],
                  ["生成", secs(t.dur) + " · 首字 " + secs(t.ttft)]];
        }
        case "zu-sess": {
          if (sess.tin == null) return [["会话", "暂无数据"]];
          var rows2 = [["输入", wan(sess.tin) + (sess.tin ? "（命中 " + Math.round(pct(sess.cread || 0, sess.tin)) + "%）" : "")],
                       ["输出", wan(sess.tout) + (sess.think ? "（含思考 " + wan(sess.think) + "）" : "")],
                       ["规模", (sess.turns || 0) + " 轮 · " + (sess.reqs || 0) + " 次请求 · 工具 " + ((sess.tools || {}).total || 0)]];
          if (sess.t0) rows2.push(["时间范围", fmtClock(sess.t0) + " – " + fmtClock(sess.t1)]);
          var code = sess.code || {};
          if (code.add != null) rows2.push(["代码变更", "+" + (code.add || 0).toLocaleString() + " / -" + (code.del || 0).toLocaleString() + "（" + (code.files || 0) + " 文件）"]);
          return rows2;
        }
        case "zu-tools": {
          function shortTool(nm) {
            if (/^mcp__/.test(nm)) return "mcp:" + nm.replace(/^mcp__(plugin_)?/, "").replace(/__/g, ":");
            return nm;
          }
          var tol = sess.tools || {};
          var rows0 = [["本会话", (tol.total || 0) + " 次" + (tol.errors ? " · 错误 " + tol.errors : "")]];
          var by = sess.tools_by || [];
          if (by.length) {
            rows0.push(["── 会话工具明细 ──", ""]);
            var sumShown = 0;
            by.forEach(function (tb) {
              sumShown += tb.n;
              rows0.push(["  " + shortTool(tb.tool_name), tb.n + " 次" + (tb.errs ? " · 错 " + tb.errs : "")]);
            });
            var kinds = sess.tools_kinds || by.length;
            if (kinds > by.length) rows0.push(["  其余 " + (kinds - by.length) + " 种", ((tol.total || 0) - sumShown) + " 次"]);
          }
          rows0.push(["今日全部", ((payload.tools_today || {}).total || 0) + " 次" +
            ((payload.tools_today || {}).errors ? " · 错误 " + payload.tools_today.errors : "")]);
          var tby = payload.tools_today_by || [];
          if (tby.length) {
            rows0.push(["── 今日工具 TOP ──", ""]);
            tby.slice(0, 8).forEach(function (tb2) { rows0.push(["  " + shortTool(tb2.tool_name), tb2.n + " 次"]); });
            var tk = payload.tools_today_kinds || tby.length;
            if (tk > 8) rows0.push(["  其余 " + (tk - 8) + " 种", ""]);
          }
          return rows0;
        }
        case "zu-today": {
          var rows3 = [["合计", wan(tsum(today)) + " token"],
                       ["输入", wan(today.tin || 0) + (today.tin ? "（命中 " + Math.round(pct(today.cread || 0, today.tin)) + "%）" : "")],
                       ["输出", wan(today.tout || 0) + (today.think ? "（含思考 " + wan(today.think) + "）" : "")],
                       ["规模", (today.reqs || 0) + " 次请求 · " + (today.sessions || 0) + " 个会话（仅主链路）"]];
          return rows3;
        }
        case "zu-sub": {
          if (!tsum(sub)) return [["子智能体", "本会话暂无子智能体消耗"]];
          return [["合计", wan(tsum(sub)) + " token（今日全部 " + wan(tsum(tas)) + "）"],
                  ["规模", (sub.subs || 0) + " 个子会话 · " + (sub.reqs || 0) + " 次请求"],
                  ["状态", sub.running ? "● 运行中（30 秒内有请求完成）" : "空闲"]];
        }
      }
      return null;
    }
    row.querySelectorAll(".ztu-seg").forEach(function (el) {
      var key = (el.className.match(/zu-[a-z]+/) || [""])[0];
      var NAMES = { "zu-speed": "生成速度", "zu-ctx": "上下文", "zu-turn": "本轮（这次提问）",
        "zu-sess": "会话累计", "zu-tools": "工具调用", "zu-today": "今日合计", "zu-sub": "子智能体" };
      function show() {
        try {
          var r = tipRowsFor(key);
          if (r) { r = [["〔" + (NAMES[key] || "") + "〕", ""]].concat(r); showTip(el, r); }
        } catch (e) {
          diagSet("tipErr", key + ": " + String(e && e.message || e));
        }
      }
      el.addEventListener("mouseenter", show);
      el.addEventListener("focusin", show);
      el.addEventListener("mouseleave", hideTip);
      el.addEventListener("focusout", hideTip);
    });
  }
  function fmtClock(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  bindTips();

  /* ---------- ⚙ 面板 ---------- */
  var panel = null;
  var gearEl = bar.querySelector(".ztu-gear");
  function togglePanel() {
    if (panel) { panel.remove(); panel = null; return; }
    var s = currentSession() || {}, sess = s.session || {};
    panel = document.createElement("div");
    panel.className = "ztu-panel";
    panel.style.cssText = "position:fixed;z-index:2147483646;width:320px;" +
      "max-height:calc(100vh - 16px);overflow:auto;overflow-x:hidden;scrollbar-width:thin;" +
      "font:12px/1.7 ui-sans-serif,system-ui,'Segoe UI','Microsoft YaHei UI','Segoe UI Emoji','Segoe UI Symbol',sans-serif;" +
      "background:var(--color-tooltip,#1d2026);color:#e6e8ec;border:1px solid rgba(255,255,255,.12);" +
      "border-radius:10px;padding:12px 14px;box-shadow:0 12px 32px rgba(0,0,0,.4)";
    panel.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">⚡ ZCode Token 状态条</div>' +
      '<div style="opacity:.75" id="ztu-p-title"></div>' +
      '<div style="margin-top:8px" id="ztu-p-body"></div>' +
      '<div style="margin-top:10px;opacity:.55;font-size:11px">数据源 ~/.zcode/cli/db/db.sqlite（只读）<br>' +
      '配置 ~/.zcode/ztu-statusbar/config.json · 卸载见插件 README</div>';
    document.body.appendChild(panel);
    var title = (sess.title || "");
    panel.querySelector("#ztu-p-title").textContent = title ? "会话：" + title : "";
    var today = (payload && payload.today) || {};
    var bodyHtml =
      rowLine("本窗口会话", mySid || "（默认最近活跃）") +
      rowLine("模型", String(s.model || "–")) +
      rowLine("今日请求", (today.reqs || 0) + " 次 · " + (today.sessions || 0) + " 会话") +
      rowLine("数据延迟", payload ? ((Date.now() - payload.ts) / 1000).toFixed(0) + " 秒前" : "–");
    var rank = (payload && payload.rank_today) || [];
    if (rank.length) {
      bodyHtml += '<div style="margin-top:8px;opacity:.65;font-weight:700">📊 今日排行 TOP' +
        Math.min(rank.length, 5) + '</div>';
      rank.forEach(function (d, i) {
        var t = String(d.title || d.sid || "");
        if (t.length > 15) t = t.slice(0, 15) + "…";
        var tot = (d.tin || 0) + (d.tout || 0) + (d.sub_tin || 0) + (d.sub_tout || 0);
        var cur = (d.sid === mySid) ? ' style="color:var(--primary,#4da3ff)"' : "";
        bodyHtml += '<div' + cur + '><span style="opacity:.5;display:inline-block;width:16px">' +
          (i + 1) + '</span>' + esc(t) +
          '<span style="opacity:.55;float:right;font-variant-numeric:tabular-nums">' +
          esc(wan(tot)) + '</span></div>';
      });
    }
    panel.querySelector("#ztu-p-body").innerHTML = bodyHtml;
    // 内容填充后尺寸才稳定，此时以 ⚙ 按钮为锚定位：右对齐、上方优先、双向钳制
    var gr = gearEl.getBoundingClientRect();
    var pw = panel.offsetWidth, ph = panel.offsetHeight;
    var left = Math.max(8, Math.min(gr.right - pw, window.innerWidth - pw - 8));
    var top = Math.max(8, Math.min(gr.top - ph - 8, window.innerHeight - ph - 8));
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    setTimeout(function () {
      document.addEventListener("mousedown", panelOutside, true);
      document.addEventListener("keydown", panelEsc, true);
    }, 0);
  }
  function rowLine(k, v) {
    return '<div><span style="opacity:.6;display:inline-block;width:88px">' + esc(k) +
      "</span>" + esc(v) + "</div>";
  }
  function panelOutside(e) {
    if (panel && !panel.contains(e.target) && !bar.contains(e.target)) togglePanel();
  }
  function panelEsc(e) { if (e.key === "Escape" && panel) togglePanel(); }
  gearEl.addEventListener("click", togglePanel);

  /* ---------- 流式实时速率（DOM 采样）----------
   * 流式回答的文本实时渲染进最后一条 assistant-turn，采样字符增量折算 t/s：
   * tokens ≈ CJK字符×0.7 + 其他字符÷3.5（中英混编经验系数，估算态显示 ≰ 前缀）。
   * localStorage.ztuLive=0 关闭。 */
  var live = { chars: -1, t: 0, speed: 0, at: 0, sid: "" };
  function liveSpeedFresh() { return Date.now() - live.at < 2200; }
  function sampleLive() {
    if (stale() || document.hidden) return;
    try {
      if (localStorage.getItem("ztuLive") === "0") { live.speed = 0; live.at = 0; return; }
      var turns = document.querySelectorAll('[class*="assistant-turn"]');
      if (!turns.length) return;
      var node = turns[turns.length - 1].querySelector('[class*="chat-assistant-history-content"]');
      if (!node) node = turns[turns.length - 1];
      var txt = node.textContent || "";
      if (txt.length > 300000) txt = txt.slice(-300000);
      var n = txt.length, now = Date.now();
      if (live.chars < 0 || mySid !== live.sid) { live.chars = n; live.t = now; live.sid = mySid; return; }
      var dChars = n - live.chars, dt = now - live.t;
      live.chars = n; live.t = now;
      if (dt < 150 || dt > 4000) return;
      if (dChars <= 0) return;          // 工具块插入/重渲染导致的收缩：重置基线不更新速度
      var slice = txt.slice(Math.max(0, n - dChars - 40), n);
      var cjk = 0;
      for (var i = 0; i < slice.length; i++) {
        var cc = slice.charCodeAt(i);
        if (cc >= 0x2E80 && cc <= 0x9FFF) cjk++;       // CJK 统一表意区
      }
      var other = slice.length - cjk;
      var tokens = cjk * 0.7 + other / 3.5;
      var inst = tokens * 1000 / dt;
      live.speed = live.speed ? live.speed * 0.6 + inst * 0.4 : inst;
      live.at = now;
      diagSet("liveEst", { speed: Math.round(live.speed * 10) / 10, dChars: dChars, dt: dt });
    } catch (e) { diagSet("liveErr", String(e && e.message || e)); }
  }
  setInterval(sampleLive, 400);

  /* ---------- 回答末尾速率行 ----------
   * 插到最后一个 assistant-turn 容器内（内容列之后），随每次推送更新当前轮数据；
   * React 重渲染会清掉插入节点 → 800ms 对账自动补挂（幂等：data-ztu-tail=turn_id）。
   * localStorage.ztuTail=0 关闭。 */
  var tailTurnId = "";
  function tailText(t, s) {
    var bits = [];
    var sp = t.last_speed != null ? t.last_speed : null;
    if (sp) bits.push("⚡" + (Math.round(sp * 10) / 10) + " token/s(本轮)");
    if (t.ttft) bits.push("首字" + secs(t.ttft));
    if (t.tout != null) {
      var out = wan(t.tout);
      if (t.think) out += "(含思考" + wan(t.think) + ")";
      bits.push("输出" + out + (t.dur ? " / 生成" + secs(t.dur) : ""));
    }
    if (t.segments) bits.push(t.segments + " 段" + (t.peak_speed ? "/峰" + (Math.round(t.peak_speed)) : ""));
    var sess = s.session || {};
    if (sess.tin) bits.push("累计" + wan(tsum(sess)));
    if (t.completed_at) bits.push("⏱" + fmtClock(t.completed_at));
    return bits.join(" · ");
  }
  function upsertTail() {
    try {
      if (localStorage.getItem("ztuTail") === "0") return;
      var s = currentSession();
      var t = s && s.turn;
      if (!t || t.tout == null || !t.turn_id || !t.completed_at) return;
      var turnId = t.turn_id;
      var existing = document.querySelector('[data-ztu-tail="' + turnId + '"]');
      var turns = document.querySelectorAll('[class*="assistant-turn"]');
      if (!turns.length) return;
      var host = turns[turns.length - 1];
      var html = esc(tailText(t, s));
      if (existing) {
        if (existing.getAttribute("data-ztu-txt") !== html) {
          existing.setAttribute("data-ztu-txt", html);
          existing.innerHTML = html;   // 内容已 esc
        }
        tailTurnId = turnId;
        return;
      }
      // 本轮还没有行：挂到最后一个 assistant-turn；若其对应当前轮
      var line = document.createElement("div");
      line.className = "ztu-tailline";
      line.setAttribute("data-ztu-tail", turnId);
      line.setAttribute("data-ztu-txt", html);
      line.innerHTML = html;
      host.appendChild(line);
      tailTurnId = turnId;
      diagSet("tailLast", { turnId: turnId, at: Date.now() });
    } catch (e) { diagSet("tailErr", String(e && e.message || e)); }
  }
  (function tailStyle() {
    var st = document.createElement("style");
    st.textContent = ".ztu-tailline{font:11px/1.8 Consolas,'Segoe UI',monospace;" +
      "color:inherit;opacity:.5;padding:0 8px 6px;white-space:nowrap;overflow:hidden;" +
      "text-overflow:ellipsis;user-select:text;pointer-events:none}";
    document.head.appendChild(st);
  })();
  setInterval(function () {
    if (document.hidden || stale()) return;
    // 对账：当前轮的行被 React 清掉则补挂；换轮后不再复活旧行
    if (tailTurnId && !document.querySelector('[data-ztu-tail="' + tailTurnId + '"]')) {
      var s = currentSession();
      if (s && s.turn && s.turn.turn_id === tailTurnId) upsertTail();
    }
  }, 800);

  /* ---------- 主题 ---------- */
  var themeCache = { t: 0, light: false };
  function isLightTheme() {
    if (Date.now() - themeCache.t < 5000) return themeCache.light;
    themeCache.t = Date.now();
    try {
      var bg = getComputedStyle(document.documentElement).backgroundColor || "";
      var m = bg.match(/(\d+),\s*(\d+),\s*(\d+)/);
      themeCache.light = m ? ((+m[1] * 299 + +m[2] * 587 + +m[3] * 114) / 1000 > 140) : false;
    } catch (e) { themeCache.light = false; }
    return themeCache.light;
  }

  /* ---------- 锚点：输入框卡片 ---------- */
  var anchorCache = { t: 0, rect: null, el: null };
  var COMPOSER_SEL = 'textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor';
  function visible(r) { return r && r.width > 40 && r.height > 8 && r.bottom > 0 && r.top < window.innerHeight; }
  function findComposer() {
    if (Date.now() - anchorCache.t < 150) return anchorCache;
    anchorCache.t = Date.now();
    anchorCache.rect = null; anchorCache.el = null;
    // 取可视区内最靠底部的输入框（composer 总在最下方；排除侧栏搜索框等靠上的文本框）
    var best = null, bestRect = null;
    document.querySelectorAll(COMPOSER_SEL).forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (!visible(r)) return;
      if (!bestRect || r.bottom > bestRect.bottom) { best = el; bestRect = r; }
    });
    if (!best) { diagSet("composer", "none"); return anchorCache; }
    // 向上找视觉卡片容器（有边框/背景/圆角的最近祖先）
    var card = best, cr = bestRect;
    var node = best.parentElement, hops = 0;
    while (node && node !== document.body && hops < 12) {
      var cs;
      try { cs = getComputedStyle(node); } catch (e) { break; }
      if (cs && node.getBoundingClientRect && visible(node.getBoundingClientRect())) {
        var hasBg = cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent";
        var hasBorder = cs.borderTopWidth !== "0px" || cs.boxShadow !== "none";
        var rounded = parseFloat(cs.borderBottomLeftRadius || "0") >= 6;
        if ((hasBg || hasBorder) && rounded) {
          var rr = node.getBoundingClientRect();
          if (rr.width >= cr.width * 0.95 && rr.height <= window.innerHeight * 0.8) { card = node; cr = rr; }
        }
      }
      node = node.parentElement; hops++;
    }
    anchorCache.rect = cr; anchorCache.el = card;
    diagSet("composer", "ok");
    diagSet("composerRect", [Math.round(cr.left), Math.round(cr.top), Math.round(cr.width), Math.round(cr.height)]);
    return anchorCache;
  }

  /* ---------- 主循环 ---------- */
  var lastHideReason = "";
  function frame() {
    if (stale()) return;
    try {
      if (document.hidden) return;
      var a = findComposer();
      var vis = false, reason = "";
      if (!a.rect) {
        reason = "noComposer";
      } else {
        if (isLightTheme()) bar.classList.add("zu-light"); else bar.classList.remove("zu-light");
        var bw = Math.min(a.rect.width, 980);
        bar.style.width = bw + "px";
        bar.style.left = (a.rect.left + (a.rect.width - bw) / 2) + "px";
        var top = a.rect.bottom + 6;
        if (top + bar.offsetHeight > window.innerHeight - 4) top = window.innerHeight - bar.offsetHeight - 4;
        bar.style.top = top + "px";
        // 可见性：纯几何判定——bar 不得覆盖「输入框中心点」（防命中检测自遮挡闪烁）
        var br = bar.getBoundingClientRect();
        var cx = a.rect.left + a.rect.width / 2, cy = a.rect.top + a.rect.height / 2;
        if (br.width > 0 && cx >= br.left && cx <= br.right && cy >= br.top && cy <= br.bottom) {
          reason = "occluded";
        } else {
          vis = true;
        }
      }
      var did = render();
      if (did) diagSet("lastRender", Date.now());
      if (vis) {
        if (bar.style.display !== "block") { bar.style.display = "block"; diagSet("shownAt", Date.now()); }
        if (beacon) beacon.style.display = "none";
      } else {
        if (bar.style.display !== "none") { bar.style.display = "none"; hideTip(); }
        showBeacon(reason);
      }
      if (reason !== lastHideReason) { lastHideReason = reason; diagSet("hideReason", reason); }
    } catch (e) {
      diagSet("frameErr", String(e && e.message || e));
    } finally {
      if (!stale()) requestAnimationFrame(frame);
    }
  }
  requestAnimationFrame(frame);

  /* ---------- 诊断角标（bar 无法显示时在右下角给出原因码；localStorage.ztuDebug=0 关闭） ---------- */
  var beacon = null;
  var beaconDismissed = false;
  function showBeacon(reason) {
    if (beaconDismissed) return;
    var off = false;
    try { off = localStorage.getItem("ztuDebug") === "0"; } catch (e) { }
    if (off) return;
    if (!beacon) {
      beacon = document.createElement("div");
      beacon.style.cssText = "position:fixed;right:10px;bottom:10px;z-index:2147483645;" +
        "font:10px/1.4 Consolas,monospace;color:#8fa4c0;background:rgba(20,24,32,.92);" +
        "border:1px solid rgba(255,255,255,.14);border-radius:6px;padding:2px 8px;cursor:pointer";
      beacon.title = "ZCode Token 状态条诊断角标（点击隐藏；localStorage.ztuDebug=0 永久关闭）";
      beacon.addEventListener("click", function () { beaconDismissed = true; beacon.style.display = "none"; });
      document.body.appendChild(beacon);
    }
    var s = currentSession();
    var txt = "⚡ztu " + (payload ? "data✓" : "no-data") +
      " · " + (reason || "hidden") +
      (diag.frameErr ? " · err:" + diag.frameErr : "") +
      " · sid:" + (mySid ? mySid.slice(0, 12) : "-");
    if (beacon.textContent !== txt) beacon.textContent = txt;
    if (beacon.style.display !== "block") beacon.style.display = "block";
  }

  /* ---------- 数据入口（泵经 executeJavaScript 调用） ---------- */
  window.__ztuUpdate = function (d) {
    if (stale()) return;
    try {
      if (!d || typeof d !== "object") return;
      payload = d;
      mySid = typeof d.mine === "string" ? d.mine : mySid;
      if (!mySid) {
        var el = findComposer().el;
        var n = el, i = 0;
        while (n && n !== document.body && i < 16) {
          if (n.getAttribute && n.getAttribute("data-session-id")) { mySid = n.getAttribute("data-session-id"); break; }
          n = n.parentElement; i++;
        }
      }
      diagSet("lastUpdate", Date.now());
      setTimeout(upsertTail, 80);   // 让 React 先落定再挂速率行
      lastSig = "";   // 强制下帧重画
    } catch (e) { diagSet("updateErr", String(e && e.message || e)); }
  };
  diagSet("mountedAt", Date.now());
  diagSet("gen", MY_GEN);
})();
