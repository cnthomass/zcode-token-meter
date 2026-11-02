---
description: 安装/修复/卸载对话窗口底部的 Token 状态条（需重启 ZCode 生效）
argument-hint: "[可选：remove 卸载 / status 查看状态]"
---

帮用户管理 Token 状态条的 app.asar 注入。步骤：

1. 定位插件根目录：优先用环境变量 `ZCODE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT`；否则用本命令文件所在插件的仓库路径。安装器在 `<插件根>/installer/install.py`。
2. 按参数执行（无参数 = 安装/更新）：

```bash
# 安装/更新（自动定位 asar → 部署运行时到 ~/.zcode/ztu-statusbar → 打补丁）
python "<插件根>/installer/install.py"

# 查看状态
python "<插件根>/installer/install.py" --status

# 卸载（剥离注入行，保留备份）
python "<插件根>/installer/install.py" --remove
```

3. 找不到 asar 时，用 `--asar` 指定（Windows 常见位置：`%LOCALAPPDATA%\Programs\zcode\resources\app.asar`，或自定义安装盘符下的 `zTool\zCode\resources\app.asar`）。
4. 向用户转述安装器输出。无论安装还是卸载，必须提醒：**完全退出并重启 ZCode 后生效**（注入行在客户端启动时加载）。首次安装会自动备份 app.asar 为 app.asar.ztu.bak。
5. 若安装器提示 asar 被占用（.tmp 待替换），告知用户退出 ZCode 后运行 `python "<插件根>/installer/install.py" --finish-pending` 完成收尾。

$ARGUMENTS
