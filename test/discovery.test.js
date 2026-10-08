import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverRouteModels } from '../src/discovery.ts'

const model = { id: 'seed', name: 'Seed', contextWindow: 262144, maxTokens: 32768 }
function route(overrides = {}) {
  return {
    provider: 'ccswitch/codex/one', sourceId: 'one', appType: 'codex', name: 'Synthetic',
    baseURL: 'https://example.invalid/v1', protocol: 'openai-completions',
    defaultModel: model.id, models: [model], authKind: 'api-key', fingerprint: 'one',
    ...overrides,
  }
}
const signal = () => new AbortController().signal

/** Serve canned pages in order and record every request. */
function pages(entries) {
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init?.headers ?? {} })
    const entry = entries.shift()
    if (entry === undefined) throw new Error('unexpected extra request')
    if (entry === 'throw') throw new Error('synthetic network failure')
    return new Response(JSON.stringify(entry.body), {
      status: entry.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, requests }
}
async function withFetch(t, stub, run) {
  const original = globalThis.fetch
  globalThis.fetch = stub
  t.after(() => { globalThis.fetch = original })
  return run()
}

test('follows Anthropic cursor pagination with the documented auth headers', async t => {
  const { fetch, requests } = pages([
    { body: { data: [{ id: 'claude-a', display_name: 'Claude A', context_window: 200000, max_tokens: 8192 }], has_more: true, last_id: 'claude-a' } },
    { body: { data: [{ id: 'claude-b' }], has_more: false } },
  ])
  await withFetch(t, fetch, async () => {
    const models = await discoverRouteModels(
      route({ protocol: 'anthropic-messages', baseURL: 'https://api.anthropic.com', appType: 'claude' }),
      { token: 'synthetic-key' }, signal())
    const ids = models.map(candidate => candidate.id)
    assert.deepEqual(ids, ['seed', 'claude-a', 'claude-b'])
    assert.equal(models.find(candidate => candidate.id === 'claude-a').name, 'Claude A')
    assert.equal(models.find(candidate => candidate.id === 'claude-a').maxTokens, 8192)
    // An unknown model that the endpoint omitted still keeps provider-supplied defaults.
    assert.equal(models.find(candidate => candidate.id === 'claude-b').contextWindow, 262144)
  })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/models')
  assert.equal(requests[1].url, 'https://api.anthropic.com/v1/models?after_id=claude-a')
  assert.equal(requests[0].headers['x-api-key'], 'synthetic-key')
  assert.equal(requests[0].headers['anthropic-version'], '2023-06-01')
  assert.equal(requests[0].headers.authorization, undefined)
})

test('discovers Gemini models through the google endpoint and drops non-generative entries', async t => {
  const { fetch, requests } = pages([
    { body: { models: [{ name: 'models/gemini-2.5-flash', displayName: 'Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'page-two' } },
    { body: { models: [{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }] } },
  ])
  await withFetch(t, fetch, async () => {
    const models = await discoverRouteModels(route({
      protocol: 'google-generative-ai', appType: 'gemini', baseURL: 'https://generativelanguage.googleapis.com',
    }), { token: 'synthetic-key' }, signal())
    assert.deepEqual(models.map(candidate => candidate.id), ['seed', 'gemini-2.5-flash', 'gemini-2.5-pro'])
    assert.equal(models.find(candidate => candidate.id === 'gemini-2.5-flash').contextWindow, 1048576)
  })
  assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models')
  assert.equal(requests[1].url, 'https://generativelanguage.googleapis.com/v1beta/models?pageToken=page-two')
  assert.equal(requests[0].headers['x-goog-api-key'], 'synthetic-key')
})

test('reads an OpenAI-style models map for an authenticated api-key route', async t => {
  const { fetch, requests } = pages([{
    body: { object: 'list', models: {
      'gpt-5.6-sol': { name: 'GPT 5.6', contextWindow: 400000, maxOutputTokens: 128000 },
      created: 1,
    } },
  }])
  await withFetch(t, fetch, async () => {
    const models = await discoverRouteModels(route({ protocol: 'openai-responses' }), { token: 'synthetic-key' }, signal())
    assert.deepEqual(models.map(candidate => candidate.id), ['seed', 'gpt-5.6-sol'])
  })
  assert.equal(requests[0].headers.authorization, 'Bearer synthetic-key')
})

test('rejects truncated pagination instead of silently listing fewer models', async t => {
  const { fetch } = pages([{ body: { data: [{ id: 'a' }], has_more: true } }])
  await withFetch(t, fetch, async () => {
    await assert.rejects(discoverRouteModels(route({ protocol: 'anthropic-messages' }), { token: 'k' }, signal()),
      /missing last_id/)
  })
})

test('rejects repeated pagination pages, HTTP failures, and oversized listings', async t => {
  const looped = pages([
    { body: { data: [{ id: 'a' }], has_more: true, last_id: 'a' } },
    { body: { data: [{ id: 'a' }], has_more: true, last_id: 'a' } },
  ])
  await withFetch(t, looped.fetch, async () => {
    await assert.rejects(discoverRouteModels(route({ protocol: 'anthropic-messages' }), { token: 'k' }, signal()),
      /loop detected/)
  })
  const failing = pages([{ body: { error: 'nope' }, status: 500 }])
  await withFetch(t, failing.fetch, async () => {
    await assert.rejects(discoverRouteModels(route(), { token: 'k' }, signal()), /HTTP 500/)
  })
  const huge = pages([{ body: { data: [] } }])
  await withFetch(t, huge.fetch, async () => {
    const original = globalThis.Response
    globalThis.Response = class extends original {
      constructor(body, init) {
        super(body, init)
        Object.defineProperty(this, 'headers', { value: new Headers({ 'content-length': String(3 * 1024 * 1024) }) })
      }
    }
    try {
      await assert.rejects(discoverRouteModels(route(), { token: 'k' }, signal()), /too large/)
    } finally { globalThis.Response = original }
  })
})

test('honours caller cancellation and never leaks the credential in a rejection', async t => {
  const { fetch } = pages(['throw'])
  await withFetch(t, fetch, async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled by caller'))
    let thrown
    try { await discoverRouteModels(route(), { token: 'synthetic-key' }, controller.signal) } catch (error) { thrown = error }
    assert.ok(thrown !== undefined, 'an aborted discovery must reject')
    assert.equal(String(thrown?.message).includes('synthetic-key'), false)
  })
})
