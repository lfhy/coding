/** Host 图像能力：设置快照、逐次凭据、附件准入与会话日志归属。@module coding-image-gen */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from 'coding-credentials'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import type { ImageAttachmentRef, SaveImageAttachment } from 'coding-attachment'
import type { Session, SessionEvent, SessionId } from 'coding-session'
import { CanvasConflictError, canvasSnapshot, galleryItems } from './gallery.ts'
import { imageEndpoint, requestImage } from './openai.ts'
import { installImageRoutes } from './routes.ts'
import type { CanvasSnapshot, CanvasState, GalleryItem } from './types.ts'

export type { CanvasImage, CanvasSnapshot, CanvasState, CanvasStroke, GalleryItem } from './types.ts'
export { CANVAS_WIDTH, CANVAS_HEIGHT, parseCanvasState, CanvasConflictError } from './gallery.ts'

/** Host 设置区名称，配置界面通过 settings.describe 获取此分节。 */
export const IMAGE_GENERATION_NAMESPACE = settingsNamespace('image-generation')

/** 未提供完整 endpoint/model 时开关无效；apiKeyRef 为空允许本地匿名端点。 */
export interface Config {
  /** 默认关闭；禁用仅阻止新请求，已有会话图片仍可读取。 */
  enabled: boolean
  /** OpenAI-compatible `/v1` API 基址；默认空，须为公开 HTTPS 或本机回环 HTTP(S)。 */
  endpoint: string
  /** 生成与编辑共用的模型名称；默认空且不自动选择模型。 */
  model: string
  /** 凭据服务中的引用；默认 IMAGE_GEN_API_KEY，空字符串仅用于无鉴权本地服务。 */
  apiKeyRef: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default(''),
  model: z.string().default(''),
  apiKeyRef: z.string().role('credential-ref').default('IMAGE_GEN_API_KEY'),
})

/** 设置保存前先校验端点与凭据引用，不在失败操作中回退旧配置。 */
function validateSettings(value: Config): void {
  if (value.endpoint !== '') imageEndpoint(value.endpoint, 'generations')
  if (value.model.length > 160 || value.model.includes('\n') || value.model.includes('\r')) {
    throw new TypeError('图像模型名称无效')
  }
  if (value.apiKeyRef !== '') credentialRef(value.apiKeyRef)
}

/** 会话身份来自 Host 的活会话或持久会话检查，而不是浏览器提供的附件 ID。 */
export class ImageGeneration extends Service {
  static inject = ['sessions', 'attachments', 'credentials']
  private current: () => Config

  constructor(ctx: Context, config: Config = { enabled: false, endpoint: '', model: '', apiKeyRef: 'IMAGE_GEN_API_KEY' }) {
    super(ctx, 'imageGeneration')
    // Loader 有可能直接交付部分配置；先按可选字段归一化，避免缺失的引用变成 undefined。
    const source: Partial<Config> = config
    const entry: Config = {
      enabled: source.enabled ?? false, endpoint: source.endpoint ?? '', model: source.model ?? '',
      apiKeyRef: source.apiKeyRef ?? 'IMAGE_GEN_API_KEY',
    }
    validateSettings(entry)
    this.current = () => entry
    installSettingsSection(ctx, IMAGE_GENERATION_NAMESPACE, Config, entry, {
      validate: validateSettings,
      setSource: (source) => { this.current = source },
      onChange: () => {},
    })
    installImageRoutes(ctx, this)
  }

  /** 不包含端点、引用与密钥的配置可见性摘要；无凭据的本地端点可用。 */
  async status(): Promise<{ enabled: boolean; available: boolean; model: string }> {
    const { enabled, endpoint, model, apiKeyRef } = this.current()
    const configured = enabled && endpoint.trim() !== '' && model.trim() !== ''
    const credentialReady = !configured || apiKeyRef === '' || (await this.ctx.credentials.resolve(credentialRef(apiKeyRef))) !== undefined
    return { enabled, available: configured && credentialReady, model }
  }

  /** 返回此会话的不可变图库事件投影；重启后可从持久日志重建。 */
  gallery(events: readonly SessionEvent[]): GalleryItem[] { return galleryItems(events) }

  /** 返回持久日志中的当前画布快照。 */
  canvas(events: readonly SessionEvent[]): CanvasSnapshot { return canvasSnapshot(events) }

  /** 只在同一会话的图库投影内查找附件引用，跨会话 ID 永不直接读附件。 */
  async readImage(events: readonly SessionEvent[], id: string): Promise<{ data: Uint8Array; ref: ImageAttachmentRef } | undefined> {
    const item = galleryItems(events).find(entry => entry.id === id)
    if (!item) return undefined
    const stored = await this.ctx.attachments.readImage(item)
    return stored
  }

