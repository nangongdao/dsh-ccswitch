# dsh-ccswitch

在 DeepSeek Harness（DSH）中直接使用 [CC Switch](https://github.com/farion1231/cc-switch) 已配置的 Claude、Codex/GPT 和 Gemini 模型。

插件会自动读取当前设备上的 CC Switch 配置，不需要在 DSH 中重复填写 API key 或登录信息。模型选择器中还会增加模型名称搜索。

支持 macOS、Windows 和 Linux。

## 使用前准备

1. 安装并打开 CC Switch。
2. 在 CC Switch 中添加可用的 provider，并确认模型可以正常使用。
3. 安装 DeepSeek Harness。

## 安装插件

### DSH 桌面版（Windows / macOS）

打开 DSH 左侧的「插件」页面，使用安装入口填写：

```text
github:nangongdao/dsh-ccswitch
```

安装后确认 `dsh-ccswitch` 已启用。当前桌面安装页注明暂不支持自动更新：已安装旧版时，先在插件页卸载 `dsh-ccswitch`，再安装同一来源。桌面版的 `desktop` profile 由 Electron 应用管理；不要执行 `dsh plugin --profile desktop add ...`，当前 DSH 会拒绝这个命令。

### 命令行 Web 版（macOS / Windows PowerShell / Linux）

```bash
dsh plugin --profile web add github:nangongdao/dsh-ccswitch
```

`--profile` 必须和 `dsh web` 实际使用的 profile 一致。前台运行时按 `Ctrl+C` 停止后重新启动：

```bash
dsh web --host 127.0.0.1 --port 3080
```

### 安装后

安装并启用后，**完整退出并重新启动 DSH 桌面应用**，尤其是升级旧版时；仅刷新浏览器页面不会清除宿主缓存中的旧插件代码。Web 版则停止并重新启动 `dsh web`。然后打开模型选择器，应当看到名称以 `CC Switch · Claude ·`、`CC Switch · Codex ·` 或 `CC Switch · Gemini ·` 开头的分组，而不是一个统一叫「CC Switch provider」的分组。

## 选择模型

打开 DSH 的模型选择器：

1. 如果皮肤只显示少量快捷模型，先点击「更多模型」打开完整目录。
2. 找到名称以 `CC Switch ·` 开头的分组；后面是应用类型和原 CC Switch provider 名称。
3. 选择需要的模型。模型较多时，可以使用“搜索模型”输入框筛选。

例如 `CC Switch · Codex · 我的线路`。每条 CC Switch 路由独立成组，不会合并成单一 provider。

插件会自动读取 CC Switch 后续的配置变化。添加、删除或修改 provider 后，通常不需要重新安装插件。

## 只显示部分 provider

默认显示 CC Switch 中所有可用 provider。如果只想使用其中一部分，可以创建配置文件。

macOS/Linux：

```text
~/.dsh/ccswitch-providers.json
```

Windows：

```text
%USERPROFILE%\.dsh\ccswitch-providers.json
```

文件内容：

```json
{
  "include": [
    "my-codex-provider",
    "ccswitch/claude/*"
  ]
}
```

可以填写 CC Switch 中显示的 provider 名称，也可以使用 `*` 通配符。保存文件后，DSH 会自动刷新可用模型。

## CC Switch 使用了自定义目录

正常情况下不需要设置路径，插件会自动查找当前用户的 CC Switch 数据库。

如果 CC Switch 是通过「设置 → 数据目录」改到了别处（例如 `D:\.cc-switch`），也不需要手工配置：插件会读取 CC Switch 自己写下的 `app_paths.json`，跟随其中的 `app_config_dir_override` 去找 `cc-switch.db`。该文件位于：

- Windows：`%APPDATA%\com.ccswitch.desktop\app_paths.json`
- macOS：`~/Library/Application Support/com.ccswitch.desktop/app_paths.json`
- Linux：`~/.config/com.ccswitch.desktop/app_paths.json`

只有当这个目录已经不存在（CC Switch 自身也会回退到默认目录）或该文件不可读时，插件才回退到 `~/.cc-switch/cc-switch.db`。

仍然可以用环境变量直接指定数据库，此时插件不再读取上述文件，该值优先级最高：

macOS/Linux：

```bash
DSH_CCSWITCH_DB='/path/to/cc-switch.db' \
  dsh web --host 127.0.0.1 --port 3080
```

Windows PowerShell：

```powershell
$env:DSH_CCSWITCH_DB = 'D:\path\to\cc-switch.db'
dsh web --host 127.0.0.1 --port 3080
```

## 在多台设备上使用

在每台设备上分别安装 CC Switch、DSH 和本插件即可。

- Mac 会读取 Mac 上的 CC Switch 配置；
- Windows 会读取 Windows 上的 CC Switch 配置；
- 两台设备可以使用不同的 provider 和模型；
- 插件不会在设备之间同步数据库、API key 或登录信息。

## 没有看到模型

按顺序检查：

1. CC Switch 中是否已经添加并启用了 provider。
2. CC Switch 中的模型是否可以正常请求。
3. 安装插件后是否重启并刷新了 DSH。
4. 桌面版是否在当前 DSH 的「插件」页面安装且已启用；Web 版的 `--profile` 是否与实际启动时一致。
5. 是否配置了错误的 `ccswitch-providers.json` 筛选条件。
6. 使用自定义 CC Switch 目录时，确认 CC Switch 中的「数据目录」仍然存在；仍看不到模型时，用 `DSH_CCSWITCH_DB` 显式指向正确的 `cc-switch.db` 文件（见上一节）。

如果市场提示 `@google/genai` 或 `protobufjs` 的构建脚本被 pnpm 拦截，请更新到 `dsh-ccswitch` `0.1.1` 或更高版本后重新安装。新版会使用 DSH 已提供的运行时依赖，不需要为这两个包单独放行构建脚本。

## 版本兼容

`dsh-ccswitch` `0.2.2` 针对 DeepSeek Harness `0.2.0-rc.2` 构建，依赖 `@deepseek-ai/dsh-llm`、`dsh-attachment`、`dsh-brand`、`dsh-fs`、`dsh-timeout` 的 `0.2.0-rc.2`，以及 `@earendil-works/pi-ai` `^0.87.1`。

- DSH `0.2.0-rc.2` 及后续 `0.2.x`：使用本版本。
- DSH `0.1.x`（含 `0.1.0-rc.7`）：请继续使用 `dsh-ccswitch` `0.1.1`，本版本不向下兼容。

`0.2.2` 为每个 provider 分组增加 `CC Switch · 应用 · 原名称` 标识；修复同一路由的模型/名称更新和端点模型发现后未通知 DSH 刷新目录的问题，并纠正桌面版安装说明。

`0.2.1` 修复了 CC Switch 使用自定义数据目录时看不到 provider 的问题：插件会读取 CC Switch 的 `app_paths.json` 跟随实际数据目录，不再只认 `~/.cc-switch`。

这一版随 DSH 0.2 的类型变更同步了适配层：工具调用 ID 改用 `ToolCallId`，消息模型区分 `role: 'tool'` 的独立工具结果消息，请求上下文改用 `TranscriptContext`，并接入了 DSH 的流空闲超时看门狗与图片请求预算（超限时按 DSH 的 `IMAGE_OFFLOAD_REQUIRED` 语义报错）。

发图给模型时，插件会像官方 `dsh-llm-pi-ai` 一样把归一化后的只读路径一并交给模型：优先通过 `ctx.fs.processPathFromHostPath` 映射成当前执行世界的路径，映射不到则退回不带路径的说明文本。`dsh-fs` 是可选服务，缺失时功能降级但不报错。

模型选择面板的结构在 DSH 0.2 也变了：模型列表本身成为 `role="menu"` 的滚动容器，分组 `section` 是它的直接子节点。插件已按新结构适配；此外 DSH 0.2 在 provider 的模型数超过 4 个时会自带搜索框，此时插件不会再插入第二个搜索框。
