# ZCode Token Meter（zcode-token-meter）—— ZCode Token 用量状态条

在 ZCode **对话窗口底部**显示一条实时状态栏：模型生成速度、上下文占比、本轮/会话/今日
token 用量、缓存命中率、工具调用与错误、子智能体消耗。另提供 `/usage` 会话内查询命令
和 `token-usage` skill（模型可随时回答用量类问题）。

```
⚡42.9 │ 🪟18.2% │ 💬4,751 80% 5次 │ 📊1413万 99% 13轮 115次 │ 🔧118 ●3 │ 📅3.59亿 │ 🤖1685万 │ ⚙
```

单行内联布局，各分段悬停显示完整明细（速度峰值/缓存命中/工具明细 TOP/代码变更等），
⚙ 打开会话面板。数值颜色带档位：速度红<40/黄<70/绿<150/蓝<400/紫≥400，
上下文 ≥50% 变蓝、≥80% 橙、≥90% 红。

## 命名说明（与社区项目的关系）

本插件原名 `zcode-token-usage-statusbar`，与社区开源项目
（gitcode.com/tanranran/zcode-token-usage-statusbar）**重名**，为避免市场冲突改为
`zcode-token-meter`。

两者关系：架构方案（asar 注入 + db 监听 + 渲染端状态条）与统计口径参考了该项目的公开
设计笔记并在其 README 致谢，但**代码为独立实现**（约 1500 行的精简版，无额度/Git/模型
拉取等扩展功能）。二者互斥——同一个人机器装一个即可：两个安装器各自管理自己的注入行，
同时安装会同时挂两条状态条。

运行时目录 `~/.zcode/ztu-statusbar/`（ztu = zcode token usage）与注入协议 `__ztu*`
为内部实现细节，不受本次改名影响，已安装用户无需任何操作。

## 原理

ZCode 没有原生 statusLine / UI 扩展点（已逆向确认：配置 schema 的 `ui` 只有
locale/theme），所以本插件采用与社区实现相同的方案——**app.asar 注入**：

```
app.asar 入口末尾追加一行 dynamic import
  └─→ ~/.zcode/ztu-statusbar/pump.cjs（主进程泵，常驻）
        ├─ fs.watch 监听 ~/.zcode/cli/db（db.sqlite/-wal/-shm 写入）
        │    去抖 300ms · 限频 1500ms · 30s 心跳兜底
        ├─ spawn python usage_engine.py --sids [...]（只读 WAL 模式查库）
        └─ executeJavaScript 注入 bar.js 并按窗口推送快照（mine=本窗焦点会话）
             └─ bar.js：body 级 position:fixed 状态条，rAF 跟随输入框卡片
```

- 数据源：ZCode 自带的 `model_usage` / `turn_usage` / `tool_usage` / `session` 表（只读）。
- 统计口径：input_tokens 已含缓存读取；命中率 = cache_read ÷ input_tokens；
  速度 = 输出 ÷ 生成窗口（含思考请求按 started→completed，思考在首字前流出）；
  上下文 = 最近一次请求 input ÷ 模型窗口；子智能体按 session.parent_id 关联累计。
- 安全边界：任何失败只写日志，不影响宿主；不读凭据，不出网。

## 安装

**方式 A：对话内命令（推荐）** —— 插件安装好后，在任意对话框输入：

```
/install-statusbar
```

模型会执行 `installer/install.py` 完成注入，然后**完全退出并重启 ZCode** 生效。

**方式 B：手动命令行**：

```bash
python installer/install.py                # 自动定位 asar → 部署运行时 → 打补丁
python installer/install.py --status       # 查看状态
python installer/install.py --remove       # 卸载（剥离注入行）
python installer/install.py --asar <path>  # 手动指定 app.asar
python installer/install.py --finish-pending  # asar 被占用时的收尾（先退出 ZCode）
```

首次安装自动备份 `app.asar → app.asar.ztu.bak`；卸载后字节级还原（已验证 SHA256 一致）。
补丁后的入口会用 ZCode 自带 Electron 做 `--check` 语法校验，不过不写入。

### 插件本体安装（skills/命令）

ZCode 设置 → 插件 → 添加插件市场 → 选择本仓库目录（含 `marketplace.json`）→
安装 **zcode-token-meter** → 重启。

## 配置

`~/.zcode/ztu-statusbar/config.json`：

