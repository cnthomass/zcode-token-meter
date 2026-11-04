#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ZCode Token 用量统计引擎（状态栏数据源 + 对话内查询）.

从 ZCode 本地 db.sqlite 只读统计模型请求的各类指标：
  ⚡生成速度 · 首字延迟 · 本轮/会话/今日 token 用量 · 上下文占比
  缓存命中率 · 思考 token · 工具调用与错误 · 子智能体消耗 · 代码变更

统计口径（与 zcode 官方库语义对齐）:
  - input_tokens 已含 cache_read；缓存命中率 = cache_read ÷ input_tokens
  - 轮数 = COUNT(DISTINCT turn_id)
  - 速度 = output ÷ 生成窗口：无思考请求用 completed_at−first_token_at；
    含思考请求（reasoning_tokens>0）用 completed_at−started_at（思考在首字前流出）
  - 上下文容量 = 最近一次 completed 请求的 input_tokens ÷ 模型上下文窗口
  - 子智能体 = 会话经 session.parent_id 关联的子会话（query_source='subagent'）

用法:
  python usage_engine.py --format json                       # 当前会话快照
  python usage_engine.py --sids '["session_a","session_b"]'  # 多会话快照（状态栏泵用）
  python usage_engine.py --format panel                      # 人类可读明细面板
  echo '{"session_id":"session_x"}' | python usage_engine.py # stdin 识别会话

