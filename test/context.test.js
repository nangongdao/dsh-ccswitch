import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { toPiContext } from '../src/context.ts'

function imageRef(overrides = {}) {
  return {
    attachmentId: 'img_0000000000000001',
    mediaType: 'image/png',
    bytes: 3,
    width: 2,
    height: 2,
    ...overrides,
  }
}

/** AttachmentStore stub exposing only what context.ts calls. */
function attachmentsFor(refs, data = Uint8Array.from([1, 2, 3])) {
  return {
    readImageRequest(ref, target) {
      return Promise.resolve({
        variantId: 'v1',
        attachment: ref,
        data,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: target.width,
        height: target.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      })
    },
    requested: refs,
  }
}

const user = (content) => createUserMessage({ content, source: { kind: 'user' } })
const text = (value) => ({ type: 'text', text: value })

test('converts a text-only history with tools', () => {
  const context = toPiContext({
    provider: 'p',
    model: 'm',
    messages: [user([text('hi')])],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
  })

  assert.deepEqual(context, {
    messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
  })
})

test('prefers options.system and folds a leading system message into a user message', () => {
  assert.equal(
    toPiContext({ provider: 'p', model: 'm', system: 'explicit', messages: [user([text('hi')])] }).systemPrompt,
    'explicit',
  )

  const folded = toPiContext({ provider: 'p', model: 'm', messages: [
    { role: 'system', content: [text('from history')], source: { kind: 'system-prompt' } },
    user([text('hi')]),
  ] })
  assert.equal(folded.systemPrompt, 'from history')
  assert.deepEqual(folded.messages, [{ role: 'user', content: 'hi', timestamp: 0 }])
})

test('recovers tool result names from the preceding assistant tool call', () => {
  const context = toPiContext({
    provider: 'p',
    model: 'm',
    messages: [
      createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'read', arguments: '{}' }],
        source: { provider: 'p', model: 'm' },
      }),
      createToolResultMessage({ callId: ToolCallId('call_1'), content: [text('file body')], isError: false }),
    ],
  })

  assert.deepEqual(context.messages[1], {
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: 'read',
    content: [{ type: 'text', text: 'file body' }],
    isError: false,
    timestamp: 0,
  })
})

test('rejects developer history and tool-change blocks', () => {
  assert.throws(
    () => toPiContext({ provider: 'p', model: 'm', messages: [
      { role: 'developer', content: [text('x')], source: { kind: 'user' } },
    ] }),
    error => error.code === 'UNSUPPORTED_CONTENT' && /Developer messages/.test(error.message),
  )

  // The developer-role refusal fires first, so exercise the block check on a user role.
  assert.throws(
    () => toPiContext({ provider: 'p', model: 'm', messages: [
      { role: 'user', content: [{ type: 'tool-addition', toolName: 'read' }], source: { kind: 'user' } },
    ] }),
    error => error.code === 'UNSUPPORTED_CONTENT' && /Tool-change blocks/.test(error.message),
  )
})

test('rejects deferred tool loading', () => {
  assert.throws(
    () => toPiContext({ provider: 'p', model: 'm', messages: [], tools: [
      { name: 'read', description: 'd', parameters: {}, deferLoading: true },
    ] }),
    error => error.code === 'UNSUPPORTED_CONTENT' && /Deferred tool loading/.test(error.message),
  )
})

test('requires the attachment service for any image', () => {
  assert.throws(
    () => toPiContext({ provider: 'p', model: 'm', messages: [user([
      { type: 'image', attachment: imageRef() },
    ]) ] }),
    error => error.code === 'UNSUPPORTED_CONTENT' && /durable attachment service/.test(error.message),
  )
})

test('rejects an image in in-history assistant content', async () => {
  await assert.rejects(
    toPiContext({ provider: 'p', model: 'm', messages: [
      createAssistantMessage({
        content: [{ type: 'image', attachment: imageRef() }],
        source: { provider: 'p', model: 'm' },
      }),
    ] }, { attachments: attachmentsFor([]) }),
    error => error.code === 'UNSUPPORTED_CONTENT'
      && /cannot represent an image in an in-history assistant message/.test(error.message),
  )
})

test('resolves a retained image into handle text plus inline bytes', async () => {
  const ref = imageRef()
  const context = await toPiContext(
    { provider: 'p', model: 'm', messages: [user([text('look:'), { type: 'image', attachment: ref }])] },
    { attachments: attachmentsFor([ref]) },
  )

  const content = context.messages[0].content
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, 'look:')
  assert.equal(content[1].type, 'text')
  assert.match(content[1].text, /request preview 2x2px/)
  assert.equal(content[2].type, 'image')
  assert.equal(content[2].mimeType, 'image/png')
  assert.equal(content[2].data, Buffer.from([1, 2, 3]).toString('base64'))
})

test('threads a resolved read-only path into the image handle text', async () => {
  const ref = imageRef()
  const context = await toPiContext(
    { provider: 'p', model: 'm', messages: [user([{ type: 'image', attachment: ref }])] },
    {
      attachments: attachmentsFor([ref]),
      resolveImageAccess: candidate => candidate.attachmentId === ref.attachmentId
        ? { readonlyPath: '/execution/world/img.png' }
        : undefined,
    },
  )

  const content = context.messages[0].content
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /request preview 2x2px/)
  assert.match(content[0].text, /Normalized copy \(read-only; may be resized or re-encoded\): "\/execution\/world\/img\.png"/)
  assert.equal(content[1].type, 'image')
})

test('projects an already-offloaded image to its placeholder text', async () => {
  const ref = imageRef()
  const context = await toPiContext(
    { provider: 'p', model: 'm', messages: [user([{ type: 'image', attachment: ref, offloaded: true }])] },
    { attachments: attachmentsFor([]) },
  )

  // The only remaining block is text, so the message content collapses to a string.
  const content = context.messages[0].content
  assert.equal(typeof content, 'string')
  assert.match(content, /image omitted to fit request image limits/)
  assert.match(content, /img_0000000000000001/)
})

test('fails with IMAGE_OFFLOAD_REQUIRED when the base64 budget is exceeded', async () => {
  const ref = imageRef()
  await assert.rejects(
    toPiContext(
      { provider: 'p', model: 'm', messages: [user([{ type: 'image', attachment: ref }])] },
      { attachments: attachmentsFor([ref]), maxRequestImageBytes: 3 },
    ),
    error => error.code === 'IMAGE_OFFLOAD_REQUIRED' && error.failure.offloadImages === 1,
  )
})
