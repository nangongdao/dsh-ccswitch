# dsh-ccswitch → DSH 0.2.0-rc.2 升级记录

> 工作日志：每完成一个切片追加一节，体例 `Observed / Modified / Tested / Verified / Not verified`。

## 目标

把 `E:\dsh-ccswitch`（当前 v0.1.1，目标 DSH 0.1.0-rc.7 / pi-ai 0.82.1）
升级到运行中的最新 DSH **0.2.0-rc.2**（pi-ai **0.87.1**）：
依赖版本同步 + 破坏性 API 迁移 + `typecheck` / `test` / `build` 全绿 + README/CI 同步。

## 基线（升级前，已实测）

- `pnpm install` 成功（166 包）；`pnpm typecheck` EXIT=0；`pnpm test` 11/11 pass。
- 仓库 `E:\dsh-ccswitch`，branch main，origin github.com/nangongdao/dsh-ccswitch.git。

## 关键勘察结论

1. **本插件是官方 `@deepseek-ai/dsh-llm-pi-ai` 的裁剪 fork**：模块注释、类名
   （`PiAiAdapter` 同构）、replay/context/stream/adapter 逐行对应。
   因此**迁移的参照物 = 官方 0.2.0-rc.2 实现**，已切到 `.scratch-api/official/*.txt`。
2. 官方参考 bundle：`E:\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-llm-pi-ai\lib\index.js`
   （2639 行，`//#region lib/types/*.js` 分节）。
3. 新版**有 .d.ts**（`E:\DSH Desktop\resources\app\node_modules` 那份没有 dts 只是发行时剥掉了）。
   类型参照：`.scratch-api/node_modules/@deepseek-ai/dsh-llm/lib/types/*.d.ts`。

## 破坏性变更清单（dsh-llm 0.2.0-rc.2）

| # | 变更 | 影响文件 |
|---|---|---|
| 1 | `CallId` → `ToolCallId`；新增 `MessageId`/`LlmAttemptId`；官方改用 `brandString()`（`@deepseek-ai/dsh-brand`） | stream.ts / context.ts |
| 2 | **消息模型重构**：新增 `role:'developer'`、`role:'tool'`（`ToolResultMessage`）；tool-result 不再是 user 消息内的 block；`MessageSourceMap` 去掉 plugin kind | context.ts / replay.ts |
| 3 | **ContentBlock 新类型**：`file`、`tool-addition`、`tool-removal`；`ImageBlock.offloaded?: true` | context.ts |
| 4 | `GenerateOptions.messages: RequestMessage[]`（可含 `RequestUserInput`）；新增 `toolHistory`/`systemPromptUpdate`/`toolUpdate`/`ToolSchema.deferLoading`；`TokenUsage.totalTokens` | context.ts / stream.ts |
| 5 | `content.d.ts` 642B→9419B：`contentHasImage` **不再递归**；新增 `contentHasFile`、`requestImageHandleText`、`offloadedImageText`、`projectOffloadedImages`、`requiredImageOffload`、`resolveImageAttachmentAccess` | context.ts / adapter.ts |
| 6 | `error.d.ts` 新增 `IMAGE_OFFLOAD_REQUIRED_CODE` | context.ts |
| 7 | `LlmAdapter` 新增 `prepareCall` / `providerRetryPolicy` / `imageRequestPricing`；`LlmRuntime` 新增 `listConfigurableProviders` 等 | adapter.ts |
| 8 | **pi-ai 0.87.1**：`isContextOverflow` 移到 `@earendil-works/pi-ai/utils/overflow`；`StopReason` 新增 `pending`/`deferred`；`ApiKeyAuth` 从 `./auth/types.ts` 经根 index 聚合导出（仍可根导入） | stream.ts / provider.ts |
| 9 | **dsh-attachment 0.2.0-rc.2**：新增 `readImageRequest(ref, target, signal)`（请求投影入口）、`requestImageDimensions`；`AttachmentStore` 变 abstract class extends Service | context.ts / adapter.ts |