只依赖 Python 3.8+ 标准库；对 db.sqlite 以 WAL 只读模式访问，不影响 ZCode 运行。
"""

import argparse
import json
import os
import sqlite3
import sys
import time

# Windows 下泵从 Electron 环境解析到的 python 可能默认 GBK 管道输出，
# 泵按 UTF-8 解码会让标题变乱码——引擎侧无条件强制 UTF-8（对任何解释器生效）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DEFAULT_DB = os.path.join(os.path.expanduser("~"), ".zcode", "cli", "db", "db.sqlite")
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".zcode", "ztu-statusbar", "config.json")
DEFAULT_CONTEXT_LIMIT = 200000
# 已知模型上下文窗口（config.json 的 context_limits 可覆盖）
MODEL_CONTEXT_LIMITS = {
    "glm-5.3": 1000000, "glm-5.3-flash": 1000000, "glm-5.3-flashx": 1000000,
    "glm-5.2": 200000, "glm-4.6": 200000, "glm-4.5": 128000, "glm-4.5-air": 128000,
    "deepseek-v4.1": 1000000, "deepseek-v4.1-flash": 1000000, "deepseek-flash": 1000000,
    "kimi-k3": 1000000, "claude-sonnet-4": 200000, "claude-opus-4": 200000,
}
MAIN_AGENT = "zcode-agent"
SUB_RUNNING_MS = 30000  # 子智能体 30s 内有完成请求视为运行中
CONFIG = {}


def load_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


# ---------------------------------------------------------------- formatting

def fmt_tokens(n):
    """1448500 -> 144.85万 ; 164200 -> 16.4万 ; 8300 -> 8,300 ; 341M -> 3.41亿"""
    if not n:
        return "0"
    n = int(n)
    if n >= 100000000:
        return ("%.2f" % (n / 100000000.0)).rstrip("0").rstrip(".") + "亿"
    if n >= 10000:
        return ("%.2f" % (n / 10000.0)).rstrip("0").rstrip(".") + "万"
    return "{:,}".format(n)


def fmt_pct(p):
    return ("%.1f%%" % p) if p is not None else "-"


def fmt_secs(ms):
    if ms is None:
        return "-"
    s = ms / 1000.0
    if s >= 60:
        return "%dm%ds" % (int(s // 60), int(s % 60))
    return "%.1fs" % s


def gen_window(row):
    """该请求的生成时长窗口（ms）。含思考用 started→completed，否则用首字→completed。"""
    c = row["completed_at"] or 0
    if not c:
        return None
    if (row["reasoning_tokens"] or 0) > 0:
        return c - (row["started_at"] or c)
    ft = row["first_token_at"] or 0
    return (c - ft) if ft else (c - (row["started_at"] or c))


def request_speed(row):
    w = gen_window(row)
    out = row["output_tokens"] or 0
    if not w or w <= 0 or not out:
        return None
    return out * 1000.0 / w


def fmt_clock(ms_epoch):
    if not ms_epoch:
        return "-"
    return time.strftime("%H:%M:%S", time.localtime(ms_epoch / 1000.0))


def day_start_ms():
    lt = time.localtime()
    day0 = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
    return int(day0 * 1000)


# ---------------------------------------------------------------- database

def connect(db_path):
    if not os.path.exists(db_path):
        sys.stderr.write("db.sqlite 不存在: %s\n" % db_path)
        sys.exit(2)
    con = sqlite3.connect("file:%s?mode=ro" % db_path.replace("\\", "/"), uri=True, timeout=2.0)
    con.row_factory = sqlite3.Row
    return con


def q(con, sql, args=()):
    try:
        return con.execute(sql, args).fetchall()
    except sqlite3.OperationalError:
        return []


def latest_session_id(con):
    r = q(con, """SELECT id FROM session
                  WHERE (id LIKE 'session_%' OR id LIKE 'sess_%') AND parent_id IS NULL
                  AND time_deleted IS NULL
                  ORDER BY time_updated DESC LIMIT 1""")
    return r[0]["id"] if r else None


# ---------------------------------------------------------------- per-session metrics

def session_metrics(con, session_id, limits, default_limit=DEFAULT_CONTEXT_LIMIT, day0=None):
    m = {"session_id": session_id}
    main = "AND agent = '%s'" % MAIN_AGENT

    # --- 最近一次主链路请求（速度/上下文/模型） ---
    r = q(con, """
        SELECT model_id, input_tokens, output_tokens, reasoning_tokens,
               cache_read_input_tokens, started_at, first_token_at, completed_at
        FROM model_usage
        WHERE session_id = ? %s AND status != 'error'
        ORDER BY started_at DESC LIMIT 1""" % main, (session_id,))
    last = dict(r[0]) if r else None
    m["model"] = (last or {}).get("model_id")
    m["last_speed"] = request_speed(last) if last else None
    m["last_ttft"] = (last or {}).get("first_token_at")
    ctx_tokens = (last or {}).get("input_tokens") if last else None
    limit = limits.get((m["model"] or "").lower(), default_limit)
    m["context"] = {"tokens": ctx_tokens, "limit": limit}

    # --- 本轮（从 model_usage 按最新 turn_id 实时推导；turn_usage 进行中不落行） ---
    turn = None
    r = q(con, """SELECT turn_id FROM model_usage WHERE session_id = ? %s
                  GROUP BY turn_id ORDER BY MAX(started_at) DESC LIMIT 1""" % main,
          (session_id,))
    if r:
        tid = r[0]["turn_id"]
        r = q(con, """
            SELECT COUNT(*) reqs, SUM(output_tokens) tout, SUM(reasoning_tokens) think,
                   SUM(cache_read_input_tokens) cread, SUM(input_tokens) tin,
                   MIN(time_to_first_token_ms) ttft, SUM(duration_ms) dur,
                   MIN(started_at) started_at, MAX(completed_at) completed_at
            FROM model_usage WHERE session_id = ? AND turn_id = ? %s""" % main,
            (session_id, tid))
        if r and r[0]["reqs"]:
            turn = dict(r[0])
            turn["turn_id"] = tid
            rows = q(con, """
                SELECT output_tokens, reasoning_tokens, started_at, first_token_at, completed_at
                FROM model_usage
                WHERE session_id = ? AND turn_id = ? %s AND output_tokens > 0
                ORDER BY started_at""" % main, (session_id, tid))
            speeds = [request_speed(x) for x in rows]
            speeds = [s for s in speeds if s]
            turn["segments"] = len(speeds)
            turn["peak_speed"] = max(speeds) if speeds else None
            turn["last_speed"] = speeds[-1] if speeds else None
            r = q(con, """SELECT COUNT(*) tools,
                          SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) tool_errors
                          FROM tool_usage WHERE session_id = ? AND turn_id = ?""",
                (session_id, tid))
            tu = dict(r[0]) if r else {}
            turn["tools"] = tu.get("tools") or 0
            turn["tool_errors"] = tu.get("tool_errors") or 0
    m["turn"] = turn

    # --- 会话累计（主链路） ---
    r = q(con, """
        SELECT COUNT(*) reqs, COUNT(DISTINCT turn_id) turns,
               SUM(input_tokens) tin, SUM(output_tokens) tout,
               SUM(reasoning_tokens) think, SUM(cache_read_input_tokens) cread,
               MIN(started_at) t0, MAX(completed_at) t1
        FROM model_usage WHERE session_id = ? %s""" % main, (session_id,))
    s = dict(r[0]) if r and r[0]["reqs"] else dict(
        reqs=0, turns=0, tin=0, tout=0, think=0, cread=0, t0=None, t1=None)
    r = q(con, """SELECT COUNT(*) total,
                  SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors,
                  SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running
                  FROM tool_usage WHERE session_id = ?""", (session_id,))
    s["tools"] = dict(r[0]) if r else {"total": 0, "errors": 0, "running": 0}
    rows = q(con, """SELECT model_id, COUNT(*) reqs, SUM(output_tokens) tout,
                     SUM(input_tokens) tin, SUM(reasoning_tokens) think
              FROM model_usage WHERE session_id = ? %s GROUP BY model_id
              ORDER BY tout DESC LIMIT 6""" % main, (session_id,))
    s["models_by"] = [dict(x) for x in rows]
    rows = q(con, """SELECT tool_name, COUNT(*) n,
                     SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errs
                     FROM tool_usage WHERE session_id = ? GROUP BY tool_name
                     ORDER BY n DESC LIMIT 12""", (session_id,))
    s["tools_by"] = [dict(x) for x in rows]
    r = q(con, "SELECT COUNT(DISTINCT tool_name) k FROM tool_usage WHERE session_id = ?",
          (session_id,))
    s["tools_kinds"] = r[0]["k"] if r else 0
    r = q(con, """SELECT summary_additions a, summary_deletions d, summary_files f, title
                  FROM session WHERE id = ?""", (session_id,))
    if r:
        s["code"] = {"add": r[0]["a"], "del": r[0]["d"], "files": r[0]["f"]}
        s["title"] = r[0]["title"]
    m["session"] = s

    # --- 子智能体（本会话经 parent_id 关联的子会话） ---
    now_ms = int(time.time() * 1000)
    r = q(con, """
        SELECT COUNT(*) reqs, COUNT(DISTINCT mu.session_id) subs,
               SUM(mu.output_tokens) tout, SUM(mu.input_tokens) tin,
               MAX(mu.completed_at) last_done
        FROM model_usage mu
        JOIN session ch ON ch.id = mu.session_id AND ch.parent_id = ?
        WHERE mu.query_source = 'subagent'""", (session_id,))
    sub = dict(r[0]) if r else {"reqs": 0, "subs": 0, "tout": 0, "tin": 0, "last_done": None}
    sub["running"] = bool(sub.get("last_done") and now_ms - sub["last_done"] <= SUB_RUNNING_MS)
    m["subagent"] = sub

    # --- 本会话今日（该会话在今天 0 点以来的消耗；子智能体单独一列） ---
    if day0:
        r = q(con, """
            SELECT COUNT(*) reqs, COUNT(DISTINCT turn_id) turns,
                   SUM(input_tokens) tin, SUM(output_tokens) tout,
                   SUM(reasoning_tokens) think, SUM(cache_read_input_tokens) cread
            FROM model_usage WHERE session_id = ? %s AND started_at >= ?""" % main,
            (session_id, day0))
        st = dict(r[0]) if r and r[0]["reqs"] else dict(
            reqs=0, turns=0, tin=0, tout=0, think=0, cread=0)
        r = q(con, """
            SELECT COUNT(*) reqs, SUM(mu.output_tokens) tout, SUM(mu.input_tokens) tin
            FROM model_usage mu JOIN session ch ON ch.id = mu.session_id AND ch.parent_id = ?
            WHERE mu.started_at >= ? AND mu.query_source = 'subagent'""", (session_id, day0))
        sd = dict(r[0]) if r else {}
        st["sub_tout"] = sd.get("tout") or 0
        st["sub_tin"] = sd.get("tin") or 0
        st["sub_reqs"] = sd.get("reqs") or 0
        rows = q(con, """SELECT model_id, COUNT(*) reqs, SUM(output_tokens) tout,
                         SUM(input_tokens) tin
                  FROM model_usage WHERE session_id = ? %s AND started_at >= ?
                  GROUP BY model_id ORDER BY tout DESC LIMIT 6""" % main,
            (session_id, day0))
        st["models_by"] = [dict(x) for x in rows]
    else:
        st = dict(reqs=0, turns=0, tin=0, tout=0, think=0, cread=0,
                  sub_tout=0, sub_tin=0, sub_reqs=0)
    m["session_today"] = st
    return m


def global_metrics(con, day0):
    main = "AND agent = '%s'" % MAIN_AGENT
    out = {}
    r = q(con, """SELECT COUNT(*) reqs, COUNT(DISTINCT session_id) sessions,
                  SUM(input_tokens) tin, SUM(output_tokens) tout,
                  SUM(reasoning_tokens) think, SUM(cache_read_input_tokens) cread
                  FROM model_usage WHERE started_at >= ? %s""" % main, (day0,))
    out["today"] = dict(r[0]) if r else {}
    r = q(con, """SELECT COUNT(*) reqs, COUNT(DISTINCT mu.session_id) subs,
                  SUM(mu.output_tokens) tout, SUM(mu.input_tokens) tin
                  FROM model_usage mu
                  JOIN session ch ON ch.id = mu.session_id AND ch.parent_id IS NOT NULL
                  WHERE mu.started_at >= ? AND mu.query_source = 'subagent'""", (day0,))
    out["today_subagent"] = dict(r[0]) if r else {}
    r = q(con, """SELECT COUNT(*) total,
                  SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors
                  FROM tool_usage WHERE started_at >= ?""", (day0,))
    out["tools_today"] = dict(r[0]) if r else {}
    rows = q(con, """SELECT model_id, COUNT(*) reqs, SUM(output_tokens) tout,
                     SUM(input_tokens) tin
              FROM model_usage WHERE started_at >= ? %s GROUP BY model_id
              ORDER BY tout DESC LIMIT 6""" % main, (day0,))
    out["models_today_by"] = [dict(x) for x in rows]
    rows = q(con, """SELECT tool_name, COUNT(*) n FROM tool_usage
                     WHERE started_at >= ? GROUP BY tool_name
                     ORDER BY n DESC LIMIT 12""", (day0,))
    out["tools_today_by"] = [dict(x) for x in rows]
    r = q(con, "SELECT COUNT(DISTINCT tool_name) k FROM tool_usage WHERE started_at >= ?",
          (day0,))
    out["tools_today_kinds"] = r[0]["k"] if r else 0
    return out


def snapshot(con, sids, day0, limits, default_limit=DEFAULT_CONTEXT_LIMIT):
    seen = []
    sessions = {}
    for sid in sids:
        if not sid or sid in seen:
            continue
        seen.append(sid)
        try:
            sessions[sid] = session_metrics(con, sid, limits, default_limit, day0)
        except Exception:
            continue
    snap = {"sessions": sessions, "ts": int(time.time() * 1000)}
    snap.update(global_metrics(con, day0))
    snap["rank_today"] = rank_sessions(con, day0, sort="total", limit=5)
    return snap


# ---------------------------------------------------------------- 排行

def rank_sessions(con, since_ms, sort="tout", limit=20):
    """会话排行（主链路）。sort: tout|tin|total|reqs|recent；since_ms=0 表示全部历史。"""
    order = {"tout": "tout", "tin": "tin", "total": "total", "reqs": "reqs",
             "recent": "tu"}.get(sort, "tout")
    where = "WHERE mu.started_at >= ? AND mu.agent = '%s'" % MAIN_AGENT if since_ms else         "WHERE mu.agent = '%s'" % MAIN_AGENT
    rows = q(con, """
        SELECT mu.session_id sid, MAX(s.title) title, MAX(s.time_updated) tu,
               SUM(mu.input_tokens) tin, SUM(mu.output_tokens) tout,
               SUM(mu.reasoning_tokens) think, SUM(mu.cache_read_input_tokens) cread,
               COUNT(*) reqs, COUNT(DISTINCT mu.turn_id) turns,
               MIN(mu.started_at) t0, MAX(mu.completed_at) t1
        FROM model_usage mu JOIN session s ON s.id = mu.session_id
        %s
        GROUP BY mu.session_id""" % where, (since_ms,) if since_ms else ())
    out = []
    for r in rows:
        d = dict(r)
        d["total"] = (d["tin"] or 0) + (d["tout"] or 0)
        out.append(d)
    sub = q(con, """
        SELECT ch.parent_id pid, COUNT(*) reqs, SUM(mu.output_tokens) tout,
               SUM(mu.input_tokens) tin, COUNT(DISTINCT mu.session_id) subs
        FROM model_usage mu JOIN session ch ON ch.id = mu.session_id
        WHERE mu.query_source = 'subagent' AND ch.parent_id IS NOT NULL
        %s
        GROUP BY ch.parent_id""" % ("AND mu.started_at >= ?" if since_ms else ""),
        (since_ms,) if since_ms else ())
    submap = {r["pid"]: dict(r) for r in sub}
    for d in out:
        sd = submap.get(d["sid"]) or {}
        d["sub_tout"] = sd.get("tout") or 0
        d["sub_tin"] = sd.get("tin") or 0
        d["sub_reqs"] = sd.get("reqs") or 0
        d["subs"] = sd.get("subs") or 0
        d["total"] += d["sub_tout"] + d["sub_tin"]
    out.sort(key=lambda x: x[order] or 0, reverse=True)
    return out[:limit]


PIPE_ESC = chr(92) + chr(124)  # \|


def render_rank(rows, days):
    """Markdown 排行表（聊天内直接可读）。"""
    def rng():
        return "全部历史" if not days else "近 %d 天" % days
    if not rows:
        return "（%s暂无会话数据）" % rng()
    lines = ["| # | 会话 | 输入 | 输出 | 思考 | 子智能体 | 轮次 | 请求 | 最近活跃 |",
             "|---|------|------|------|------|----------|------|------|----------|"]
    for i, d in enumerate(rows, 1):
        title = (d.get("title") or d["sid"])
        title = title[:24] + "…" if len(title) > 25 else title
        act = fmt_clock(d.get("tu") or d.get("t1"))
        lines.append("| %d | %s | %s | %s | %s | %s | %s | %s | %s |" % (
            i, title.replace("|", PIPE_ESC), fmt_tokens(d["tin"]), fmt_tokens(d["tout"]),
            fmt_tokens(d["think"]),
            (fmt_tokens(d["sub_tout"] + d["sub_tin"]) + "(%d个)" % d["subs"]) if d["subs"] else "–",
            d["turns"], d["reqs"], act))
    return chr(10).join(lines)


# ---------------------------------------------------------------- human renderers

def collect_legacy(con, session_id, day0, limits, default_limit=DEFAULT_CONTEXT_LIMIT):
    """单会话旧版扁平结构（statusline/panel/tail 渲染用）。"""
    m = session_metrics(con, session_id, limits, default_limit, day0)
    s = m["session"]
    t = m.get("turn") or {}
    flat = {
        "model": m["model"],
        "last_speed": m["last_speed"],
        "last_ttft": m["last_ttft"],
        "context": m["context"],
        "turn": t,
        "session": {"reqs": s["reqs"], "turns": s["turns"], "tin": s["tin"],
                    "tout": s["tout"], "think": s["think"], "cread": s["cread"],
                    "t0": s["t0"], "t1": s["t1"], "tools": s["tools"],
                    "title": s.get("title"), "code": s.get("code") or {}},
        "tools_session": s["tools"],
        "models_by": (m.get("session") or {}).get("models_by") or [],
        "session_today": m.get("session_today") or {},
        "today": {}, "today_subagent": {},
        "subagent": m["subagent"],
    }
    return flat


def render_statusline(m):
    parts = []
    t = m.get("turn") or {}
    sp = t.get("last_speed") or m.get("last_speed")
    if sp:
        parts.append("⚡%.1f t/s" % sp)
    ctx = m["context"]
    if ctx.get("tokens"):
        parts.append("上下文 %s (%s)" % (fmt_tokens(ctx["tokens"]),
                                         fmt_pct(ctx["tokens"] * 100.0 / ctx["limit"])))
    if t.get("tout") is not None:
        seg = "本轮 %s" % fmt_tokens(t["tout"])
        if t.get("tin"):
            seg += " %.0f%%" % ((t["cread"] or 0) * 100.0 / t["tin"])
        seg += " %s次" % (t.get("reqs") or 0)
        parts.append(seg)
    s = m["session"]
    if s.get("tin"):
        parts.append("会话 %s" % fmt_tokens((s["tin"] or 0) + (s["tout"] or 0)))
    td = m.get("today") or {}
    if td.get("tin"):
        parts.append("今日 %s" % fmt_tokens((td["tin"] or 0) + (td["tout"] or 0)))
    return " | ".join(parts)


def render_tail(m):
    t = m.get("turn")
    if not t:
        return ""
    bits = []
    sp = t.get("last_speed") or m.get("last_speed")
    if sp:
        bits.append("⚡ %.1f token/s(本轮)" % sp)
    if t.get("ttft"):
        bits.append("首字 %.1fs" % (t["ttft"] / 1000.0))
    if t.get("tout") is not None:
        out = "{:,}".format(t["tout"])
        if t.get("think"):
            out += "(含 %s 思考)" % "{:,}".format(t["think"])
        gen = (" / 生成 %s" % fmt_secs(t.get("dur"))) if t.get("dur") else ""
        bits.append("输出 %s token%s" % (out, gen))
    if t.get("segments"):
        peak = (" / 峰 %.0f token/s" % t["peak_speed"]) if t.get("peak_speed") else ""
        bits.append("%d 段%s" % (t["segments"], peak))
    s = m["session"]
    if s.get("tin"):
        bits.append("累计 %s token" % fmt_tokens((s["tin"] or 0) + (s["tout"] or 0)))
    if t.get("completed_at"):
        bits.append("⏱ " + fmt_clock(t["completed_at"]))
    return " · ".join(bits)


def render_panel(m):
    s = m["session"]
    lines = ["📊 " + (s.get("title") or "会话统计"), "─" * 46]
    tin, tout = s.get("tin") or 0, s.get("tout") or 0
    hit = (s.get("cread") or 0) * 100.0 / tin if tin else None
    lines.append("输入    %s (缓存命中 %s)" % (fmt_tokens(tin), fmt_pct(hit)))
    think = "（含思考 %s）" % fmt_tokens(s["think"]) if s.get("think") else ""
    lines.append("输出    %s%s" % (fmt_tokens(tout), think))
    mb = m.get("models_by") or []
    if mb:
        parts = ["%s %s/%s次" % (x["model_id"], fmt_tokens(x["tout"]), x["reqs"])
                 for x in mb[:3]]
        if len(mb) > 3:
            parts.append("等 %d 个模型" % len(mb))
        lines.append("模型分布  " + " · ".join(parts))
    tools = s["tools"]
    scale = "%s 轮 · %s 次请求 · 工具 %s" % (s.get("turns") or 0, s.get("reqs") or 0,
                                            tools.get("total") or 0)
    if tools.get("errors"):
        scale += "（错误 %s）" % tools["errors"]
    lines.append("规模    " + scale)
    if s.get("t0") and s.get("t1"):
        lines.append("时间范围  %s – %s" % (fmt_clock(s["t0"]), fmt_clock(s["t1"])))
    cc = s.get("code") or {}
    if cc.get("add") is not None:
        lines.append("代码变更  +%s / -%s（%s 文件）" % (
            "{:,}".format(cc["add"] or 0), "{:,}".format(cc["del"] or 0),
            cc.get("files") or 0))
    ctx = m["context"]
    if ctx.get("tokens"):
        lines.append("上下文  %s / %s（%s）" % (fmt_tokens(ctx["tokens"]),
                                               fmt_tokens(ctx["limit"]),
                                               fmt_pct(ctx["tokens"] * 100.0 / ctx["limit"])))
    t = m.get("turn") or {}
    sp = t.get("last_speed") or m.get("last_speed")
    if sp:
        ttft = ("，首字 %.1fs" % (t["ttft"] / 1000.0)) if t.get("ttft") else ""
        lines.append("速度    ⚡%.1f token/s%s" % (sp, ttft))
    sub = m.get("subagent") or {}
    if sub.get("reqs"):
        run = "（运行中）" if sub.get("running") else ""
        lines.append("子智能体  %s（%s 个 · %s 次请求）%s" % (
            fmt_tokens((sub["tin"] or 0) + (sub["tout"] or 0)),
            sub.get("subs") or 0, sub.get("reqs") or 0, run))
    st = m.get("session_today") or {}
    if st.get("tin") or st.get("tout"):
        lines.append("本会话今日  %s（%s 次请求%s）" % (
            fmt_tokens((st.get("tin") or 0) + (st.get("tout") or 0)),
            st.get("reqs") or 0,
            ("，另子智能体 %s" % fmt_tokens((st.get("sub_tin") or 0) + (st.get("sub_tout") or 0)))
            if (st.get("sub_tin") or st.get("sub_tout")) else ""))
    td = m.get("today") or {}
    if td.get("tin"):
        lines.append("今日全部会话  %s（%s 次请求 · %s 个会话）" % (
            fmt_tokens((td["tin"] or 0) + (td["tout"] or 0)),
            td.get("reqs") or 0, td.get("sessions") or 0))
    return "\n".join(lines)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="ZCode Token 用量统计引擎")
    ap.add_argument("--db", default=os.environ.get("ZCODE_DB", DEFAULT_DB))
    ap.add_argument("--session", help="单会话查询（默认取最近活跃会话）")
    ap.add_argument("--sids", help="多会话快照（JSON 数组，状态栏泵用）")
    ap.add_argument("--context-limit", type=int, help="覆盖上下文窗口大小")
    ap.add_argument("--format", choices=["statusline", "panel", "tail", "json", "rank"],
                    default="statusline")
    ap.add_argument("--days", type=int, default=7, help="排行时间窗（天，0=全部历史）")
    ap.add_argument("--sort", default="total",
                    choices=["tout", "tin", "total", "reqs", "recent"])
    ap.add_argument("--limit", type=int, default=20)
    args = ap.parse_args()

    global CONFIG
    CONFIG = load_config()
    limits = dict(MODEL_CONTEXT_LIMITS)
    limits.update(CONFIG.get("context_limits") or {})
    default_limit = int(CONFIG.get("default_context_limit") or DEFAULT_CONTEXT_LIMIT)
    if args.context_limit:
        default_limit = args.context_limit

    stdin_sid = None   # 会话一律来自 --sids/--session 参数（stdin 管道在泵场景会永久阻塞）

    con = connect(args.db)
    day0 = day_start_ms()
    if args.format == "rank":
        since = 0 if args.days <= 0 else int(time.time() * 1000) - args.days * 86400000
        rows = rank_sessions(con, since, args.sort, args.limit)
        print(render_rank(rows, args.days))
        con.close()
        return

    if args.sids:
        try:
            sids = json.loads(args.sids)
        except ValueError:
            sids = []
        if not isinstance(sids, list):
            sids = [sids]
        if not sids:
            sid = latest_session_id(con)
            if sid:
                sids = [sid]
        print(json.dumps(snapshot(con, sids, day0, limits, default_limit), ensure_ascii=False))
        con.close()
        return

    session_id = args.session or stdin_sid or latest_session_id(con)
    if not session_id:
        print("（无活跃会话）")
        con.close()
        return
    m = collect_legacy(con, session_id, day0, limits, default_limit)
    m.update(global_metrics(con, day0))
    m["session_id"] = session_id
    con.close()

    if args.format == "json":
        print(json.dumps(m, ensure_ascii=False, indent=2, default=str))
    elif args.format == "panel":
        print(render_panel(m))
    elif args.format == "tail":
        print(render_tail(m))
    else:
        print(render_statusline(m))


if __name__ == "__main__":
    main()
