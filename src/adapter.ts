import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { Api, Model, Models, MutableModels, ModelThinkingLevel, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { attributionHeaders, contentHasImage, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { resolveCredential } from './auth.ts'
import { CcSwitchRepository } from './database.ts'
import { toPiContext } from './context.ts'
import { toStreamChunks } from './stream.ts'
import { buildProvider } from './provider.ts'
import type { CcSwitchModel, CcSwitchRoute, CcSwitchSnapshot } from './types.ts'

/** Stop consuming a stream that has produced no event for this long. */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/** Total inline base64 bytes one request may carry before images must be offloaded. */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

/** Projection budget applied to one prepared request image. */
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

interface Snapshot {
  source: CcSwitchSnapshot
  revision: number
  models: Models
  routes: ReadonlyMap<string, CcSwitchRoute>
}

function requestHeaders(route: CcSwitchRoute, token: string, extra: Readonly<Record<string, string>> | undefined): Record<string, string | null> {
  const headers: Record<string, string | null> = { ...extra }
  if (route.authKind === 'claude-token') {
    headers.authorization = `Bearer ${token}`
    headers['x-api-key'] = null
  } else if (route.authKind === 'gemini-oauth') {
    headers.authorization = `Bearer ${token}`
    headers['x-goog-api-key'] = null
  } else if (route.authKind === 'codex-oauth') {
    headers.authorization = `Bearer ${token}`
    if (route.accountId !== undefined) headers['chatgpt-account-id'] = route.accountId
    headers.originator = 'cc-switch'
  }
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(key => key.toLowerCase()))
  for (const key of Object.keys(headers)) if (reserved.has(key.toLowerCase())) delete headers[key]
  return { ...headers, ...attribution }
}

function modelInfo(model: Model<Api>): LlmModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    inputModalities: [...model.input],
  }
}

/**
 * The configured default this exact model can actually take, for DESCRIBING it.
 * A level the model does not support yields none rather than throwing: the
 * catalog feeds every picker, so one mis-set configuration field must not hide
 * every model on the route. The request path still refuses.
 */
function describableReasoningLevel(model: Model<Api>, effort: string | undefined): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort) ? effort as ModelThinkingLevel : undefined
}

