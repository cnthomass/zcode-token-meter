# 发布指引（PUBLISH）

本插件已按 ZCode 插件规范打包（`.zcode-plugin/plugin.json` + 根级 `marketplace.json`），
本地测试市场开箱即用；发布到公开市场需要以下人工步骤（对外发布，需仓库/市场账号，工具不代办）。

## 0. 发布前自检

```bash
python -c "import json; json.load(open('.zcode-plugin/plugin.json', encoding='utf-8')); json.load(open('marketplace.json', encoding='utf-8')); print('manifest OK')"
python engine/usage_engine.py --format panel   # 引擎冒烟
node --check daemon/pump.cjs && node --check daemon/bar.js
```

- [ ] 两个 manifest 的 version 一致
- [ ] 仓库内无密钥/内网地址（现有内容已检查，仅含相对路径与官方文档引用）
- [ ] README 的"已知边界/安全边界"如实（尤其 app.asar 注入机制与升级覆盖问题）

## 1. 推送到公开 Git 仓库

```bash
git init && git add -A && git commit -m "zcode-token-meter v0.2.0"
git remote add origin <你的 GitHub/GitLab 仓库 URL>
git push -u origin main        # push 前按你的 Git 规范确认内容
```

建议加一个 `v0.2.0` tag，市场更新检测通常按 version 字段。

## 2. 分发渠道（二选一或都做）

### A. 自建/团队市场（即时光可用）

ZCode 设置 → 插件 → 添加插件市场 → 粘贴本仓库的**公开 URL**（或团队成员本机路径
`D:\zAutoWork\zcode-token-meter`）→ 安装 zcode-token-meter。
适合部门内推广，无需审核。

### B. 官方精选市场（zcode-plugins-official）

官方精选市场为白名单制，收录需经官方审核。通用路径：

1. 在 ZCode 官方渠道（插件市场页的"提交插件"入口 / 官方 GitHub 组织的 marketplace
   仓库 PR / 官方反馈渠道）找到提交表单或 marketplace 仓库
2. 提交内容：公开仓库 URL + 插件名 + 一句话描述 + 截图（本 README 首图或自截状态条）
3. 审核要点预期：manifest 规范、权限披露、更新机制——本插件有两点需要**主动披露**：
   - 采用 app.asar 注入实现（无官方 statusLine API 所致的社区通行方案），升级 ZCode
     后需重跑安装器；安装器有备份与字节级还原
   - 引擎只读本地 db、不出网、不读凭据（README"安全边界"已写明）

## 3. 版本更新流程

改代码 → 同时 bump `.zcode-plugin/plugin.json` 与 `marketplace.json` 的 version →
commit + tag → 已安装用户在插件市场点"更新"（更新只覆盖插件本体；asar 注入运行时在
`~/.zcode/ztu-statusbar/`，由 `/install-statusbar` 或手动 `install.py` 重新部署）。
