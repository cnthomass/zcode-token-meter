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

实测机制（2026-11）：目录托管在 Z.ai 官方 CDN
`https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json`（应用内置该 URL），
当前 52 个插件 = 官方 43 + **社区/第三方 9**（TencentCloudBase、Mimosa、luochang212、
Deemos、VAST 等，个人作者有收录先例）。社区插件的收录形态：官方把插件打包成 zip
托管到其 CDN（`plugins/<名>/<版本>/plugin.zip` + sha256 + icon 一并托管），
**即收录 = 官方代为托管分发**。商店 UI 无自助提交入口，需走官方渠道申请：

1. 准备材料：公开仓库 URL + 双语 displayName/description + 截图 + 权限披露（见下）
2. 通过 Z.ai 官方渠道提交申请：智谱开放平台（bigmodel.cn）工单/反馈、ZCode 应用内
   反馈入口、或你所在企业的 Z.ai 对接人
3. 审核通过后官方会索要插件包（可从仓库打包）并托管上架；后续版本更新同样经官方同步
4. 需要主动披露的两点：app.asar 注入方案（无官方 statusLine API 所致的社区通行做法，
   升级 ZCode 后需重跑安装器，有备份与字节级还原）；引擎只读本地 db、不出网、不读凭据

> 不建议投 anthropics/claude-plugins-official（GitHub 仓库、接受社区 PR）：本插件的
> 统计引擎依赖 ZCode 本地 db，对纯 Claude Code 用户无数据，投了也是无效收录。

## 3. 版本更新流程

改代码 → 同时 bump `.zcode-plugin/plugin.json` 与 `marketplace.json` 的 version →
commit + tag → 已安装用户在插件市场点"更新"（更新只覆盖插件本体；asar 注入运行时在
`~/.zcode/ztu-statusbar/`，由 `/install-statusbar` 或手动 `install.py` 重新部署）。
