import type { CcSwitchCredential, CcSwitchModel, CcSwitchRoute } from './types.ts'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_PAGES = 10
const MAX_MODELS = 10_000
const DEFAULT_CONTEXT_WINDOW = 262_144
const DEFAULT_MAX_TOKENS = 32_768

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function safeURL(value: string, base?: URL): URL {
  const url = new URL(value, base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (base !== undefined && url.origin !== base.origin)) {
    throw new Error('unsafe model listing URL')
  }
  url.hash = ''
  return url
}

function listURL(route: CcSwitchRoute): URL {
  if (route.authKind === 'codex-oauth') return safeURL('https://chatgpt.com/backend-api/codex/models')
  const url = safeURL(route.baseURL)
  let path = url.pathname.replace(/\/+$/, '')
  if (route.protocol === 'google-generative-ai' && !/\/v1(?:beta)?$/.test(path)) path += '/v1beta'
  if (route.protocol === 'anthropic-messages' && url.hostname === 'api.anthropic.com' && path === '') path = '/v1'
  url.pathname = `${path}/models`
  return url
}

// Also bound mocked/non-cooperating fetches and body streams, not just native fetch.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error('model listing is too large')
  }
  if (response.body === null) throw new Error('invalid model listing response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal)
      if (part.done) break
      total += part.value.byteLength
      if (total > MAX_BYTES) throw new Error('model listing is too large')
      chunks.push(part.value)
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function entries(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  const record = object(body)
  if (record !== undefined && record.error === undefined) {
    for (const key of ['data', 'models', 'items']) if (Array.isArray(record[key])) return record[key] as unknown[]
    const models = object(record.models)
    if (models !== undefined) {
      return Object.entries(models).flatMap(([id, value]) => {
        const descriptor = object(value)
        // Only explicit model descriptors, never arbitrary metadata keys.
        if (descriptor === undefined || !['id', 'name', 'slug', 'display_name', 'displayName',
          'context_window', 'contextWindow', 'maxTokens'].some(key => descriptor[key] !== undefined)) return []
        return [{ ...descriptor, id }]
      })
    }
  }
  throw new Error('invalid model listing response')
}

function parseModel(route: CcSwitchRoute, value: unknown): CcSwitchModel | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  if (route.protocol === 'google-generative-ai' && record.supportedGenerationMethods !== undefined
    && (!Array.isArray(record.supportedGenerationMethods) || !record.supportedGenerationMethods.includes('generateContent'))) return undefined
  const rawId = text(record.id) ?? text(record.slug) ?? text(record.model) ?? text(record.name)
  const id = rawId?.replace(/^models\//, '')
  if (id === undefined || id.length === 0) return undefined
  const contextWindow = positive(record.contextWindow) ?? positive(record.context_window)
    ?? positive(record.contextLength) ?? positive(record.context_length) ?? positive(record.inputTokenLimit) ?? positive(record.input_token_limit) ?? DEFAULT_CONTEXT_WINDOW
  const maxTokens = positive(record.maxTokens) ?? positive(record.max_tokens) ?? positive(record.maxOutputTokens) ?? positive(record.max_output_tokens)
    ?? positive(record.outputTokenLimit) ?? positive(record.output_token_limit) ?? DEFAULT_MAX_TOKENS
  return { id, name: text(record.display_name) ?? text(record.displayName) ?? id, contextWindow, maxTokens }
}

function authHeaders(route: CcSwitchRoute, credential: CcSwitchCredential): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  for (const [key, value] of Object.entries(credential.headers ?? {})) headers[key.toLowerCase()] = value
  if (route.protocol === 'anthropic-messages') headers['anthropic-version'] ??= '2023-06-01'
  if (credential.token !== undefined) {
    if (route.authKind !== 'api-key') {
      delete headers['x-api-key']
      delete headers['x-goog-api-key']
      headers.authorization = `Bearer ${credential.token}`
    } else if (route.protocol === 'anthropic-messages') headers['x-api-key'] = credential.token
    else if (route.protocol === 'google-generative-ai') headers['x-goog-api-key'] = credential.token
    else headers.authorization = `Bearer ${credential.token}`
  }
  return headers
}

function nextURL(route: CcSwitchRoute, body: unknown, current: URL, first: URL): URL | undefined {
  const record = object(body)
  if (record === undefined) return undefined
  if (route.protocol === 'anthropic-messages') {
    if (record.has_more !== undefined && typeof record.has_more !== 'boolean') throw new Error('invalid model pagination')
    if (record.has_more !== true) return undefined
    const cursor = text(record.last_id)
    if (cursor === undefined) throw new Error('model pagination is truncated: missing last_id')
    const next = new URL(first)
    next.searchParams.set('after_id', cursor)
    return next
  }
  if (route.protocol === 'google-generative-ai') {
    if (record.nextPageToken === undefined || record.nextPageToken === '') return undefined
    const token = text(record.nextPageToken)
    if (token === undefined) throw new Error('invalid model pagination')
    const next = new URL(first)
    next.searchParams.set('pageToken', token)
    return next
  }
  const raw = record.next ?? object(record.links)?.next
  if (raw !== undefined && raw !== null && raw !== '') {
    const link = text(raw) ?? text(object(raw)?.href)
    if (link === undefined) throw new Error('invalid model pagination')
    return safeURL(link, current)
  }
  if (record.has_more === true) throw new Error('model pagination is truncated: missing next link')
  return undefined
}

export async function discoverRouteModels(
  route: CcSwitchRoute,
  credential: CcSwitchCredential,
  signal?: AbortSignal,
): Promise<readonly CcSwitchModel[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('discovery timeout')), 5_000)
  const requestSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  try {
    const first = listURL(route)
    let current: URL | undefined = first
    const seenURLs = new Set<string>()
    const seenPages = new Set<string>()
    const unique = new Map(route.models.map(model => [model.id, model]))
    if (!unique.has(route.defaultModel)) unique.set(route.defaultModel, {
      id: route.defaultModel, name: route.defaultModel, contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS,
    })
    let total = 0
    for (let page = 0; current !== undefined; page++) {
      requestSignal.throwIfAborted()
      if (page >= MAX_PAGES) throw new Error('model pagination is truncated: page limit exceeded')
      if (seenURLs.has(current.href)) throw new Error('model pagination loop detected')
      seenURLs.add(current.href)
      const response = await abortable(fetch(current.href, {
        headers: authHeaders(route, credential), signal: requestSignal, redirect: 'error',
      }), requestSignal)
      if (!response.ok) throw new Error(`model listing returned HTTP ${response.status}`)
      // Defense in depth for injected fetch implementations that ignore redirect:error.
      if (response.redirected || (response.url && safeURL(response.url, first).origin !== first.origin)) throw new Error('unsafe model listing redirect')
      const body = await boundedJSON(response, requestSignal)
      const values = entries(body)
      total += values.length
      if (total > MAX_MODELS) throw new Error('model pagination is truncated: model limit exceeded')
      const next = nextURL(route, body, current, first)
      const signature = JSON.stringify(values)
      if (seenPages.has(signature)) throw new Error('model pagination loop detected')
      seenPages.add(signature)
      if (next !== undefined && values.length === 0) throw new Error('model pagination is truncated: empty page')
      for (const value of values) {
        const model = parseModel(route, value)
        if (model !== undefined) unique.set(model.id, model)
      }
      current = next
    }
    return [...unique.values()]
  } finally {
    clearTimeout(timer)
  }
}