## 迁移切片

- [x] S1 依赖版本：package.json peer/dev、pnpm-workspace.yaml、CI
- [x] S2 `src/stream.ts`：totalTokens / 413 / pending+deferred / `toStreamChunks(events, cw, callerSignal, requestedModel)` / `ToolCallId`
- [x] S3 `src/replay.ts`：`toPiReplayState(message, requestedModel?)` / `providerThinkingLevel` / `source.replayState` 判定 / 去掉 `kind==='model'` 前置
- [x] S4 `src/context.ts`：`assertSupportedHistory` / `splitSystemPrompt` / `toolResultOf`(role:'tool') / image 双块 + offload / `deferLoading`
- [x] S5 `src/adapter.ts`：`prepareCall` / idle watchdog / image request policy / `describableReasoningLevel`
- [x] S6 `src/provider.ts` + `types.ts`：`google-generative-ai` 保留、auth 收敛
- [x] S6b `src/gemini-oauth.ts`：`TranscriptContext` / `JsonObject` / `pending` 终态
- [x] S7 `test/`：新增/更新测试覆盖 tool-role、image offload、pending/deferred
- [x] S8 `README.md`：版本与行为说明同步
- [x] S9 全绿验证：install / typecheck / test / build

---

## S1 依赖版本

- **Observed**：peerDependencies+devDependencies 各 5 条 @deepseek-ai/@earendil-works；旧值为
  cordis `^4.0.1`、dsh-attachment/dsh-brand/dsh-llm `^0.1.0-rc.7`、pi-ai `^0.82.1`（dev 锁 `0.82.1`）。
- **Modified**：version 0.1.1 → **0.2.0**；peer/dev 各改为 cordis `^4.0.4`、dsh-attachment/dsh-brand/dsh-llm
  `0.2.0-rc.2`、**新增 dsh-timeout `0.2.0-rc.2`**、pi-ai peer `^0.87.1` / dev `0.87.1`；
  新增 `dsh.compatibility.dshReleases = {"0.2.0-rc.2": "compatible"}`。
- **Tested**：`pnpm install` 成功（Packages +47 -47，13s）。
- **Verified**：`node_modules` 内实际落地 cordis 4.0.4、dsh-attachment/dsh-brand/dsh-llm/dsh-timeout 0.2.0-rc.2、pi-ai 0.87.1。
- **Not verified**：pnpm-workspace.yaml 与 CI 无需改动（Node 22.20.0 ≥ engines 22.19.0）。

## S2 src/stream.ts

- **Observed**：`mapUsage` 无 totalTokens；`classifyPiAiError` 无 413 分支；`mapStopReason` 无 pending/deferred；
  `toStreamChunks` 仅两参；tool id 用已删除的 `CallId(...)`。
- **Modified**：加 `totalTokens`；400 分支前插 413/body-too-large → `INVALID_REQUEST`；
  新增 `pending` → PI_AI_ERROR、`deferred` → PI_AI_ERROR；签名加 `callerSignal` / `requestedModel`；
  `CallId(...)` → `ToolCallId(...)`；done 分支把 `requestedModel` 传给 `toPiReplayState`；
  error 分支在 caller 已取消时改写为 `stopReason:'aborted'`。
- **Tested**：`test/stream.test.js` 10 tests。
- **Verified**：`pnpm test` 全绿；`pnpm typecheck` EXIT=0。
- **Not verified**：无。

## S3 src/replay.ts

- **Observed**：`toPiReplayState` 单参、response 无 `providerThinkingLevel`；`foreignAssistant` 判 `source.kind`。
- **Modified**：`toPiReplayState(message, requestedModel = message.model)`；response 增加 `providerThinkingLevel`
  （`readReplayState` 校验其为 string）；`foreignAssistant` 直接取 `message.source`（不再判 kind，也不再回退 `'dsh-foreign'`）；
  `toPiAssistant` 只在 `source.replayState === undefined` 时降级；`parseArguments` 返回 `JsonObject`。
