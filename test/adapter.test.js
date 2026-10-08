import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CcSwitchAdapter } from '../src/adapter.ts'

function route(appType, modelId, overrides = {}) {
  return {
    provider: `ccswitch/${appType}/test`,
    sourceId: 'test',
    appType,
    name: 'Test Provider',
    baseURL: 'https://example.test/v1',
    protocol: appType === 'claude' ? 'anthropic-messages'
      : appType === 'gemini' ? 'google-generative-ai' : 'openai-responses',
    defaultModel: modelId,
    models: [{ id: modelId, name: modelId, contextWindow: 128_000, maxTokens: 8_192 }],
    authKind: 'api-key',
    fingerprint: 'test',
    ...overrides,
  }
}

/** A repository stand-in: the adapter only reads `current`, `config`, `record`. */
function repositoryFor(routes, config = {}) {
  return {
    current: { version: 1, fingerprint: 'test', routes },
    config,
    record: source => ({ id: source.sourceId, appType: source.appType, settings: { apiKey: 'test-key' } }),
  }
}

async function drain(iterable) {
  for await (const _chunk of iterable) { /* consume */ }
}

function imageRef(overrides = {}) {
  return {
    attachmentId: 'img_0000000000000001',
    mediaType: 'image/png',
    bytes: 4,
    width: 2,
    height: 2,
    ...overrides,
  }
}

test('publishes the configured provider name and falls back to the id', () => {
  const codex = route('codex', 'gpt-5.6-sol')
  const adapter = new CcSwitchAdapter(repositoryFor([codex]))

  assert.deepEqual(adapter.providerInfo(codex.provider), { id: codex.provider, name: 'Test Provider' })
  assert.deepEqual(adapter.providerInfo('ccswitch/unknown/x'), { id: 'ccswitch/unknown/x', name: 'ccswitch/unknown/x' })
})

test('lists every route model with its declared input modalities', async () => {
  const codex = route('codex', 'gpt-5.6-sol')
  const adapter = new CcSwitchAdapter(repositoryFor([codex]))

  const models = await adapter.listModels(codex.provider)
  assert.equal(models.length, 1)
  assert.deepEqual(models[0], {
    provider: codex.provider,
    id: 'gpt-5.6-sol',
    name: 'gpt-5.6-sol',
    inputModalities: ['text', 'image'],
  })
})

test('publishes no reasoning block for a model without reasoning', async () => {
  const claude = route('claude', 'claude-sonnet-4-5')
  const adapter = new CcSwitchAdapter(repositoryFor([claude], { codexReasoningEffort: 'minimal' }))

  const resolved = await adapter.resolveModel(claude.provider, claude.defaultModel)
  assert.equal(resolved.reasoning, undefined)
  assert.deepEqual(resolved.context, { contextWindow: 128_000 })
})

test('omits defaultEffort when the configured level is not supported by the model', async () => {
  const codex = route('codex', 'gpt-5.6-sol')
  for (const effort of ['xhigh', 'max', 'off']) {
    const adapter = new CcSwitchAdapter(repositoryFor([codex], { codexReasoningEffort: effort }))
    const resolved = await adapter.resolveModel(codex.provider, codex.defaultModel)
    assert.equal(resolved.reasoning.defaultEffort, undefined, `"${effort}" must not be published as a default`)
    assert.equal(resolved.reasoning.efforts.length, 4, 'the supported levels stay describable')
  }
})

test('publishes the configured level when the model supports it', async () => {
  const codex = route('codex', 'gpt-5.6-sol')
  const adapter = new CcSwitchAdapter(repositoryFor([codex], { codexReasoningEffort: 'high' }))
  const resolved = await adapter.resolveModel(codex.provider, codex.defaultModel)
  assert.equal(resolved.reasoning.defaultEffort, 'high')
})

test('rejects an unknown provider and an unknown model', async () => {
  const codex = route('codex', 'gpt-5.6-sol')
  const adapter = new CcSwitchAdapter(repositoryFor([codex]))

  // A catalog miss rejects the returned promise (the adapter defers its
  // validation), so assert on the call directly.
  await assert.rejects(adapter.resolveModel('ccswitch/nope/x', 'm'), error => error.code === 'NO_ADAPTER')
  await assert.rejects(adapter.resolveModel(codex.provider, 'nope'), error => error.code === 'UNKNOWN_MODEL')
})

