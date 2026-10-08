import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { toPiAssistant, toPiReplayState } from '../src/replay.ts'

function assistant(overrides = {}) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'hello', textSignature: 'sig-text' }],
    api: 'anthropic-messages',
    provider: 'ccswitch/claude/test',
    model: 'claude-sonnet-4-5',
    responseModel: 'claude-sonnet-4-5-20260101',
    responseId: 'msg_1',
    providerThinkingLevel: 'high',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  }
}

const harnessAssistant = (content, source = { provider: 'ccswitch/claude/test', model: 'claude-sonnet-4-5' }) =>
  createAssistantMessage({ content, source })

test('projects a native response into a lossless replay envelope', () => {
  const state = toPiReplayState(assistant())
  assert.deepEqual(state.response, {
    kind: 'pi-ai',
    version: 2,
    api: 'anthropic-messages',
    provider: 'ccswitch/claude/test',
    model: 'claude-sonnet-4-5',
    responseModel: 'claude-sonnet-4-5-20260101',
    responseId: 'msg_1',
    providerThinkingLevel: 'high',
    stopReason: 'stop',
  })
  assert.deepEqual(state.blocks, [{ type: 'text', textSignature: 'sig-text' }])
})

test('records the requested model instead of the provider-echoed response model', () => {
  const state = toPiReplayState(assistant(), 'claude-sonnet-4-5')
  assert.equal(state.response.model, 'claude-sonnet-4-5')
  assert.equal(state.response.responseModel, 'claude-sonnet-4-5-20260101')

  // Defaults to the native model when the caller names none.
  assert.equal(toPiReplayState(assistant()).response.model, 'claude-sonnet-4-5')
})

test('omits optional response fields instead of writing undefined', () => {
  const state = toPiReplayState(assistant({
    responseModel: undefined,
    responseId: undefined,
    providerThinkingLevel: undefined,
  }))
  assert.deepEqual(Object.keys(state.response).sort(), ['api', 'kind', 'model', 'provider', 'stopReason', 'version'])
})

test('replays a matching envelope back into native pi-ai history', () => {
  const native = assistant()
  const message = harnessAssistant(
    [{ type: 'text', text: 'hello' }],
    { provider: native.provider, model: native.model, replayState: toPiReplayState(native) },
  )

  const restored = toPiAssistant(message)
  assert.equal(restored.api, 'anthropic-messages')
  assert.equal(restored.model, 'claude-sonnet-4-5')
  assert.equal(restored.responseModel, 'claude-sonnet-4-5-20260101')
  assert.equal(restored.responseId, 'msg_1')
  assert.equal(restored.providerThinkingLevel, 'high')
  assert.equal(restored.stopReason, 'stop')
  assert.deepEqual(restored.content, [{ type: 'text', text: 'hello', textSignature: 'sig-text' }])
})

test('restores a tool call with its parsed arguments and signature', () => {
  const native = assistant({
    content: [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.txt' }, thoughtSignature: 'sig-thought' }],
    stopReason: 'toolUse',
  })
  const message = harnessAssistant(
    [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'read', arguments: '{"path":"a.txt"}' }],
    { provider: native.provider, model: native.model, replayState: toPiReplayState(native) },
  )

  const restored = toPiAssistant(message)
  assert.deepEqual(restored.content, [
    { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.txt' }, thoughtSignature: 'sig-thought' },
  ])
  assert.equal(restored.stopReason, 'toolUse')
})

test('degrades a foreign assistant message to provider-neutral history', () => {
  const message = harnessAssistant(
    [{ type: 'text', text: 'from another adapter' }],
    { provider: 'other', model: 'other-model' },
  )

  const converted = toPiAssistant(message)
  assert.equal(converted.api, 'dsh-foreign')
  assert.equal(converted.provider, 'other')
  assert.equal(converted.model, 'other-model')
  assert.deepEqual(converted.content, [{ type: 'text', text: 'from another adapter' }])
})

test('degrades a mismatched replay envelope and reports the reason', () => {
  const reasons = []
  const message = harnessAssistant(
    [{ type: 'text', text: 'hello' }],
    {
      provider: 'ccswitch/claude/test',
      model: 'claude-sonnet-4-5',
      // Envelope names a different model than the durable assistant source.
      replayState: toPiReplayState(assistant(), 'some-other-model'),
    },
  )

  const converted = toPiAssistant(message, reason => reasons.push(reason))
  assert.equal(converted.api, 'dsh-foreign')
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /model does not match assistant source/)
})

test('degrades malformed replay state without throwing', () => {
  for (const replayState of [null, 'nope', {}, { response: {}, blocks: [] }, { response: { kind: 'pi-ai', version: 99 }, blocks: [] }]) {
    const message = harnessAssistant(
      [{ type: 'text', text: 'hello' }],
      { provider: 'ccswitch/claude/test', model: 'claude-sonnet-4-5', replayState },
    )
    const converted = toPiAssistant(message)
    assert.equal(converted.api, 'dsh-foreign', `replayState ${JSON.stringify(replayState)} should degrade`)
  }
})

test('degrades a replay envelope whose block count drifted from durable content', () => {
  const message = harnessAssistant(
    [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }],
    {
      provider: 'ccswitch/claude/test',
      model: 'claude-sonnet-4-5',
      replayState: toPiReplayState(assistant()),
    },
  )
  assert.equal(toPiAssistant(message).api, 'dsh-foreign')
})

test('rejects a providerThinkingLevel that is not a string', () => {
  const message = harnessAssistant(
    [{ type: 'text', text: 'hello' }],
    {
      provider: 'ccswitch/claude/test',
      model: 'claude-sonnet-4-5',
      replayState: {
        response: { ...toPiReplayState(assistant()).response, providerThinkingLevel: 7 },
        blocks: [{ type: 'text' }],
      },
    },
  )
  assert.equal(toPiAssistant(message).api, 'dsh-foreign')
})

test('rejects an unknown stopReason', () => {
  const message = harnessAssistant(
    [{ type: 'text', text: 'hello' }],
    {
      provider: 'ccswitch/claude/test',
      model: 'claude-sonnet-4-5',
      replayState: {
        response: { ...toPiReplayState(assistant()).response, stopReason: 'pending' },
        blocks: [{ type: 'text' }],
      },
    },
  )
  assert.equal(toPiAssistant(message).api, 'dsh-foreign')
})

test('refuses to represent structured assistant image output', () => {
  const message = harnessAssistant(
    [{ type: 'image', attachment: { attachmentId: 'img_1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }],
    { provider: 'other', model: 'other-model' },
  )
  assert.throws(() => toPiAssistant(message), error => error.code === 'UNSUPPORTED_CONTENT')
})
