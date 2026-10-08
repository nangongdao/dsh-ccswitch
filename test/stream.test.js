import assert from 'node:assert/strict'
import test from 'node:test'
import { mapStopReason, mapUsage, toStreamChunks } from '../src/stream.ts'

/** Minimal pi-ai assistant message; only the fields the adapter reads. */
function assistant(overrides = {}) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
    api: 'anthropic-messages',
    provider: 'ccswitch/claude/test',
    model: 'claude-sonnet-4-5',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  }
}

async function collect(events, ...rest) {
  const chunks = []
  for await (const chunk of toStreamChunks(events, ...rest)) chunks.push(chunk)
  return chunks
}

async function* from(items) {
  for (const item of items) yield item
}

test('mapUsage keeps pi-ai total and reports cache only when non-zero', () => {
  assert.deepEqual(
    mapUsage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: {} }),
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  )
  assert.deepEqual(
    mapUsage({ input: 10, output: 5, cacheRead: 7, cacheWrite: 3, totalTokens: 25, cost: {} }),
    { inputTokens: 10, outputTokens: 5, totalTokens: 25, cacheReadTokens: 7, cacheWriteTokens: 3 },
  )
})

test('mapStopReason maps the ordinary terminal states', () => {
  assert.deepEqual(mapStopReason(assistant()), { kind: 'stop' })
  assert.deepEqual(mapStopReason(assistant({ stopReason: 'length' })), { kind: 'max-tokens' })
  assert.deepEqual(mapStopReason(assistant({ stopReason: 'toolUse' })), { kind: 'tool-calls' })
})

test('mapStopReason rejects a content-free stop as an empty response', () => {
  const reason = mapStopReason(assistant({ content: [] }))
  assert.equal(reason.kind, 'error')
  assert.equal(reason.failure.code, 'EMPTY_RESPONSE')
})

test('mapStopReason surfaces pending and deferred as non-retryable failures', () => {
  const pending = mapStopReason(assistant({ stopReason: 'pending' }))
  assert.deepEqual(pending, {
    kind: 'error',
    failure: { message: 'pi-ai stream for model "claude-sonnet-4-5" ended pending', code: 'PI_AI_ERROR' },
  })
  const deferred = mapStopReason(assistant({ stopReason: 'deferred' }))
  assert.deepEqual(deferred, {
    kind: 'error',
    failure: { message: 'pi-ai deferred response for model "claude-sonnet-4-5" is not supported', code: 'PI_AI_ERROR' },
  })
})

test('mapStopReason classifies a 413 body-limit refusal as an invalid request', () => {
  const reason = mapStopReason(assistant({
    stopReason: 'error',
    errorMessage: '413 status code (no body)',
  }))
  assert.equal(reason.kind, 'error')
  assert.equal(reason.failure.code, 'INVALID_REQUEST')

  const wording = mapStopReason(assistant({
    stopReason: 'error',
    errorMessage: 'failed to buffer the request body: length limit exceeded',
  }))
  assert.equal(wording.failure.code, 'INVALID_REQUEST')
})

test('mapStopReason detects usage-based context overflow against the catalog window', () => {
  const reason = mapStopReason(assistant({
    stopReason: 'stop',
    usage: { input: 200_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 200_010, cost: {} },
  }), 128_000)
  assert.equal(reason.kind, 'error')
  assert.equal(reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('toStreamChunks brands tool-call ids and keeps raw argument JSON', async () => {
  const chunks = await collect(from([
    { type: 'start', partial: assistant() },
    { type: 'toolcall_start', contentIndex: 0, partial: { content: [{ type: 'toolCall', id: 'call_1', name: 'read' }] } },
    { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":', partial: assistant() },
    { type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }, partial: assistant() },
    { type: 'done', reason: 'toolUse', message: assistant({ stopReason: 'toolUse' }) },
  ]))

  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'tool-call' })
  assert.equal(chunks[1].type, 'tool-call-delta')
  assert.equal(chunks[1].id, 'call_1')
  assert.equal(chunks[1].name, 'read')
  assert.deepEqual(chunks[2], {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
  })
  assert.equal(chunks.at(-2).type, 'usage')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('toStreamChunks records the requested model in durable replay state', async () => {
  const chunks = await collect(from([
    { type: 'done', reason: 'stop', message: assistant({ responseModel: 'claude-sonnet-4-5-20260101', providerThinkingLevel: 'high' }) },
  ]), 128_000, undefined, 'claude-sonnet-4-5')

  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.replayState.response.model, 'claude-sonnet-4-5')
  assert.equal(finish.replayState.response.responseModel, 'claude-sonnet-4-5-20260101')
  assert.equal(finish.replayState.response.providerThinkingLevel, 'high')
})

test('toStreamChunks rewrites a provider error as aborted when the caller cancelled', async () => {
  const caller = new AbortController()
  caller.abort()
  const chunks = await collect(from([
    { type: 'error', reason: 'error', error: assistant({ stopReason: 'error', errorMessage: 'socket hang up' }) },
  ]), 128_000, caller.signal)

  assert.equal(chunks.at(-1).reason.kind, 'aborted')
  assert.equal(chunks.at(-1).reason.failure.code, 'ABORTED')
})

test('toStreamChunks throws STREAM_CLOSED when the source ends without a terminal event', async () => {
  await assert.rejects(
    collect(from([{ type: 'start', partial: assistant() }])),
    error => error.code === 'STREAM_CLOSED',
  )
})
