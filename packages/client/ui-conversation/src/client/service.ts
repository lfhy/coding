/**
 * Scope-addressed conversation send, cancel, and history orchestration.
 *
 * Scope addressing rides the cordis Service tracker: property access through
 * `ctx.conversation` rebinds `this.ctx` to the caller's context, so methods
 * read the session tag with `scopeOf`. Mutable state must remain reachable
 * through one property read; assignment through the tracker proxy and `#`
 * private fields bypass that rebinding.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports: a plugin-to-plugin value import is a bundle purity
// error, so scope resolution goes through the sessions service (scopeOf
// method) instead of the standalone helper.
import type {
  ConversationSnapshot, ISessions, SessionFace, SessionId, UserMessageNode,
} from 'coding-client-runtime/client'
import type { SubmitImageAttachment, SubmitOutcome } from 'coding-client-ui-input-trigger/client'
import type { ImageAttachmentRef, ImageMediaType } from 'coding-attachment'
import type { ComposerAttachment } from './contract/slots.ts'
import type { QueueAction, QueueItemId } from './contract/queue.ts'
import type { ComposerBlocks } from './input/blocks.ts'
import type { DraftAttachmentId, SessionInputResolver } from './input/contract.ts'
import type { InputSubmitMode } from './contract/composer-submission.ts'

/** 一次 prompt 提交的完整内容（文本与已编码图片，顺序即提交顺序）。 */
type PromptParts = Parameters<SessionFace['prompt']>[0]

/**
 * The outward conversation face (`ctx.conversation`): the scope-addressed
 * verbs and the input registry other plugins may reach — and exactly what a
 * test fake must supply.
 */
export interface IConversation {
  /** The per-session input machine registry (SessionInputResolver face). */
  readonly input: SessionInputResolver
  /**
   * The per-session composer-block registry: how a plugin the composer
   * cannot import makes a session's input inert with its own reason.
   */
  readonly blocks: ComposerBlocks
  /**
   * Send a prompt into the caller scope's session (queued turn).
   * @param text - prompt text, sent verbatim as one text block.
   * @returns completion; business failures reject (and land in promptError).
   */
  send(text: string): Promise<void>
  /**
   * 重发某个失败轮次开头的那条用户消息：文本原样重发，图片按会话附件重新取字节，
   * 作为一次新的排队发送（不改写历史，也不复用原消息）。
   * @param turn - 失败的轮次编号（terminal `turn-error` 节点携带）。
   * @returns 完成或拒绝；发送失败与 `send` 一样写进 promptError，
   * 找不到该轮用户消息或附件读取失败时只拒绝、不发送任何内容。
   */
  retryTurn(turn: number): Promise<void>
  /**
   * Apply one edit, remove, or strict steer operation to a pending queue occurrence.
   * @param itemId - agent-owned inbox occurrence identity.
   * @param action - requested queue operation.
   * @returns completion; converged strict-steer races resolve, while other failures reject.
   */
  updateQueue(itemId: QueueItemId, action: QueueAction): Promise<void>
  /**
   * Cancel the scoped session's in-flight turn while preserving its pending Queue.
   * @returns completion; failures reject as in send.
   */
  cancel(): Promise<void>
  /**
   * Pull one older history page for the scoped session.
   * @returns completion of the page pull.
   */
  loadOlder(): Promise<void>
}

/** Create one browser-only draft descriptor; only its id enters input state. */
function browserDraftAttachment(file: File): ComposerAttachment {
  return {
    kind: 'image',
    id: crypto.randomUUID() as DraftAttachmentId,
    previewUrl: URL.createObjectURL(file),
    file,
  }
}

interface ImageUrlEntry {
  readonly sessionId: SessionId
  readonly generation: number
  readonly pending: Promise<string>
}

/** Unsupported browser-declared image type, localized by the UI boundary. */
export class UnsupportedImageMediaTypeError extends Error {
  /** Browser-declared MIME value, possibly empty. */
  readonly mediaType: string

  /** @param mediaType - Browser-declared MIME value, possibly empty. */
  constructor(mediaType: string) {
    super(`unsupported image media type: ${mediaType || '(empty)'}`)
    this.name = 'UnsupportedImageMediaTypeError'
    this.mediaType = mediaType
  }
}