test('prepareCall freezes its snapshot so an in-flight call keeps its catalog', async () => {
  const codex = route('codex', 'gpt-5.6-sol')
  const repository = repositoryFor([codex])
  const adapter = new CcSwitchAdapter(repository)

  const prepared = await adapter.prepareCall(codex.provider, codex.defaultModel)
  assert.equal(prepared.model.context.contextWindow, 128_000)

  // A configuration change lands on the next step, not the one in flight.
  repository.current = {
    version: 2,
    fingerprint: 'changed',
    routes: [{ ...codex, models: [{ ...codex.models[0], contextWindow: 999_000 }] }],
  }
  assert.equal((await adapter.resolveModel(codex.provider, codex.defaultModel)).context.contextWindow, 999_000)
  assert.equal(prepared.model.context.contextWindow, 128_000)
})

test('endpoint-discovered models override the stored catalog until cleared', async () => {
  const codex = route('codex', 'gpt-5.6-sol')
  const adapter = new CcSwitchAdapter(repositoryFor([codex]))

  adapter.setDiscoveredModels(codex.provider, [{ id: 'gpt-5.6-terra', name: 'Terra', contextWindow: 400_000, maxTokens: 16_384 }])
  const discovered = await adapter.listModels(codex.provider)
  assert.deepEqual(discovered.map(model => model.id), ['gpt-5.6-terra'])

  adapter.clearDiscoveredModels()
  const restored = await adapter.listModels(codex.provider)
  assert.deepEqual(restored.map(model => model.id), ['gpt-5.6-sol'])
})

test('stream refuses GenerateOptions.stop before touching the network', async () => {
  const codex = route('codex', 'gpt-5.6-sol')
  const adapter = new CcSwitchAdapter(repositoryFor([codex]))

  await assert.rejects(
    drain(adapter.stream({ provider: codex.provider, model: codex.defaultModel, messages: [], stop: 'END' })),
    error => error.code === 'UNSUPPORTED_OPTION',
  )
})

test('stream refuses an unsupported explicit reasoning effort', async () => {
  const codex = route('codex', 'gpt-4.1')
  const adapter = new CcSwitchAdapter(repositoryFor([codex]))

  await assert.rejects(
    drain(adapter.stream({ provider: codex.provider, model: codex.defaultModel, messages: [], reasoningEffort: 'high' })),
    error => error.code === 'UNSUPPORTED_REASONING_EFFORT',
  )
})

test('stream requires the durable attachment service for image input', async () => {
  const codex = route('codex', 'gpt-5.6-sol')
  const adapter = new CcSwitchAdapter(repositoryFor([codex]))
  const message = createUserMessage({
    content: [{ type: 'image', attachment: imageRef() }],
    source: { kind: 'user' },
  })

  await assert.rejects(
    drain(adapter.stream({ provider: codex.provider, model: codex.defaultModel, messages: [message] })),
    error => error.code === 'UNSUPPORTED_CONTENT' && /attachment service/.test(error.message),
  )
})

test('threads the resolved read-only image path into the request', async () => {
  const codex = route('codex', 'gpt-5.6-sol')
  const ref = imageRef()
  const attachments = {
    readImageRequest(candidate, target) {
      return Promise.resolve({
        variantId: 'v1',
        attachment: candidate,
        data: Uint8Array.from([1, 2, 3]),
        mediaType: candidate.mediaType,
        bytes: candidate.bytes,
        width: target.width,
        height: target.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      })
    },
  }
  const seen = []
  const adapter = new CcSwitchAdapter(
    repositoryFor([codex]),
    () => attachments,
    (store, candidate) => {
      seen.push([store, candidate])
      // Abort the request here: reaching this callback proves the adapter
      // threaded the resolver and the exact attachment reference through.
      throw new Error('resolver reached')
    },
  )
  const message = createUserMessage({
    content: [{ type: 'image', attachment: ref }],
    source: { kind: 'user' },
  })

  await assert.rejects(
    drain(adapter.stream({ provider: codex.provider, model: codex.defaultModel, messages: [message] })),
    /resolver reached/,
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], attachments)
  assert.equal(seen[0][1].attachmentId, ref.attachmentId)
})

test('stream rejects an unavailable provider or model', async () => {
  const codex = route('codex', 'gpt-5.6-sol')
  const adapter = new CcSwitchAdapter(repositoryFor([codex]))

  await assert.rejects(
    drain(adapter.stream({ provider: 'ccswitch/nope/x', model: 'm', messages: [] })),
    error => error.code === 'NO_ADAPTER',
  )
  await assert.rejects(
    drain(adapter.stream({ provider: codex.provider, model: 'nope', messages: [] })),
    error => error.code === 'UNKNOWN_MODEL',
  )
})