- **Tested**：`test/replay.test.js` 12 tests（含 model 不匹配/块数漂移/畸形 envelope/未知 stopReason 的降级路径）。
- **Verified**：`pnpm test` 全绿。
- **Not verified**：无。

## S4 src/context.ts

- **Observed**：旧实现从 user 消息的 block 里拆 `tool-result`、用 `attachments.readImage`、无 offload 预算。
- **Modified**：全量重写。`role:'tool'` 独立消息 → `toolResultOf()`；`assertSupportedHistory` 拒绝 developer、
  tool-addition/tool-removal、in-history 非 user/tool 图片；`splitSystemPrompt`；`toolsOf` 拒绝 `deferLoading`；
  图片走 `prepareRequestImages` + `readImageRequest`，转 `requestImageHandleText` + inline base64；
  超预算抛 `IMAGE_OFFLOAD_REQUIRED`（带 `failure.offloadImages`）；已 offloaded 图片转 `offloadedImageText` 占位。
  导出签名改为 `toPiContext(options, images: PiAiRequestImages, onReplayDegrade?)`。
- **Tested**：`test/context.test.js` 10 tests。
- **Verified**：`pnpm test` 全绿。
- **Not verified**：无。

## S5 src/adapter.ts

- **Observed**：无 `prepareCall`、无 idle watchdog、图片直接用旧 API。
- **Modified**：新增 `STREAM_IDLE_TIMEOUT_MS=300_000` 与图片预算常量；`describableReasoningLevel`（描述路径不抛，
  避免一个坏配置隐藏整条 route）；`resolveReasoningLevel` 不再排除 `'off'`；
  `prepareCall` 冻结快照（`Models.streamSimple` 惰性解析，会在 credential await 之后才取 provider）；
  `streamWithSnapshot` 接入 `idleWatchdog` + `timeoutOf`，超时 → `TIMEOUT`、caller 取消 → `ABORTED`。
  `listModels`/`resolveModel`/`prepareCall` 改为 `Promise.resolve().then(...)` 延迟求值（与官方一致：
  catalog 未命中应 reject 返回的 promise，而不是在调用点同步抛出）。
- **Tested**：`test/adapter.test.js` 12 tests（含快照冻结、discovered 模型覆盖、各拒绝路径）。
- **Verified**：`pnpm test` 全绿。
- **Not verified**：无。

## S6 provider/types + gemini-oauth

- **Observed**：`provider.ts`/`types.ts` 与 0.2.0-rc.2 契约一致，无需改动（`google-generative-ai` 分支在 pi-ai
  0.87.1 仍有 lazy 导出；`CODEX_THINKING_LEVELS` 与 `ModelThinkingLevel` 集合一致）。
  `gemini-oauth.ts` **此前误判为无需改动**：pi-ai 0.87.1 的 `Context` 加了 `transcriptContextBrand`，
  且 `ToolCall.arguments` 收紧为 `JsonObject`。
- **Modified**：`gemini-oauth.ts` 改用 `TranscriptContext` + `getCurrentTools`/`getInitialSystemMessage`/
  `getSystemMessageText`；`GeminiPart.functionCall.args?: JsonObject`；`createOutput` 初始 `stopReason: 'pending'`，
  结束仍是 pending 时抛 `Gemini OAuth stream ended without a finish reason`。
- **Tested**：`pnpm typecheck` EXIT=0。
- **Verified**：`pnpm build` EXIT=0。
- **Not verified**：未对真实 Gemini OAuth 端点做端到端请求（需要用户凭据）。

## S7 测试

- **Observed**：原有 4 个测试文件 11 tests，未覆盖新契约。
- **Modified**：新增 `test/stream.test.js`（10）、`test/context.test.js`（10）、`test/replay.test.js`（12）、
  `test/adapter.test.js`（12）；`test/client-search.test.js` 增加 3 个针对 DSH 0.2 新面板结构的用例。
