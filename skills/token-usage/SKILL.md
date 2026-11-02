---
name: token-usage
description: "ZCode token 用量/速度统计查询。当用户问「用了多少 token、生成速度多快、上下文还剩多少、缓存命中率、今日用量、子智能体消耗」等任何与模型用量/速度/上下文相关的问题时使用——即使没有明确说“统计”二字。也用于展示会话用量明细面板。"
---

# Token 用量查询

用统计引擎查询 ZCode 本地数据库（只读，不影响正在运行的客户端）：

```bash
python "<插件根>/engine/usage_engine.py" --format panel
```

- `<插件根>` = 本 SKILL.md 所在仓库的插件目录（engine 的上一级）。
- 数据源：`~/.zcode/cli/db/db.sqlite`，查询最近活跃会话；可用 `--session session_xxx` 指定会话。

## 输出格式选择

- 用户想看「明细/面板/统计」→ `--format panel`（多行人类可读明细），把输出原样贴在代码块里返回。
- 用户问「速度快不快/这轮用了多少/还剩多少上下文」等单一问题 → `--format json` 取需要的字段，用一两句话直接回答，不要贴全量面板。
- 用户想要「速率行/加在回答末尾」→ `--format tail`，单行输出原样引用。
- 用户想看「排行榜/所有会话/今天的全部会话」→ 用 sqlite3 只读查询 model_usage 表按 session_id 聚合（参考 engine 源码里的 SQL），或告知当前版本暂只支持会话级查询。

## 回答口径（来自统计引擎，勿自行估算）

- input_tokens 已含缓存读取；缓存命中率 = cache_read ÷ input_tokens。
- 速度 = 输出 token ÷ 生成窗口；含思考的请求按 started→completed 计（思考在首字前流出）。
- 上下文占比 = 最近一次请求 input ÷ 模型窗口（GLM-5.3 系按 100 万，可配 `~/.zcode/ztu-statusbar/config.json` 的 context_limits）。
- 子智能体消耗按 session.parent_id 关联的子会话（query_source='subagent'）累计。

## 底部状态条

若用户问的是「状态条没显示/怎么卸载/怎么配置」，读本插件 README.md 对应章节回答；重装/修复状态条运行 `python "<插件根>/installer/install.py"`，卸载加 `--remove`（需重启 ZCode 生效）。