/** Scope-addressed conversation service (root singleton, provided as `conversation`). */
export class ConversationController extends Service implements IConversation {
  /** The per-session input machine registry (SessionInputResolver face). */
  readonly input: SessionInputResolver
  /** The per-session composer-block registry. */
  readonly blocks: ComposerBlocks
  private readonly draftAttachments = new Map<DraftAttachmentId, ComposerAttachment>()
  private readonly imageUrls = new Map<string, ImageUrlEntry>()
  private readonly imageGenerations = new Map<SessionId, number>()
  private readonly createdImageUrls = new Set<string>()
  private disposed = false

  /**
   * @param ctx - owning root context (the plugin apply context; the service
   * registers itself and follows that fiber's lifetime).
   * @param config - carries the SessionInputResolver and composer-block registry
   * constructed by the plugin apply (the same instances the slot inject
   * factories close over).
   */
  constructor(ctx: Context, config: { input: SessionInputResolver; blocks: ComposerBlocks }) {
    super(ctx, 'conversation')
    this.input = config.input
    this.blocks = config.blocks
    ctx.effect(() => () => {
      this.disposed = true
      for (const url of this.createdImageUrls) revokePreview(url)
      this.createdImageUrls.clear()
      this.draftAttachments.clear()
      this.imageUrls.clear()
      this.imageGenerations.clear()
    }, 'conversation attachment URL cache')
  }

