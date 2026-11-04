---
description: 查询当前会话的 token 用量、生成速度、上下文占比明细
argument-hint: "[可选：rank 排行 / today 查今日 / tail 只要速率行 / <session_id> 指定会话]"
skills: token-usage
---

用 token-usage skill 的统计引擎查询用量并展示。

默认：运行 `python "<插件根>/engine/usage_engine.py" --format panel`，把面板输出放在代码块里返回。

参数规则：

- 参数含 `rank` 或 `排行` → 运行 `--format rank`（Markdown 排行表）。支持 `30天`/`全部`、
  `按输入`、`按请求` 等修饰：映射为 `--days N`（0=全部）、`--sort tin|total|reqs|recent`。
  用户想要「图表/可视化」时，改用引擎 JSON（`--format json` 无排行，用 `--format rank` 的
  数据或直接调 `rank_sessions`）配合 visualize 技能渲染内联排行卡（今日/近 7 天双 Tab）。
- 参数为 `today` → 额外执行 `--format json` 并汇总「今日合计」段（今日输入/输出/请求数/会话数/子智能体）。
- 参数为 `tail` → 改用 `--format tail`，只返回单行速率行。
- 参数是 `session_` 或 `sess_` 开头的会话 id → 加 `--session <id>` 查指定会话。
- 其他参数当作自然语言问题，按 skill 的「输出格式选择」回答。

$ARGUMENTS