- **Tested**：`pnpm test` → **60 tests / 60 pass / 0 fail**，EXIT=0。
- **Verified**：同上。
- **Not verified**：无。

## S7b 客户端模型搜索（新增破坏面）

- **Observed**：DSH 0.2.0-rc.2 的 `@deepseek-ai/dsh-client-ui-model-selection` 改了模型面板 DOM：
  模型列表本身即 `role="menu"` 的滚动容器（`id="<id>-models"`），分组 `section[role="group"][data-menu-group]`
  是它的**直接子节点**；旧版是 `[role="menu"]` 里再套一层 `.groups` 容器。
  旧 `findModelGroups` 要求 `container !== menu`，因此在 0.2 上**返回 null，搜索框完全不挂载**（已用 jsdom
  夹具复现并断言失败）。
  另外 0.2 在 provider 模型数 > 4 时会自带 `input[role="searchbox"]`（`:546 const showSearch = choices.length > 4`），
  会与插件注入的搜索框争抢同一批 `hidden` 标记。
- **Modified**：`src/client/search.ts` 的 `findModelGroups` 先判断 `directGroups(menu)` 是否直接含模型项
  （命中则 `return menu`），否则回退旧结构；新增 `hasNativeSearch(menu)`（查 `menu.parentElement` 下的
  `input[role="searchbox"]`），`installModelSearch` 在存在原生搜索框时跳过注入。
- **Tested**：`test/client-search.test.js` 8 tests 全绿，含三个新用例（新面板结构下可挂载并过滤；有原生搜索框时不注入；
  面板随后长出原生搜索框时已注入的搜索框自动撤下）。
- **Verified**：`pnpm test` 60/60、`pnpm typecheck` EXIT=0、`pnpm build` EXIT=0。
- **Not verified**：未在真实浏览器里对 DSH 0.2.0-rc.2 的模型面板做端到端点击验证（jsdom 夹具按源码结构复刻）。

## S7c 图片只读路径（resolveImageAccess，新增破坏面）

- **Observed**：官方 `dsh-llm-pi-ai@0.2.0-rc.2`（`lib/index.js:2579-2580`）除 `resolveAttachments: () => ctx.get("attachments")`
  外还接了一条 `resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref)`；
  官方 `peerDependencies` 因此含 `@deepseek-ai/dsh-fs`。本插件原先只传 `attachments`，`src/context.ts:267` 的
  `resolveImageAccess` 默认 `() => undefined`，模型因此拿不到归一化图片的只读路径 —— 图片能发出去，
  但模型无法用文件工具去读原图，属静默能力缺失（不报错，故先前未暴露）。
- **Modified**：`package.json` 的 peer/dev 各新增 `@deepseek-ai/dsh-fs: 0.2.0-rc.2`；
  `src/index.ts` 用 `import type {} from '@deepseek-ai/dsh-fs'` 载入 `ctx.fs` 增强，并在构造适配器时传入
  `(attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref)`；
  `src/adapter.ts` 构造器新增第三个可选参数 `resolveImageAccess`，仅在 `containsImage` 且拿到 attachments 时透传
  （`resolveImageAccess: ref => this.resolveImageAccess?.(attachments, ref)`）。`dsh-fs` 保持**可选**：服务缺失时
  `ctx.get('fs')` 为 undefined，映射返回 undefined，`requestImageHandleText` 退回不带路径的说明文本，与官方降级一致。
- **Tested**：`test/context.test.js` 新增 1 例（解析出的只读路径出现在 handle text 的
  `Normalized copy (read-only; ...)` 段）；`test/adapter.test.js` 新增 1 例（用抛错 resolver 证明适配器把 store 与
  确切 ref 透传到了注入点）。