  /**
   * Send a prompt into the scoped session. Business failures also land in the
   * session snapshot's promptError (object-layer state); the rejection here
   * exists for caller choreography (the composer restores the draft on it).
   * @param text - prompt text, sent verbatim as one text block.
   */
  async send(text: string): Promise<void> {
    const session = this.scopedSession('send')
    const result = await session.prompt([{ type: 'text', text }], 'queue')
    if (!result.ok) throw new Error(`conversation.send failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * 重发失败轮次开头的用户消息（一次新的排队发送，历史保持不变）。
   * @param turn - 失败的轮次编号。
   */
  async retryTurn(turn: number): Promise<void> {
    const session = this.scopedSession('retryTurn')
    const content = await replayContent(session, turn)
    const result = await session.prompt(content, 'queue')
    if (!result.ok) throw new Error(`conversation.retryTurn failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Submit ordered draft images with text through one host admission.
   * @param session - target session.
   * @param text - serialized prompt text.
   * @param imageIds - ordered draft-local attachment ids.
   * @param mode - queue or steer delivery selected by composer policy.
   * @param signal - optional cancellation for the complete Host admission.
   * @returns the Host admission outcome; local attachment preparation failures reject.
   */
  async sendSession(
    session: SessionFace,
    text: string,
    imageIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal?: AbortSignal,
  ): Promise<SubmitOutcome> {
    const attachments = this.draftImages(imageIds)
    if (attachments.length !== imageIds.length) {
      throw new Error('conversation.sendSession: one or more draft images are no longer available')
    }
    const uploaded = await this.serializeImages(attachments.map(attachment => attachment.file))
    const content = [...uploaded, ...(text === '' ? [] : [{ type: 'text' as const, text }])]
    const result = await session.prompt(content, mode, signal)
    if (!result.ok) return { kind: 'error' }
    this.releaseDraftImages(attachments)
    return { kind: 'success' }
  }

  /**
   * Create runtime-only draft images and their object URLs.
   * @param files - browser files to register after MIME validation.
   * @returns ordered draft descriptors.
   */
  createDraftImages(files: readonly File[]): readonly ComposerAttachment[] {
    for (const file of files) imageMediaType(file.type)
    return files.map((file) => {
      const attachment = browserDraftAttachment(file)
      this.draftAttachments.set(attachment.id, attachment)
      this.createdImageUrls.add(attachment.previewUrl)
      return attachment
    })
  }

  /**
   * Resolve ordered input-state ids to runtime-owned draft images.
   * @param ids - draft attachment ids.
   * @returns descriptors that remain live, in requested order.
   */
  draftImages(ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[] {
    const attachments: ComposerAttachment[] = []
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id)
      if (attachment !== undefined) attachments.push(attachment)
    }
    return attachments
  }

  /**
   * Serialize ordered draft images to command-submit wire payloads without
   * sending or releasing them (the composer releases only after the command
   * settles successfully).
   * @param imageIds - ordered draft-local attachment ids.
   * @returns base64 payloads in id order.
   */
  async serializeDraftImages(imageIds: readonly DraftAttachmentId[]): Promise<readonly SubmitImageAttachment[]> {
    const attachments = this.draftImages(imageIds)
    if (attachments.length !== imageIds.length) {
      throw new Error('conversation.serializeDraftImages: one or more draft images are no longer available')
    }
    return Promise.all(attachments.map(attachment => this.encodeImage(attachment.file)))
  }

  /**
   * Release one browser-owned draft image and preview URL.
   * @param id - draft attachment id.
   */
  releaseDraftImage(id: DraftAttachmentId): void {
    const attachment = this.draftAttachments.get(id)
    if (attachment === undefined) return
    this.draftAttachments.delete(id)
    this.createdImageUrls.delete(attachment.previewUrl)
    revokePreview(attachment.previewUrl)
  }

  /**
   * Release a set of browser-owned draft images.
   * @param attachments - descriptors to release.
   */
  releaseDraftImages(attachments: readonly ComposerAttachment[]): void {
    for (const attachment of attachments) this.releaseDraftImage(attachment.id)
  }

  /**
   * Resolve and cache one session-authorized historical image URL.
   * @param sessionId - owning session authorization scope.
   * @param attachment - durable image reference.
   * @returns browser URL valid until its rendered session is released.
   */
  resolveImage(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('conversation.resolveImage: service is disposed'))
    const key = `${sessionId}:${attachment.attachmentId}`
    const cached = this.imageUrls.get(key)
    if (cached !== undefined) return cached.pending
    const generation = this.imageGenerations.get(sessionId) ?? 0
    const session = this.requireSessions().binding(sessionId)?.session
    if (session === undefined) {
      return Promise.reject(new Error(`conversation.resolveImage: unknown session "${sessionId}"`))
    }
    const pending = session.readAttachment(attachment.attachmentId)
      .then((result) => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        if (this.disposed) throw new Error('conversation.resolveImage: service was disposed before loading completed')
        if ((this.imageGenerations.get(sessionId) ?? 0) !== generation) {
          throw new Error('historical image scope was released before loading completed')
        }
        if (typeof URL.createObjectURL !== 'function') {
          return `data:${result.value.attachment.mediaType};base64,${bytesToBase64(result.value.data)}`
        }
        const bytes = Uint8Array.from(result.value.data)
        const url = URL.createObjectURL(new Blob([bytes.buffer], { type: result.value.attachment.mediaType }))
        this.createdImageUrls.add(url)
        return url
      })
      .catch((error: unknown) => {
        if (this.imageUrls.get(key)?.generation === generation) this.imageUrls.delete(key)
        throw error
      })
    this.imageUrls.set(key, { sessionId, generation, pending })
    return pending
  }

  /**
   * Release every historical image URL owned by one rendered session.
   * @param sessionId - rendered session scope.
   */
  releaseSessionImages(sessionId: SessionId): void {
    this.imageGenerations.set(sessionId, (this.imageGenerations.get(sessionId) ?? 0) + 1)
    for (const [key, entry] of this.imageUrls) {
      if (entry.sessionId !== sessionId) continue
      this.imageUrls.delete(key)
      void entry.pending.then((url) => {
        if (!this.createdImageUrls.delete(url)) return
        revokePreview(url)
      }, () => {
        // A failed or invalidated load owns no object URL.
      })
    }
  }

  /** Apply one operation to a pending queue occurrence. */
  async updateQueue(itemId: QueueItemId, action: QueueAction): Promise<void> {
    const session = this.scopedSession('updateQueue')
    const result = await session.updateQueue(itemId, action)
    if (!result.ok) {
      if (
        action.kind === 'steer'
        && (result.error.code === 'steer-unavailable' || result.error.code === 'queue-item-not-found')
      ) return
      throw new Error(`conversation.updateQueue failed: ${result.error.code}: ${result.error.message}`)
    }
  }

  /** Cancel the scoped session's in-flight turn while preserving Queue (failures land in promptError and reject, as in send). */
  async cancel(): Promise<void> {
    const session = this.scopedSession('cancel')
    const result = await session.cancel()
    if (!result.ok) throw new Error(`conversation.cancel failed: ${result.error.code}: ${result.error.message}`)
  }

  /** Pull one older history page for the scoped Session. */
  async loadOlder(): Promise<void> {
    await this.scopedSession('loadOlder').loadOlder()
  }

  /** Resolve the caller scope's session face or throw on root contexts. */
  private scopedSession(op: string): SessionFace {
    const id = this.scopeId(op)
    const binding = this.requireSessions().binding(id)
    if (binding === undefined) throw new Error(`conversation.${op}: session "${id}" resolved no binding`)
    return binding.session
  }

  /** Read the caller's session scope tag via the sessions service; root contexts fail loud. */
  private scopeId(op: string): SessionId {
    const id = this.requireSessions().scopeOf(this.ctx)
    if (id === undefined) {
      throw new Error(`conversation.${op} requires a session scope — address one via ctx.sessions.scope(id).conversation`)
    }
    return id
  }

  private requireSessions(): ISessions {
    // Strict ctx.get, not the injection proxy: the scope-addressed pattern
    // reads the service off whatever context the tracker rebound.
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('conversation: sessions service unavailable')
    return sessions
  }

  /** Convert browser files to canonical base64 prompt parts. */
  private serializeImages(images: readonly File[]): Promise<Parameters<SessionFace['prompt']>[0]> {
    return Promise.all(images.map(async file => ({ type: 'image' as const, ...await this.encodeImage(file) })))
  }

  /** Canonical base64 wire form of one browser image file. */
  private async encodeImage(file: File): Promise<SubmitImageAttachment> {
    return {
      mediaType: imageMediaType(file.type),
      data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      ...(file.name === '' ? {} : { name: file.name }),
    }
  }
}