function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Validate an explicit effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(model: Model<Api>, effort: string | undefined): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  if (getSupportedThinkingLevels(model).some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `CC Switch provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

export class CcSwitchAdapter extends LlmAdapter {
  private snapshot: Snapshot | undefined
  private discovered = new Map<string, readonly CcSwitchModel[]>()
  private discoveredRevision = 0

  constructor(
    private readonly repository: CcSwitchRepository,
    private readonly resolveAttachments?: () => AttachmentStore | undefined,
    private readonly resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined,
  ) {
    super()
  }

  /** Publish endpoint-discovered models without touching the CC Switch DB. */
  setDiscoveredModels(provider: string, models: readonly CcSwitchModel[]): boolean {
    if (models.length === 0) return false
    const previous = this.discovered.get(provider)
    const same = previous !== undefined && previous.length === models.length
      && previous.every((model, index) => model.id === models[index]?.id
        && model.name === models[index]?.name
        && model.contextWindow === models[index]?.contextWindow
        && model.maxTokens === models[index]?.maxTokens)
    if (same) return false
    this.discovered.set(provider, models.map(model => ({ ...model })))
    this.discoveredRevision += 1
    this.snapshot = undefined
    return true
  }

  /** Detached catalog snapshot for native import; credentials are never included. */
  modelsForRoute(route: CcSwitchRoute): readonly CcSwitchModel[] {
    return (this.discovered.get(route.provider) ?? route.models).map(model => ({ ...model }))
  }

  clearDiscoveredModels(): void {
    if (this.discovered.size === 0) return
    this.discovered.clear()
    this.discoveredRevision += 1
    this.snapshot = undefined
  }

  private current(): Snapshot {
    const source = this.repository.current
    if (this.snapshot?.source === source && this.snapshot.revision === this.discoveredRevision) return this.snapshot
    const models: MutableModels = createModels()
    const routes = new Map(source.routes.map(route => {
      const discovered = this.discovered.get(route.provider)
      return [route.provider, discovered === undefined ? route : { ...route, models: discovered }]
    }))
    for (const route of routes.values()) models.setProvider(buildProvider(route))
    this.snapshot = { source, revision: this.discoveredRevision, models, routes: routes as ReadonlyMap<string, CcSwitchRoute> }
    return this.snapshot
  }

  private route(snapshot: Snapshot, provider: string): CcSwitchRoute {
    const route = snapshot.routes.get(provider)
    if (route === undefined) throw new LlmError(`CC Switch provider "${provider}" is not available`, 'NO_ADAPTER')
    return route
  }

  private model(snapshot: Snapshot, provider: string, modelId: string): Model<Api> {
    this.route(snapshot, provider)
    const model = snapshot.models.getModel(provider, modelId)
    if (model === undefined) throw new LlmError(`CC Switch model "${modelId}" is not available`, 'UNKNOWN_MODEL')
    return model
  }

  private modelInfo(snapshot: Snapshot, provider: string, modelId: string): LlmResolvedModelInfo {
    const model = this.model(snapshot, provider, modelId)
    const defaultLevel = describableReasoningLevel(model, this.repository.config.codexReasoningEffort)
    return {
      ...modelInfo(model),
      context: { contextWindow: model.contextWindow },
      ...reasoningInfo(model, defaultLevel),
    }
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const route = this.current().routes.get(provider)
    if (route === undefined) return { id: provider, name: provider }
    const app = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[route.appType]
    return { id: provider, name: `CC Switch · ${app} · ${route.name}` }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // Resolve asynchronously: a catalog miss must reject the returned promise,
    // never throw during argument evaluation at the call site.
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      this.route(snapshot, provider)
      return snapshot.models.getModels(provider).map(modelInfo)
    })
  }

  override resolveModel(provider: string, modelId: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => this.modelInfo(this.current(), provider, modelId))
  }

  /**
   * Capture the whole snapshot before the first await so a configuration change
   * reaches the next step, never the one in flight: `Models.streamSimple()` is
   * lazy, so it would otherwise resolve its provider after the credential await.
   */
  override prepareCall(provider: string, modelId: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      return {
        model: this.modelInfo(snapshot, provider, modelId),
        stream: (options: GenerateOptions) => this.streamWithSnapshot(options, snapshot),
      }
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current())
  }

  private async *streamWithSnapshot(options: GenerateOptions, snapshot: Snapshot): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('dsh-ccswitch does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    const route = this.route(snapshot, options.provider)
    const model = this.model(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? (model.reasoning ? this.repository.config.codexReasoningEffort : undefined),
    )
    const credential = await resolveCredential(route, this.repository)
    const consumer = new AbortController()
    const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
    const watchdog = idleWatchdog(upstream, STREAM_IDLE_TIMEOUT_MS, 'LLM_STREAM_IDLE_TIMEOUT')
    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`CC Switch model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('CC Switch image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const context = attachments === undefined
        ? toPiContext(options, undefined)
        : await toPiContext({ ...options, signal: watchdog.signal }, {
          attachments,
          // Give the model a read-only path to the normalized image when the
          // filesystem service can map it into this execution world.
          ...this.resolveImageAccess === undefined
            ? {}
            : { resolveImageAccess: (ref: ImageAttachmentRef) => this.resolveImageAccess?.(attachments, ref) },
          maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
          requestImagePolicy: {
            maxPixels: REQUEST_IMAGE_PIXEL_BUDGET,
            maxBytes: REQUEST_IMAGE_MAX_BYTES,
          },
        })
      const streamOptions: SimpleStreamOptions = {
        apiKey: credential.token,
        headers: requestHeaders(route, credential.token ?? '', credential.headers),
        signal: watchdog.signal,
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        ...reasoning === undefined || reasoning === 'off' ? {} : { reasoning },
        maxRetries: 0,
      }
      const iterator = toStreamChunks(
        snapshot.models.streamSimple(model, context, streamOptions),
        model.contextWindow,
        options.signal,
        model.id,
      )[Symbol.asyncIterator]()
      let exhausted = false
      try {
        for (;;) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch {
            // The provider teardown after an abort is best-effort.
          }
        }
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
      watchdog[Symbol.dispose]()
    }
  }
}