```json
{
  "python_path": "",               // 留空按平台取 python/python3
  "rate_ms": 1500,                 // 查询限频
  "debounce_ms": 300,              // db 写入去抖
  "context_limits": { "glm-5.3": 1000000 },   // 模型上下文窗口覆盖
  "default_context_limit": 200000
}
```

运行时目录 `~/.zcode/ztu-statusbar/` 还会生成：`config.json`（配置）、`pump.log` +
`diag.json`（诊断）、`finish-watch.log`（看门狗日志）与插件运行时文件本体。

bar.js / usage_engine.py 修改后**无需重启**：泵每次拉取都现 spawn 引擎、每 2 秒检查
bar.js 的 mtime 热重载（语法校验通过才载入）；pump.cjs 需重启 ZCode 才加载新版。

bar.js / pump.cjs 修改后无需重启：泵每 2 秒检查 mtime，语法校验通过即热重载
（bar.js 热重载即时生效；pump.cjs 需重启 ZCode 才加载新版）。

## 排障

状态条异常时按顺序看三处（新版泵自带全链路落盘诊断）：

1. `~/.zcode/ztu-statusbar/pump.log` —— 泵启动/注入/引擎调用日志。出现 `bar injected into wc#N` 说明渲染端已注入。
2. `~/.zcode/ztu-statusbar/diag.json` —— 每窗口注入状态、引擎成败计数、渲染端回报（composer 锚点是否找到、最后一次渲染时间、隐藏原因）。`lastRender` 距今几秒内 = 条正在实时刷新。
3. 条显示不出来但注入成功时，窗口右下角会出现**诊断角标**（`⚡ztu …`），写明原因码（noComposer / occluded / no-data…）；点击可临时隐藏，`localStorage.ztuDebug=0` 永久关闭。

历史踩坑（修改代码前必读）：

- **ZCode 自动升级会整体替换 app.asar，注入行随之丢失**（3.17.1 升级时发生过一次）——症状是重启后什么都没有。重跑 `python installer/install.py` 再重启即可。
- Windows 下点 X 关闭 ZCode 只是缩到后台，注入需**完全退出**（托盘退出或任务管理器结束全部 ZCode.exe）。`installer/finish_watch.py` 是退出后自动收尾+重启的看门狗（用完即退，不常驻）。
- Electron ≥25 移除了 `webContents.on('web-contents-created')`，必须用 `app.on(...)`（Electron 44 实测）。
- 泵 spawn 引擎时 stdin 是永不关闭的管道——引擎内严禁无条件 `sys.stdin.read()`（会永久挂起被超时杀掉）。
- GUI 主进程的 console.error 不可见，一切泵日志必须落盘。

## 已知边界

- 数字在**请求完成后**更新（db 落库时机决定），流式生成中不跳动；流式实时速率是后续计划
  （需投影渲染端会话 store，参考实现 turn-stats.js 的做法）。
- 「回答末尾速率行」未实现——hooks 的 additionalContext 只进模型上下文不可见，可见的
  速率行需要渲染端扫描消息流 DOM，同样留作后续。
- 多窗口：每窗口显示自己的焦点会话（经客户端自带 IPC 通道旁听）；远端工作区（ssh/wsl）
  的会话不在本机库中，显示零值。
- ZCode 升级会覆盖 app.asar，注入行丢失 → 重新跑一次安装即可（运行时目录不受影响）。

## 文件结构

```
.zcode-plugin/plugin.json     插件清单（skills + commands）
skills/token-usage/           用量问答 skill（触发词：token/速度/上下文/用量）
commands/usage.md             /usage 命令
commands/install-statusbar.md /install-statusbar 命令（调安装器）
daemon/pump.cjs               主进程泵（被 asar 注入行动态 import）
daemon/bar.js                 渲染端状态条（含诊断角标）
engine/usage_engine.py        统计引擎（标准库单文件，也是 skill 的查询后端）
installer/install.py          asar 定位/备份/补丁/卸载/自检
installer/finish_watch.py     退出后自动收尾+重启的看门狗（一次性）
marketplace.json              本地插件市场目录（source: "./"）
docs/PUBLISH.md               发布到插件市场的操作指引
LICENSE                       MIT
```

## 致谢

架构与踩坑收敛参考了 gitcode.com/tanranran/zcode-token-usage-statusbar（MIT）的
设计笔记，统计口径与其保持一致。