  /** 从最近一次会话图像事件选择参考图；选取仅由同会话日志确定。 */
  latestImages(events: readonly SessionEvent[], count: number): GalleryItem[] {
    if (!Number.isSafeInteger(count) || count < 1 || count > 5) throw new TypeError('参考图数量必须介于 1 至 5')
    return galleryItems(events).slice(-count)
  }

  /** 图片保存完成后追加可重建的图库记录；成功前不暴露内容地址。 */
  async create(
    session: Session, prompt: string, sourceIds: readonly string[] = [],
    signal: AbortSignal = new AbortController().signal,
  ): Promise<GalleryItem> {
    const current = this.current()
    const config: Config = { enabled: current.enabled, endpoint: current.endpoint,
      model: current.model, apiKeyRef: current.apiKeyRef }
    if (!config.enabled || config.endpoint.trim() === '' || config.model.trim() === '') {
      throw new ImageGenerationUnavailableError()
    }
    if (typeof prompt !== 'string' || prompt.trim().length < 1 || prompt.length > 4000) {
      throw new TypeError('图片描述必须为 1 至 4000 字符')
    }
    if (!this.ctx.sessions.get(session.id) || this.ctx.sessions.get(session.id) !== session) {
      throw new Error('会话不可用')
    }
    if (sourceIds.length > 5 || new Set(sourceIds).size !== sourceIds.length) {
      throw new TypeError('参考图片数量或标识无效')
    }
    if (sourceIds.length > this.ctx.attachments.imageLimits.maxImagesPerMessage) {
      throw new TypeError('参考图片超过服务端单次限额')
    }
    const gallery = galleryItems(session.events)
    const refs = sourceIds.map((id) => {
      const item = gallery.find(candidate => candidate.id === id)
      if (!item) throw new TypeError('参考图片不属于当前会话')
      return item
    })
    signal.throwIfAborted()
    const sources: SaveImageAttachment[] = []
    let sourceBytes = 0
    for (const item of refs) {
      const stored = await this.ctx.attachments.readImage(item, signal)
      sourceBytes += stored.data.byteLength
      if (sourceBytes > (this.ctx.attachments.imageLimits.maxSourceMessageImageBytes
        ?? this.ctx.attachments.imageLimits.maxMessageImageBytes)) {
        throw new TypeError('参考图片字节总量超出服务端限额')
      }
      sources.push({ data: stored.data, mediaType: stored.ref.mediaType })
    }
    const key = config.apiKeyRef === '' ? undefined : (await this.ctx.credentials.resolve(credentialRef(config.apiKeyRef)))?.value
    if (config.apiKeyRef !== '' && key === undefined) throw new ImageGenerationUnavailableError()
    signal.throwIfAborted()
    const image = await requestImage({
      endpoint: config.endpoint,
      model: config.model,
      ...key === undefined ? {} : { key },
      prompt: prompt.trim(),
      sources,
      maxBytes: this.ctx.attachments.imageLimits.maxSourceImageBytes ?? this.ctx.attachments.imageLimits.maxImageBytes,
      signal,
    })
    signal.throwIfAborted()
    const attachment = await this.ctx.attachments.saveImage(image)
    signal.throwIfAborted()
    if (this.ctx.sessions.get(session.id) !== session) throw new Error('会话已关闭')
    const item: GalleryItem = {
      id: String(session.seq), ...attachment, prompt: prompt.trim(), model: config.model, createdAt: Date.now(),
      ...sourceIds[0] === undefined ? {} : { sourceImageId: sourceIds[0] },
    }
    session.append('image-gen/created', { item })
    return item
  }

  /** 画布写入只由当前活会话拥有；持久读取无需启动 Agent。 */
  saveCanvas(session: Session, revision: number, state: CanvasState): CanvasSnapshot {
    if (this.ctx.sessions.get(session.id) !== session) throw new Error('会话已关闭')
    return this.putCanvas(session, revision, state)
  }

  private putCanvas(session: Session, revision: number, state: CanvasState): CanvasSnapshot {
    const current = canvasSnapshot(session.events)
    if (revision !== current.revision) throw new CanvasConflictError()
    const next = { revision: revision + 1, state }
    session.append('image-gen/canvas', next)
    return next
  }

  /** 路由只接受 live session 或已持久存在的 session id；不创建或 resume Agent。 */
  async sessionEvents(id: SessionId): Promise<readonly SessionEvent[] | undefined> {
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) return live.events
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    try { return (await persistence.inspect(id)).events } catch { return undefined }
  }
}

/** 禁用或不完整配置由操作端再次拒绝，不依赖工具是否注册。 */
export class ImageGenerationUnavailableError extends Error {}

declare module '@deepseek-ai/cordis' { interface Context { imageGeneration: ImageGeneration } }

export default ImageGeneration
