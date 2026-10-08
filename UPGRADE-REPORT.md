# dsh-ccswitch 0.2.2：安装与目录可见性验收

验收日期：2026-10-08。发布来源：`github:nangongdao/dsh-ccswitch`。

## 兼容目标

重新查询官方 `@deepseek-ai/dsh` npm dist-tags，`latest` 与 `next` 均为 `0.2.0-rc.2`，`alpha` 为 `0.2.1-alpha.1`。本版本对齐当前默认发行版 `0.2.0-rc.2`；不把实验 alpha 当成已验收版本。

## 本次修复

- 每条路由的分组名称改为 `CC Switch · Claude/Codex/Gemini · 原 provider 名称`，保持原 provider ID 和筛选名称不变。
- 同一路由的模型、名称变化以及端点模型发现变化时，重新发布注册，使 DSH 的模型目录缓存失效。没有变化时不重复通知。
- 继续保留 0.2.1 的 CC Switch 自定义数据目录自动发现。
- 桌面版通过实际插件页安装和启用；更新后需完整退出并重新启动应用。仅刷新浏览器不会清除宿主中的旧 Node 模块。

实现提交：`6609d74`。完整重启说明提交：`bb0a949`。两者已在 `origin/main`。

## 独立验收结果

- `pnpm test`：73 个测试通过，0 个失败。
- `pnpm typecheck`、`pnpm build`：均退出 0。
- 真实 Cordis/LlmRuntime + SQLite 集成测试验证初始注册、生命周期、数据库后到、同路由变动通知、无变化不重复通知及目录恢复。
- 实际 desktop 安装版本：0.2.2。插件页的「启用 dsh-ccswitch」开关为开启。
- 安装目录中的 `lib/index.mjs`、`lib/index.d.mts`、`lib/client.js`、`lib/client.js.map` 均与本次构建相同（归一化 Git 换行差异）。
- 重启后的宿主快照包含 82 个 CC Switch 分组、475 个模型，0 个 catalog 错误；全部分组带来源前缀。模型数量会随端点发现与 CC Switch 配置变化。
- 在实际 GUI `http://127.0.0.1:19387/` 打开模型菜单，再点击「更多模型」；浏览器断言确认 CC Switch 前缀可见，完整目录 DOM 中存在 82 个 CC Switch 分组标签。这里没有一个统一命名为「CC Switch provider」的分组，而是每条线路独立分组。
- 移除了临时诊断 patch，并删除临时授权 URL 及包含授权 URL 的验收脚本。未改变用户默认模型。

本次没有发送模型生成请求；安装与目录可见性通过，并不代表所有线路凭据和端点都可正常调用。截图已捕获，但由于验收模型不支持图像读取，未作图片视觉审核；可见性结论依据浏览器 locator/DOM 断言。

## 安装方式

DSH 桌面版打开「插件」→ 安装，填写 `github:nangongdao/dsh-ccswitch`。已安装旧版时先卸载，再从同一来源安装并启用。完整退出并重启 DSH 后，在模型菜单中点击「更多模型」，查找 `CC Switch ·` 分组。

命令行 Web 版：`dsh plugin --profile web add github:nangongdao/dsh-ccswitch`，然后停止并重新启动同一 profile 的 `dsh web`。

详细记录见 [UPGRADE-PLAN.md](UPGRADE-PLAN.md)，日常安装说明见 [README.md](README.md)。
