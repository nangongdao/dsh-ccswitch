/**
 * Harness request-history conversion into pi-ai's Context vocabulary.
 *
 * @module dsh-ccswitch/context
 */

import {
  contentHasImage,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  requiredImageOffload,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  ImageAttachmentAccessResolver,
  ImageBlock,
  Message,
  RequestMessage,
} from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Context as PiContext, ImageContent, Message as PiMessage, TextContent, Tool as PiTool } from '@earendil-works/pi-ai'
import { toPiAssistant } from './replay.ts'

/** Route-owned image policy and durable attachment resolver for one request. */
export interface PiAiRequestImages {
  /** Durable byte resolver for image references. */
  attachments: AttachmentStore
  /** Resolve current execution-world access for one durable image reference. */
  resolveImageAccess?: ImageAttachmentAccessResolver
  /**
   * Accumulated inline base64 bytes this route accepts; absent leaves the
   * payload unbounded. Exceeding it fails with `IMAGE_OFFLOAD_REQUIRED`.
   */
  maxRequestImageBytes?: number
  /** Projection budgets applied before the request-version byte bound. */
  requestImagePolicy?: {
    maxPixels: number
    maxBytes: number
  }
}

/** Default projection budget: 4M pixels and 1 MiB per prepared image. */
const DEFAULT_REQUEST_IMAGE_POLICY = { maxPixels: 4_194_304, maxBytes: 1_048_576 }

/** Join the text blocks of a harness message. */
function flattenText(message: { readonly content: readonly ContentBlock[] }): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Recover the pi-ai toolResult message for one harness tool-role message. */
function toolResultOf(
  message: Extract<Message, { role: 'tool' }>,
  toolNames: ReadonlyMap<string, string>,
  content: string | (TextContent | ImageContent)[],
): PiMessage {
  return {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName: toolNames.get(message.toolCallId) ?? 'unknown',
    content: typeof content === 'string'
      ? [{ type: 'text', text: content || '(no output)' }]
      : content,
    isError: message.isError ?? false,
    timestamp: 0,
  }
}

/** Reject unsupported roles, tool-change blocks, and image roles before replay or image offloading. */
function assertSupportedHistory(messages: readonly RequestMessage[]): void {
  for (const message of messages) {
    if (message.role === 'developer') {
      throw new LlmError('Developer messages are not supported yet', 'UNSUPPORTED_CONTENT')
    }
    if (message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      throw new LlmError('Tool-change blocks require developer role', 'UNSUPPORTED_CONTENT')
    }
    if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
      throw new LlmError(`pi-ai cannot represent an image in an in-history ${message.role} message`, 'UNSUPPORTED_CONTENT')
    }
  }
}

/**
 * Convert one message's content blocks to pi-ai user content.
 *
 * A retained image emits a deterministic handle text immediately followed by
 * the inline image, so the model always sees which attachment the bytes came
 * from even when the provider renders the two parts independently.
 */
function userContent(
  blocks: readonly ContentBlock[],
  requestImages: ReadonlyMap<string, RequestImageAttachment>,
  resolveImageAccess: ImageAttachmentAccessResolver,
): string | (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const version = requestImages.get(block.attachment.attachmentId)
        if (version === undefined) {
          // prepareRequestImages covers every retained reference in this exact
          // history, so a miss means the projection and the request diverged.
          throw new LlmError(`pi-ai request image "${block.attachment.attachmentId}" was not prepared`, 'UNSUPPORTED_CONTENT')
        }
        content.push({
          type: 'text',
          text: requestImageHandleText(block.attachment, version, resolveImageAccess(block.attachment)),
        })
        content.push({
          type: 'image',
          data: Buffer.from(version.data).toString('base64'),
          mimeType: version.mediaType,
        })
        break
      }
      default:
        // Other merge-extensible blocks are not user-input vocabulary for pi-ai.
        break
    }
  }
  if (content.every(block => block.type === 'text')) return content.map(block => block.text).join('')
  return content
}

/** Collect the distinct retained image references in first-appearance order. */
function collectImageRefs(blocks: readonly ContentBlock[], refs: Map<string, ImageAttachmentRef>): void {
  for (const block of blocks) {
    if (block.type === 'image' && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
  }
}

/** Deterministic request target for one source under the route budgets. */
function requestImageTarget(ref: ImageAttachmentRef, budget: { maxPixels: number; maxBytes: number }): { width: number; height: number; maxBytes: number } {
  return {
    ...requestImageDimensions(ref.width, ref.height, budget.maxPixels),
    maxBytes: budget.maxBytes,
  }
}

/** Prepare one exact request version per distinct retained attachment id. */
async function prepareRequestImages(
  messages: readonly RequestMessage[],
  attachments: AttachmentStore,
  budget: { maxPixels: number; maxBytes: number },
  signal?: AbortSignal,
): Promise<Map<string, RequestImageAttachment>> {
  const refs = new Map<string, ImageAttachmentRef>()
  for (const message of messages) collectImageRefs(message.content, refs)
  const orderedRefs = [...refs.values()]
  const prepared = await Promise.all(
    orderedRefs.map(ref => attachments.readImageRequest(ref, requestImageTarget(ref, budget), signal)),
  )
  const versions = new Map<string, RequestImageAttachment>()
  for (const [index, ref] of orderedRefs.entries()) {
    const version = prepared[index]
    if (version !== undefined) versions.set(ref.attachmentId, version)
  }
  return versions
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  if (options.tools?.some(tool => tool.deferLoading === true)) {
    throw new LlmError('Deferred tool loading is not supported yet', 'UNSUPPORTED_CONTENT')
  }
  return options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    // ToolSchema.parameters is a JSON Schema object; pi-ai's TSchema
    // (TypeBox) is structurally JSON Schema, so it assigns directly.
    parameters: tool.parameters,
  }))
}