- **Verified**：`pnpm test` 60/60、`pnpm typecheck` EXIT=0、`pnpm build` EXIT=0；并已确认 `lib/index.mjs` 里
  `processPathFromHostPath` 存在、`dsh-fs` 无运行时残留（`import type` 被完全擦除）。
- **Not verified**：未在真实 DSH 进程里验证 `ctx.fs` 存在时模型确实拿到可用路径（需真实对话与图片附件）。

## S8 README

- **Modified**：新增「版本兼容」一节（第 111 行起），声明 0.2.0 ↔ DSH 0.2.0-rc.2，DSH 0.1.x 继续用 0.1.1，
  并列出迁移要点；补充图片只读路径（`ctx.fs` 可选降级）说明。
- **Verified**：与 package.json 的 `dsh.compatibility` 一致。

## S9 终验

- **Tested**：`pnpm install` EXIT=0；`pnpm typecheck` EXIT=0；`pnpm test` 60/60 EXIT=0；
  `pnpm build` EXIT=0（lib/index.mjs 74.55 kB、lib/client.js 8.50 kB）。
- **Not verified**：未在真实 DSH 0.2.0-rc.2 进程内加载插件并跑一次真实对话（需用户环境与凭据）；
  改由 S10 用真实 DB + 真实网络在进程外补足。

## S10 活体端到端验证（真实 CC Switch DB + 真实网络）

- **Observed**：单测只能模拟 stream 契约，无法证明「真实 provider 的响应经插件映射后仍是合法 chunk」。
  本机存在真实 CC Switch 库（8,957,952 B，121 providers / 109 endpoints，
  app_type 覆盖 claude / claude-desktop / codex / gemini / opencode）。
- **Modified**：无源码改动。新增三个临时脚本（验证后删除）：`.verify-live.mjs`（把 built `lib/index.mjs`
  装进真实 cordis `Context`，stub `llm.registerAdapter` 记录注册结果）、`.verify-stream.mjs`（取真实路由 →
  `resolveCredential` → `prepareCall` → 发真实最小请求）、`.verify-modes.mjs`（text / tool / abort 三模式）。
- **Tested**：
  - **注册面**：81 条路由全部注册成功（authKind `{"claude-token":46,"api-key":35}`、protocol
    `{"anthropic-messages":46,"openai-responses":35}`）；`providerInfo` 返回 `{id, name:"<provider>"}`；
    `listModels` 的 `inputModalities` 为 `["text","image"]`；`resolveModel` 的 `context.contextWindow` = 262144；
    catalog 未命中以 code `NO_ADAPTER` reject —— 证明 `Promise.resolve().then(...)` 的延迟求值语义正确；
    **81/81 路由 resolveModel 全部成功**。
  - **真实网络流**：provider A（openai-responses / gpt-5.5）34758ms → text `"OK"`，
    usage `{"inputTokens":551,"outputTokens":5,"totalTokens":4396,"cacheReadTokens":3840}`，
    finish `{"kind":"stop"}`，并发布 reasoning（efforts minimal/low/medium/high + `defaultEffort:"minimal"`）；
    provider B（anthropic-messages / DeepSeek-V4.1-Flash）2673ms → block-end reasoning，finish `{"kind":"stop"}`；
    provider C 2891ms → finish `{"kind":"max-tokens"}`（证明 length 映射）。
  - **tool-call 路径**：`node .verify-modes.mjs tool <provider A>` → block-start `tool-call`，
    5 个 `tool-call-delta`（id 稳定、arguments 分片拼接），block-end `{type:"tool-call", name:"get_weather",
    arguments:"{\"city\":\"Paris\"}"}`，`JSON.parse` 成功，finish `{"kind":"tool-calls"}`。
  - **abort 路径**：`node .verify-modes.mjs abort <provider B>` → 1207ms 时 caller abort 生效，
    finish `{"kind":"aborted","failure":{"message":"This operation was aborted","code":"ABORTED"}}`，
    watchdog 正常拆除（无悬挂句柄报错）。
  - **错误分类**：522 → `SERVER`；401 "Invalid token" → `AUTH`；503 model_not_found → `SERVER`；
    "OpenAI Responses stream ended before a terminal response event" → `TRANSPORT`。