/**
 * 找出开启某个轮次的那条用户消息。Host 先记录 `turn/start`，认领的提示词随后作为
 * 该轮的第一条 `user` 节点落到窗口内，因此边界齐全时取轮次起点与终点之间的第一条；
 * 边界已滑出加载窗口（分页）时退回窗口内最后一条用户消息。
 * @param snapshot - 当前会话投影。
 * @param turn - 目标轮次编号。
 * @returns 开启该轮次的用户消息；窗口内没有时为 undefined。
 */
function openingUserNode(snapshot: ConversationSnapshot, turn: number): UserMessageNode | undefined {
  const location = snapshot.chat.timeline.turns.get(turn)
  const startSeq = location?.start?.seq
  const endSeq = location?.end?.seq
  const users: UserMessageNode[] = []
  for (const node of snapshot.chat.nodes.values()) {
    if (node.kind !== 'user' || node.visibility === 'hidden') continue
    users.push(node.data as UserMessageNode)
  }
  if (startSeq !== undefined && endSeq !== undefined) {
    return users.filter(node => node.seq >= startSeq && node.seq <= endSeq)
      .sort((left, right) => left.seq - right.seq)[0]
  }
  return users.sort((left, right) => left.seq - right.seq).at(-1)
}

/**
 * 把一条已持久化的用户消息还原成可再次提交的内容：文本原样，图片重新读取会话附件字节。
 * 用户消息只承载文本与图片，其他块不进入重发内容。
 * @param session - 目标会话。
 * @param turn - 失败的轮次编号。
 * @returns 可直接提交给 `prompt` 的内容。
 */
async function replayContent(session: SessionFace, turn: number): Promise<PromptParts> {
  const node = openingUserNode(session.getSnapshot(), turn)
  if (node === undefined) {
    throw new Error(`conversation.retryTurn: turn ${turn} has no user message in the loaded window`)
  }
  const content: PromptParts = []
  for (const block of node.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type !== 'image') continue
    const stored = await session.readAttachment(block.attachment.attachmentId)
    if (!stored.ok) throw new Error(`conversation.retryTurn: ${stored.error.code}: ${stored.error.message}`)
    content.push({
      type: 'image',
      mediaType: stored.value.attachment.mediaType,
      data: bytesToBase64(stored.value.data),
      ...stored.value.attachment.name === undefined ? {} : { name: stored.value.attachment.name },
    })
  }
  if (content.length === 0) {
    throw new Error(`conversation.retryTurn: turn ${turn} opening user message carries nothing to resend`)
  }
  return content
}

function imageMediaType(value: string): ImageMediaType {
  switch (value) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
    case 'image/gif':
      return value
    default:
      throw new UnsupportedImageMediaTypeError(value)
  }
}

function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < data.length; offset += chunk) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

function revokePreview(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}
