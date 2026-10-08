# dsh-ccswitch

在 DeepSeek Harness（DSH）中直接使用 [CC Switch](https://github.com/farion1231/cc-switch) 已配置的 Claude、Codex/GPT 和 Gemini 模型。

插件会自动读取当前设备上的 CC Switch 配置，不需要在 DSH 中重复填写 API key 或登录信息。模型选择器中还会增加模型名称搜索。

支持 macOS、Windows 和 Linux。

## 使用前准备

1. 安装并打开 CC Switch。
2. 在 CC Switch 中添加可用的 provider，并确认模型可以正常使用。
3. 安装 DeepSeek Harness。

## 安装插件

macOS、Windows PowerShell 和 Linux 都可以执行：

```bash
dsh plugin --profile web add github:upJiang/dsh-ccswitch
```

安装完成后重启 DSH。前台运行时先按 `Ctrl+C` 停止，再重新启动：

```bash
dsh web --host 127.0.0.1 --port 3080
```

重新打开或刷新 DSH 页面后，就可以在模型选择器中看到 CC Switch 的 provider 和模型。

## 选择模型

打开 DSH 的模型选择器：

1. 找到名称以 CC Switch provider 显示的模型分组。
2. 直接选择需要的模型。
3. 模型较多时，在顶部的“搜索模型”输入框中输入模型名称。

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

如果在 CC Switch 中使用了自定义数据目录、便携目录或同步盘，需要告诉插件数据库的位置。

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
4. 是否配置了错误的 `ccswitch-providers.json` 筛选条件。
5. 使用自定义 CC Switch 目录时，`DSH_CCSWITCH_DB` 是否指向正确的 `cc-switch.db` 文件。

如果市场提示 `@google/genai` 或 `protobufjs` 的构建脚本被 pnpm 拦截，请更新到 `dsh-ccswitch` `0.1.1` 或更高版本后重新安装。新版会使用 DSH 已提供的运行时依赖，不需要为这两个包单独放行构建脚本。

## 版本兼容

`dsh-ccswitch` `0.2.0` 针对 DeepSeek Harness `0.2.0-rc.2` 构建，依赖 `@deepseek-ai/dsh-llm`、`dsh-attachment`、`dsh-brand`、`dsh-fs`、`dsh-timeout` 的 `0.2.0-rc.2`，以及 `@earendil-works/pi-ai` `^0.87.1`。

- DSH `0.2.0-rc.2` 及后续 `0.2.x`：使用本版本。
- DSH `0.1.x`（含 `0.1.0-rc.7`）：请继续使用 `dsh-ccswitch` `0.1.1`，本版本不向下兼容。

这一版随 DSH 0.2 的类型变更同步了适配层：工具调用 ID 改用 `ToolCallId`，消息模型区分 `role: 'tool'` 的独立工具结果消息，请求上下文改用 `TranscriptContext`，并接入了 DSH 的流空闲超时看门狗与图片请求预算（超限时按 DSH 的 `IMAGE_OFFLOAD_REQUIRED` 语义报错）。

发图给模型时，插件会像官方 `dsh-llm-pi-ai` 一样把归一化后的只读路径一并交给模型：优先通过 `ctx.fs.processPathFromHostPath` 映射成当前执行世界的路径，映射不到则退回不带路径的说明文本。`dsh-fs` 是可选服务，缺失时功能降级但不报错。

模型选择面板的结构在 DSH 0.2 也变了：模型列表本身成为 `role="menu"` 的滚动容器，分组 `section` 是它的直接子节点。插件已按新结构适配；此外 DSH 0.2 在 provider 的模型数超过 4 个时会自带搜索框，此时插件不会再插入第二个搜索框。
