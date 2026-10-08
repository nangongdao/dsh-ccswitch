import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentTools,
  getInitialSystemMessage,
  getSystemMessageText,
  type JsonObject,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEventStream, StopReason, Usage } from '@earendil-works/pi-ai'
import {
  convertMessages,
  convertTools,
  mapStopReasonString,
  resolveGoogleFunctionCallingMode,
  retainThoughtSignature,
  supportsGoogleStrictToolSampling,
} from '@earendil-works/pi-ai/api/google-shared'
import type { CcSwitchRoute } from './types.ts'

type GeminiModel = Model<'google-generative-ai'>

interface GeminiChunk {
  readonly responseId?: string
  readonly candidates?: readonly {
    readonly content?: {
      readonly parts?: readonly GeminiPart[]
    }
    readonly finishReason?: string
  }[]
  readonly usageMetadata?: {
    readonly promptTokenCount?: number
    readonly candidatesTokenCount?: number
    readonly thoughtsTokenCount?: number
    readonly cachedContentTokenCount?: number
    readonly totalTokenCount?: number
  }
}

interface GeminiPart {
  readonly text?: string
  readonly thought?: boolean
  readonly thoughtSignature?: string
  readonly functionCall?: {
    readonly id?: string
    readonly name?: string
    readonly args?: JsonObject
  }
}

type AssistantBlock = AssistantMessage['content'][number]
type TextBlock = Extract<AssistantBlock, { type: 'text' }>
type ThinkingBlock = Extract<AssistantBlock, { type: 'thinking' }>

interface GeminiPayload {
  readonly contents: ReturnType<typeof convertMessages>
  readonly systemInstruction?: { readonly role: 'user'; readonly parts: readonly [{ readonly text: string }] }
  readonly tools?: ReturnType<typeof convertTools>
  readonly toolConfig?: { readonly functionCallingConfig: { readonly mode: string } }
  readonly generationConfig?: {
    readonly temperature?: number
    readonly maxOutputTokens?: number
  }
}

let toolCallCounter = 0

function headers(options: StreamOptions): Record<string, string> {
  const result: Record<string, string> = {
    accept: 'text/event-stream',
    'content-type': 'application/json',
  }
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value !== null) result[key] = value
  }
  // OAuth is deliberately sent only as Authorization. The Google SDK's API
  // key auth would otherwise duplicate it as x-goog-api-key.
  delete result['x-goog-api-key']
  delete result['X-Goog-Api-Key']
  return result
}

function payload(model: GeminiModel, context: TranscriptContext, options: StreamOptions): GeminiPayload {
  // pi-ai 0.87.1 normalizes the caller's Context into a TranscriptContext whose
  // prompt and tool declarations live in the leading system message, so both
  // are read back from the transcript rather than from Context fields.
  const tools = getCurrentTools(context.messages)
  const initialSystemMessage = getInitialSystemMessage(context.messages)
  const systemInstruction = initialSystemMessage === undefined ? '' : getSystemMessageText(initialSystemMessage)
  const mode = tools.length === 0
    ? undefined
    : resolveGoogleFunctionCallingMode(
      tools,
      (options as SimpleStreamOptions & { toolChoice?: string }).toolChoice,
      supportsGoogleStrictToolSampling(model.id),
    )
  const config: GeminiPayload = {
    contents: convertMessages(model, context),
    ...(systemInstruction.length === 0 ? {} : {
      systemInstruction: { role: 'user', parts: [{ text: systemInstruction }] },
    }),
    ...(tools.length === 0 ? {} : {
      tools: convertTools(tools),
      ...(mode === undefined ? {} : { toolConfig: { functionCallingConfig: { mode } } }),
    }),
    ...(options.temperature === undefined && options.maxTokens === undefined ? {} : {
      generationConfig: {
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
      },
    }),
  }
  return config
}

function requestURL(model: GeminiModel): string {
  const base = (model.baseUrl ?? '').replace(/\/+$/, '')
  return `${base}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`
}