/**
 * Select the pi-ai `systemPrompt` source shared by both conversion paths.
 *
 * `options.system` wins when defined and every history message converts,
 * including a leading `system` message, which then folds into a `user`
 * message. Otherwise a leading `system` history message supplies the prompt
 * and leaves the converted history; empty leading text sends no prompt.
 */
function splitSystemPrompt(options: GenerateOptions): { systemPrompt: string | undefined; messages: readonly RequestMessage[] } {
  if (options.system !== undefined) return { systemPrompt: options.system, messages: options.messages }
  const [first, ...rest] = options.messages
  if (first?.role !== 'system') return { systemPrompt: undefined, messages: options.messages }
  const text = flattenText(first)
  return { systemPrompt: text.length > 0 ? text : undefined, messages: rest }
}

/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(systemPrompt: string | undefined, options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options)
  return {
    ...systemPrompt !== undefined ? { systemPrompt } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

function appendAssistant(
  message: Extract<Message, { role: 'assistant' }>,
  messages: PiMessage[],
  toolNames: Map<string, string>,
  onReplayDegrade?: (reason: string) => void,
): void {
  const assistant = toPiAssistant(message, onReplayDegrade)
  for (const block of assistant.content) {
    if (block.type === 'toolCall') toolNames.set(block.id, block.name)
  }
  messages.push(assistant)
}

/** Append the system and assistant roles both context builders treat identically; true when consumed. */
function appendSystemOrAssistant(
  message: RequestMessage,
  messages: PiMessage[],
  toolNames: Map<string, string>,
  onReplayDegrade?: (reason: string) => void,
): boolean {
  if (message.role === 'system') {
    messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
    return true
  }
  if (message.role === 'assistant') {
    appendAssistant(message, messages, toolNames, onReplayDegrade)
    return true
  }
  return false
}

function textOnlyContext(options: GenerateOptions, onReplayDegrade?: (reason: string) => void): PiContext {
  assertSupportedHistory(options.messages)
  const split = splitSystemPrompt(options)
  const toolNames = new Map<string, string>()
  const messages: PiMessage[] = []
  for (const message of split.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    if (appendSystemOrAssistant(message, messages, toolNames, onReplayDegrade)) continue
    if (message.role === 'tool') {
      messages.push(toolResultOf(message, toolNames, flattenText(message)))
      continue
    }
    messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
  }
  return piContext(split.systemPrompt, options, messages)
}

async function toPiContextWithImages(
  options: GenerateOptions,
  images: PiAiRequestImages,
  onReplayDegrade?: (reason: string) => void,
): Promise<PiContext> {
  const { attachments, maxRequestImageBytes } = images
  const resolveImageAccess: ImageAttachmentAccessResolver = images.resolveImageAccess ?? (() => undefined)
  const requestImagePolicy = images.requestImagePolicy ?? DEFAULT_REQUEST_IMAGE_POLICY
  assertSupportedHistory(options.messages)
  const split = splitSystemPrompt(options)
  const requestImages = await prepareRequestImages(split.messages, attachments, requestImagePolicy, options.signal)
  if (maxRequestImageBytes !== undefined) {
    const offloadImages = requiredImageOffload(
      split.messages,
      { representation: 'base64', maxBytes: maxRequestImageBytes },
      block => requestImages.get(block.attachment.attachmentId)?.bytes ?? 0,
    )
    if (offloadImages > 0) {
      throw new LlmError(
        `pi-ai request images exceed the ${maxRequestImageBytes}-byte base64 bound; `
        + `${offloadImages} more oldest occurrence(s) must be offloaded.`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages },
      )
    }
  }
  const exactMessages = projectOffloadedImages(
    split.messages,
    (ref: ImageAttachmentRef) => offloadedImageText(ref, resolveImageAccess(ref)),
  )
  const toolNames = new Map<string, string>()
  const messages: PiMessage[] = []
  for (const message of exactMessages) {
    if (appendSystemOrAssistant(message, messages, toolNames, onReplayDegrade)) continue
    if (message.role === 'tool') {
      messages.push(toolResultOf(message, toolNames, userContent(message.content, requestImages, resolveImageAccess)))
      continue
    }
    messages.push({
      role: 'user',
      content: userContent(message.content, requestImages, resolveImageAccess),
      timestamp: 0,
    })
  }
  return piContext(split.systemPrompt, options, messages)
}

/**
 * Convert text-only harness history to a synchronous pi-ai Context. Tool
 * result names are recovered from preceding assistant tool calls.
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @param images - absent; selects the synchronous conversion.
 * @param onReplayDegrade - forwarded to {@link toPiAssistant} for each assistant message.
 * @returns the pi-ai context; `tools` is omitted when the request declares none.
 */
export function toPiContext(
  options: GenerateOptions,
  images?: undefined,
  onReplayDegrade?: (reason: string) => void,
): PiContext
/**
 * Convert harness history to a pi-ai Context while resolving durable images.
 * Tool result names are recovered from preceding assistant tool calls.
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @param images - durable byte resolver plus the route's image projection policy.
 * @param onReplayDegrade - forwarded to {@link toPiAssistant} for each assistant message.
 * @returns the asynchronously resolved pi-ai context.
 */
export function toPiContext(
  options: GenerateOptions,
  images: PiAiRequestImages,
  onReplayDegrade?: (reason: string) => void,
): Promise<PiContext>
export function toPiContext(
  options: GenerateOptions,
  images?: PiAiRequestImages,
  onReplayDegrade?: (reason: string) => void,
): PiContext | Promise<PiContext> {
  return images === undefined
    ? textOnlyContext(options, onReplayDegrade)
    : toPiContextWithImages(options, images, onReplayDegrade)
}