- **Verified**：上述全部实测通过。失败的探测路由均系外部原因（Cloudflare 522、上游 503 无可用通道、
  401 token 失效），非插件缺陷。
- **Not verified**：未在 DSH Desktop 进程内（经 `dsh plugin` 装载）跑真实对话；未验证图片附件在
  `ctx.fs` 存在时端到端拿到只读路径（S7c）；未对真实 Gemini OAuth 端点发请求（S6b）。
  注：当时本插件**并未安装进 desktop profile**，安装装载验证见 S11。

## S11 仓库发布与安装装载验证

- **Observed**：升级只存在于本地工作区，用户要求「上传到仓库后通过仓库安装」。仓库事实：
  `origin` = `github.com/nangongdao/dsh-ccswitch`（用户 fork，admin+push），
  上游 `upJiang/dsh-ccswitch` 只读（permissions.push=false）且仍停在 0.1.1。
  `package.json` 的 `repository.url` 却写着 `upJiang` —— 按 README 命令安装会拿到旧版。
- **Modified**：
  - 提交两个 commit 并推送 `origin/main`：`8d3f00f`（升级本体，19 files / +2344 −717）、
    `c3a29d8`（元数据修正）。`lib/` 产物已入库，`github:` 安装无需构建步骤。
  - `package.json` 的 `repository`/`homepage`/`bugs` 与 README 安装命令改指 `nangongdao`。
  - **两处先前臆造的清单字段被纠正**（本轮才发现）：
    1. 删除 `dsh.compatibility.dshReleases` —— 全 app 搜索证明该字段**在 DSH 中不存在**；
       真实门禁是 `dsh-app-boot` 的 `evaluatePluginCompatibility()`：对每个
       `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 做
       `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`，
       不兼容则抛 `Plugin <name>@<version> is incompatible with dsh <runtime>` 并拒绝装载；
       豁免机制是 profile 级 `compatibility.json`（精确 `name@version` ↔ 精确 runtime 版本）。
    2. peerDependencies 由精确 `0.2.0-rc.2` 放宽为 `^0.2.0-rc.2`：实测
       `0.2.0-rc.2` 精确范围对 `0.2.0-rc.3` / `0.2.1-alpha.1` 均不满足，
       会让插件在后续 0.2.x 上直接拒绝装载，与 README 承诺矛盾。
- **Tested**：
  - 用官方 `evaluatePluginCompatibility` 直接跑本仓库 manifest：**ISSUE: NONE (compatible)**。
  - 主机确实携带全部运行时依赖（`@deepseek-ai/` 下 dsh-llm / dsh-attachment / dsh-brand / dsh-fs /
    dsh-timeout / dsh-client-ui-model-selection 均为 0.2.0-rc.2，`@earendil-works/pi-ai` 0.87.1，
    `./api/*` 子路径导出存在）。
  - **真实安装装载验证**：在临时 `DSH_HOME` 建 scratch profile，执行
    `dsh plugin --profile scratch add github:nangongdao/dsh-ccswitch` → EXIT=0，
    装入 `dsh-ccswitch@0.2.0`；`--dump-config` 显示 `# == dsh-ccswitch` 条目已挂载；
    随后 `dsh --profile scratch` 启动成功，进程**实际 import 了本插件**（输出
    `ExperimentalWarning: SQLite is an experimental feature`，来源即本插件
    `lib/index.mjs:16` 的 `import { DatabaseSync } from "node:sqlite"`），
    且所有 `@deepseek-ai/*` peer 均从主机解析成功 —— 证明装载链路与依赖解析均可用。
  - 临时目录 `E:\dsh-ccswitch-installtest` 验证后已删除（删除前 `Resolve-Path` 确认）。
- **Verified**：远端 `origin/main` = `c3a29d8`；GitHub 返回的 `package.json` 为
  `version 0.2.0` / `repository.url` = nangongdao / `dsh-llm` peer = `^0.2.0-rc.2` /
  无 `dsh.compatibility`；`lib/index.mjs` HTTP 200。
- **Not verified**：未在真实 desktop profile 内安装（避免动用户正在运行的环境）；
  未在装载后实际发一次真实对话请求（S10 已在进程外覆盖该链路）。

## S12 修复：CC Switch 自定义数据目录下看不到 provider（0.2.0 → 0.2.1）

- **Observed**：
  - 用户安装后在 DSH 中看不到任何 ccswitch provider。插件确实已装入
    `C:\Users\20777\.dsh\profiles\desktop`（`dependencies` 与 `dsh.profile.bundles` 均含 `dsh-ccswitch`，
    `node_modules/dsh-ccswitch` version = 0.2.0），profile `cordis.yml` 只有 `[]`（树由 bundles 组合）。
  - 根因：`src/paths.ts` 默认库路径写死 `homedir()/.cc-switch/cc-switch.db`，
    而 CC Switch 4.0.4 允许在设置里改数据目录，本机即为 `D:\.cc-switch`。
    证据：`%APPDATA%\com.ccswitch.desktop\app_paths.json` = `{"app_config_dir_override": "D:\\.cc-switch"}`
    （该值是**目录**而非 db 文件）；`D:\.cc-switch\cc-switch.db` 8.9 MB / 121 providers / 109 endpoints
    （2026/10/7 活跃），而 `C:\Users\20777\.cc-switch\cc-switch.db` 19.7 MB / 17 providers / 0 endpoints
    （2026/9/4 陈旧）。CC Switch 自身在目录缺失时会回退默认路径（exe 字符串
    「Store 中配置的 app_config_dir 不存在: ... 将使用默认路径」）。
  - stub ctx 复现：默认库只注册 **2** 条路由；`DSH_CCSWITCH_DB=D:\.cc-switch\cc-switch.db` 注册 **81** 条。
- **Modified**：
  - `src/paths.ts` 重写：新增导出 `PathProbe { isDirectory; readText }`（注入点，测试用内存探针）；
    新增 `configuredDataDirectory()`，依次探测 `%APPDATA%\com.ccswitch.desktop`、
    `~/.config/com.ccswitch.desktop`、`~/Library/Application Support/com.ccswitch.desktop` 下的
    `app_paths.json`，剥 BOM 后取 `app_config_dir_override`，要求 string + trim 非空 +
    绝对路径 + `probe.isDirectory()` 为真才采用，否则回退 `~/.cc-switch`。
    核心行：`const resolvedDatabase = database ?? paths.join(configuredDataDirectory(...) ?? paths.join(home, '.cc-switch'), CC_SWITCH_DATABASE)`。
    显式 `database`（即 `DSH_CCSWITCH_DB`）优先级最高且**完全不触碰文件系统**；
    `codexOAuthStore` 等其余字段计算方式不变。
    设计取舍：只判**目录存在**而非 db 文件存在，以复刻 CC Switch 自身语义，避免「目录在但库被删」时
    静默读到陈旧库。
  - `test/paths.test.js` 重写为 9 个用例（原 3 个断言保持成立，补第 4 参探针）；
    新增 win32 跟随 `D:\.cc-switch`、POSIX `.config`、macOS Application Support、BOM 容忍、
    6 种回退（目录缺失/空白/相对路径/非字符串/键缺失/JSON 畸形）、文件不可读、
    以及「显式 database 不触碰探针」。
  - `package.json` version 0.2.0 → **0.2.1**；README 更新「CC Switch 使用了自定义目录」一节
    （说明自动跟随 + 三个平台的 app_paths.json 位置）与排障第 5 条。
- **Tested**：
  - `pnpm typecheck` EXIT=0；`pnpm test` **67 tests / 67 pass / 0 fail**；`pnpm build` EXIT=0。
  - 活体探针用真实 `resolveCcSwitchPaths()` 输出 `database = D:\.cc-switch\cc-switch.db`
    （修复前为 `C:\Users\20777\.cc-switch\...`）；`CcSwitchRepository.read()` 在真实库上得到 **81 条路由**
    （claude 46 / codex 35），与库中计数吻合。
  - **升级路径实测**（两个临时 scratch profile，均用 `DSH_HOME` 隔离，不触碰用户环境）：
    先按旧提交 `cd0f9a1` 装出 0.2.0，再把 specifier 改回不带 pin 的
    `github:nangongdao/dsh-ccswitch`（复刻用户当前状态：specifier 无 pin、lockfile 仍钉旧 commit），
    然后执行 README 的原样命令 `dsh plugin --profile scratch add github:nangongdao/dsh-ccswitch`
    → EXIT=0，**0.2.0 → 0.2.1**，lockfile 重新钉到 `093d1d1c759c7aed1b74c8e2f3acdb480bfbb151`。
    装载后 `lib/index.mjs` 的 SHA256 与仓库 `pnpm build` 产物**逐字节一致**，
    用 stub ctx 跑其 `apply()` 注册 **81** 条路由。
- **Verified**：`origin/main` = `093d1d1`（commit「fix: 自动发现 CC Switch 自定义数据目录，修复看不到 provider」，
  5 files changed / +300 −13）；临时目录 `E:\dsh-ccswitch-upgradetest{,2}` 与全部 `.probe-*` 探针已删除
  （删除前 `Resolve-Path` 逐个确认路径相符）。
- **Not verified**：未在用户正在运行的 desktop profile 内执行升级（未动用户环境，改由用户在 DSH 内自行重装）；
  未在升级后由用户在 GUI 中肉眼确认 provider 列表（stub 注册不能代替 GUI 验收）。

## S13 目录失效通知与可识别分组（0.2.2）

- **Observed**：DSH 0.2 模型选择器缓存 session model catalog，通过 `llm/adapters-updated` 失效。旧插件只在 provider ID 集合变化时替换注册；同 ID 的模型/名称更新以及端点发现不会发出通知。
- **Modified**：配置变化时 `syncRegistration(changed)`，发现模型真正变化时 `syncRegistration(true)`；setter 比较 id、name、contextWindow、maxTokens 并返回是否变化。每个分组显示 `CC Switch · 应用 · 原名称`，不改变 provider ID 或原筛选名称。
- **Tested**：真实 Cordis/LlmRuntime + 临时 SQLite 集成覆盖 81 条合成路由、restart/dispose、数据库后到、同 route 模型/名字变化通知、无变化不重复通知和空目录恢复。不包含真实凭证、不发 HTTP。聚焦 19/19，全仓 73/73，typecheck/build 通过。
- **Installation**：当前 Electron 独占管理 `desktop` profile，CLI 拒绝 `--profile desktop` 安装；README 改为桌面「插件 → 添加插件」安装 GitHub 来源，旧版先卸载再安装。命令行 Web 版继续使用 `--profile web`。
- **Runtime evidence**：经用户授权，在真实 desktop 加载 0.2.1 后，session model catalog 返回 CC Switch 分组且无 provider 错误；GUI 皮肤的「更多模型」能打开完整目录，但原名称缺少来源标识。
- **Upgrade cache**：已通过真实桌面插件页从 GitHub 安装并启用 0.2.2，lockfile 指向发布提交，安装构建除 Git 的 CRLF/LF 换行转换外与仓库一致。运行宿主仍使用旧 module。实际发行版 Plugin Manager 明确将更新标记为 `restart-required`，卸载并重装也不清除 Node 模块缓存；须完整重启桌面应用，不是仅刷新页面。用户随后授权重新安装并重启，重启后 GUI 前缀验收仍待完成。