async function* sse(response: Response): AsyncGenerator<GeminiChunk> {
  if (response.body === null) throw new Error('Gemini OAuth response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const part = await reader.read()
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ''
      for (const event of events) {
        const data = event.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .join('\n')
        if (data.length === 0 || data === '[DONE]') continue
        yield JSON.parse(data) as GeminiChunk
      }
      if (part.done) break
    }
    const data = buffer.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('\n')
    if (data.length > 0 && data !== '[DONE]') yield JSON.parse(data) as GeminiChunk
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function appendText(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  part: GeminiPart,
  current: { value: TextBlock | ThinkingBlock | null },
): void {
  if (part.text === undefined) return
  const thinking = part.thought === true
  if (current.value === null || (thinking && current.value.type !== 'thinking') || (!thinking && current.value.type !== 'text')) {
    if (current.value?.type === 'text') {
      stream.push({ type: 'text_end', contentIndex: output.content.length - 1, content: current.value.text, partial: output })
    } else if (current.value?.type === 'thinking') {
      stream.push({ type: 'thinking_end', contentIndex: output.content.length - 1, content: current.value.thinking, partial: output })
    }
    if (thinking) {
      current.value = { type: 'thinking', thinking: '' }
      output.content.push(current.value)
      stream.push({ type: 'thinking_start', contentIndex: output.content.length - 1, partial: output })
    } else {
      current.value = { type: 'text', text: '' }
      output.content.push(current.value)
      stream.push({ type: 'text_start', contentIndex: output.content.length - 1, partial: output })
    }
  }
  if (current.value.type === 'thinking') {
    current.value.thinking += part.text
    current.value.thinkingSignature = retainThoughtSignature(current.value.thinkingSignature, part.thoughtSignature)
    stream.push({ type: 'thinking_delta', contentIndex: output.content.length - 1, delta: part.text, partial: output })
  } else {
    current.value.text += part.text
    current.value.textSignature = retainThoughtSignature(current.value.textSignature, part.thoughtSignature)
    stream.push({ type: 'text_delta', contentIndex: output.content.length - 1, delta: part.text, partial: output })
  }
}

function createOutput(model: GeminiModel): AssistantMessage {
  return {
    role: 'assistant' as const,
    content: [],
    api: 'google-generative-ai' as const,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    // `pending` marks "no finish reason seen yet"; a stream that ends without
    // one is reported as an error rather than as a clean stop.
    stopReason: 'pending' as StopReason,
    timestamp: Date.now(),
  }
}

function streamOAuth(model: GeminiModel, context: TranscriptContext, options: StreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  void (async () => {
    const output = createOutput(model)
    try {
      const requestBody = payload(model, context, options)
      const nextPayload = await options.onPayload?.(requestBody, model)
      const response = await fetch(requestURL(model), {
        method: 'POST',
        headers: headers(options),
        body: JSON.stringify(nextPayload ?? requestBody),
        signal: options.signal,
      })
      if (!response.ok) throw new Error(`Gemini OAuth request failed (HTTP ${response.status})`)
      stream.push({ type: 'start', partial: output })
      const current: { value: TextBlock | ThinkingBlock | null } = { value: null }
      for await (const chunk of sse(response)) {
        output.responseId ||= chunk.responseId
        const candidate = chunk.candidates?.[0]
        for (const part of candidate?.content?.parts ?? []) {
          appendText(stream, output, part, current)
          if (part.functionCall !== undefined) {
            if (current.value?.type === 'text') stream.push({ type: 'text_end', contentIndex: output.content.length - 1, content: current.value.text, partial: output })
            if (current.value?.type === 'thinking') stream.push({ type: 'thinking_end', contentIndex: output.content.length - 1, content: current.value.thinking, partial: output })
            current.value = null
            const providedId = part.functionCall.id
            const existing = output.content.some(block => block.type === 'toolCall' && block.id === providedId)
            const id = providedId && !existing ? providedId : `${part.functionCall.name ?? 'tool'}_${Date.now()}_${++toolCallCounter}`
            const toolCall = {
              type: 'toolCall' as const,
              id,
              name: part.functionCall.name ?? '',
              arguments: part.functionCall.args ?? {},
              ...(part.thoughtSignature === undefined ? {} : { thoughtSignature: part.thoughtSignature }),
            }
            output.content.push(toolCall)
            stream.push({ type: 'toolcall_start', contentIndex: output.content.length - 1, partial: output })
            stream.push({ type: 'toolcall_delta', contentIndex: output.content.length - 1, delta: JSON.stringify(toolCall.arguments), partial: output })
            stream.push({ type: 'toolcall_end', contentIndex: output.content.length - 1, toolCall, partial: output })
          }
        }
        if (candidate?.finishReason !== undefined) {
          output.stopReason = mapStopReasonString(candidate.finishReason)
          if (output.content.some(block => block.type === 'toolCall')) output.stopReason = 'toolUse'
        }
        const usage = chunk.usageMetadata
        if (usage !== undefined) {
            output.usage = {
            input: (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0),
            output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
            cacheRead: usage.cachedContentTokenCount ?? 0,
            cacheWrite: 0,
            totalTokens: usage.totalTokenCount ?? 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          } satisfies Usage
          calculateCost(model, output.usage)
        }
      }
      if (current.value?.type === 'text') stream.push({ type: 'text_end', contentIndex: output.content.length - 1, content: current.value.text, partial: output })
      if (current.value?.type === 'thinking') stream.push({ type: 'thinking_end', contentIndex: output.content.length - 1, content: current.value.thinking, partial: output })
      if (options.signal?.aborted) throw new Error('Request was aborted')
      if (output.stopReason === 'pending') throw new Error('Gemini OAuth stream ended without a finish reason')
      if (output.stopReason === 'error' || output.stopReason === 'aborted') throw new Error('Gemini OAuth response was not successful')
      stream.push({ type: 'done', reason: output.stopReason, message: output })
      stream.end()
    } catch (error) {
      output.stopReason = options.signal?.aborted ? 'aborted' : 'error'
      output.errorMessage = error instanceof Error ? error.message : 'Gemini OAuth request failed'
      stream.push({ type: 'error', reason: output.stopReason, error: output })
      stream.end()
    }
  })()
  return stream
}

export function geminiOAuthApi(): ProviderStreams {
  return {
    stream: (model, context, options) => streamOAuth(model as GeminiModel, context, options ?? {}),
    streamSimple: (model, context, options) => streamOAuth(model as GeminiModel, context, options ?? {}),
  }
}

export function geminiOAuthRoute(route: CcSwitchRoute): ProviderStreams | undefined {
  return route.authKind === 'gemini-oauth' ? geminiOAuthApi() : undefined
}
