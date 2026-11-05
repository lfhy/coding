/** Host 图像能力：设置快照、逐次凭据、附件准入与会话日志归属。@module coding-image-gen */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from 'coding-credentials'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import type { ImageAttachmentRef, SaveImageAttachment } from 'coding-attachment'
import type { Session, SessionEvent, SessionId } from 'coding-session'
import { CanvasConflictError, canvasSnapshot, galleryItems } from './gallery.ts'
import { imageEndpoint, requestImage } from './openai.ts'
import { outputSizes, validateImageOutput, validateOutputSizes } from './output-sizes.ts'
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
  /** 编辑一次允许的参考图数量；默认 1，多图服务可设为 2 至 5。 */
  maxEditReferences: number
  /** 比例到分辨率档位的像素尺寸映射；空表使用原版兼容渠道的 1K 预设。 */
  sizes?: Record<string, Record<string, string>>
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default(''),
  model: z.string().default(''),
  apiKeyRef: z.string().role('credential-ref').default('IMAGE_GEN_API_KEY'),
  maxEditReferences: z.number().step(1).min(1).max(5).default(1),
  sizes: z.dict(z.dict(z.string())).default({}),
})

/** 设置保存前先校验端点与凭据引用，不在失败操作中回退旧配置。 */
function validateSettings(value: Config): void {
  if (value.endpoint !== '') imageEndpoint(value.endpoint, 'generations')
  if (value.model.length > 160 || value.model.includes('\n') || value.model.includes('\r')) {
    throw new TypeError('图像模型名称无效')
  }
  if (value.apiKeyRef !== '') credentialRef(value.apiKeyRef)
  if (!Number.isSafeInteger(value.maxEditReferences) || value.maxEditReferences < 1 || value.maxEditReferences > 5) {
    throw new TypeError('图片编辑参考图数量必须介于 1 至 5')
  }
  validateOutputSizes(value.sizes ?? {})
}

/** 会话身份来自 Host 的活会话或持久会话检查，而不是浏览器提供的附件 ID。 */
export class ImageGeneration extends Service {
  static inject = ['sessions', 'attachments', 'credentials']
  private current: () => Config
  private readonly availabilityListeners = new Set<() => void>()

  constructor(ctx: Context, config: Config = { enabled: false, endpoint: '', model: '', apiKeyRef: 'IMAGE_GEN_API_KEY',
    maxEditReferences: 1 }) {
    super(ctx, 'imageGeneration')
    // Loader 有可能直接交付部分配置；先按可选字段归一化，避免缺失的引用变成 undefined。
    const source: Partial<Config> = config
    const entry: Config = {
      enabled: source.enabled ?? false, endpoint: source.endpoint ?? '', model: source.model ?? '',
      apiKeyRef: source.apiKeyRef ?? 'IMAGE_GEN_API_KEY',
      maxEditReferences: source.maxEditReferences ?? 1,
      sizes: source.sizes ?? {},
    }
    validateSettings(entry)
    this.current = () => entry
    installSettingsSection(ctx, IMAGE_GENERATION_NAMESPACE, Config, entry, {
      validate: validateSettings,
      setSource: (source) => { this.current = source },
      onChange: () => { this.notifyAvailability() },
    })
    ctx.on('credentials/updated', (ref) => {
      if (ref === this.current().apiKeyRef) this.notifyAvailability()
    })
    installImageRoutes(ctx, this)
  }

  /**
   * 配置来源挂载、卸载或提交，以及当前凭据引用变化后通知消费方重新读取 `status()`。
   * 注册不主动通知，调用方应先订阅再做首次读取；监听器抛错不会回滚设置或凭据提交。
   * @param listener - 可用性需重新判定时调用的同步回调。
   * @returns 撤销该回调的函数。
   */
  watchAvailability(listener: () => void): () => void {
    this.availabilityListeners.add(listener)
    return () => { this.availabilityListeners.delete(listener) }
  }

  private notifyAvailability(): void {
    for (const listener of [...this.availabilityListeners]) {
      try { listener() } catch (error) { this.ctx.logger.warn('image-generation: availability listener failed', error) }
    }
  }

  /** 不包含端点、引用与密钥的配置可见性摘要；无凭据的本地端点可用。 */
  async status(): Promise<{ enabled: boolean; available: boolean; model: string }> {
    const { enabled, endpoint, model, apiKeyRef } = this.current()
    const configured = enabled && endpoint.trim() !== '' && model.trim() !== ''
    const credentialReady = !configured || apiKeyRef === '' || (await this.ctx.credentials.resolve(credentialRef(apiKeyRef))) !== undefined
    return { enabled, available: configured && credentialReady, model }
  }

  /** 返回比例与像素尺寸的非机密配置，供手动生图选择器使用。 */
  outputSizes(): Record<string, Record<string, string>> { return outputSizes(this.current().sizes) }

  /** 工作台的参考图上限与服务端本次编辑上限保持一致。 */
  maxEditReferences(): number { return this.current().maxEditReferences }

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

  /**
   * 把用户上传的参考图按附件策略准入并写入当前会话图库，供编辑接口引用。
   * 此操作不发送模型请求，也不要求生图服务已启用；失败不追加图片事件。
   * @param session - 当前仍在 Host 中的会话。
   * @param image - 原始编码字节与声明媒体类型。
   * @returns 此会话可用于 `edit_image` 的持久图库项。
   */
  async importReference(session: Session, image: SaveImageAttachment): Promise<GalleryItem> {
    if (this.ctx.sessions.get(session.id) !== session) throw new Error('会话不可用')
    const attachment = await this.ctx.attachments.saveImage(image)
    if (this.ctx.sessions.get(session.id) !== session) throw new Error('会话已关闭')
    const item: GalleryItem = {
      id: String(session.seq), ...attachment, prompt: '', model: 'import', createdAt: Date.now(),
    }
    session.append('image-gen/created', { item })
    return item
  }

  /** 图片保存完成后追加可重建的图库记录；成功前不暴露内容地址。 */
  async create(
    session: Session, prompt: string, sourceIds: readonly string[] = [],
    signal: AbortSignal = new AbortController().signal,
    output: { size?: string; quality?: string } = {},
  ): Promise<GalleryItem> {
    const current = this.current()
    const config: Config = { enabled: current.enabled, endpoint: current.endpoint,
      model: current.model, apiKeyRef: current.apiKeyRef,
      maxEditReferences: current.maxEditReferences, sizes: current.sizes ?? {} }
    if (!config.enabled || config.endpoint.trim() === '' || config.model.trim() === '') {
      throw new ImageGenerationUnavailableError()
    }
    if (typeof prompt !== 'string' || prompt.trim().length < 1 || prompt.length > 4000) {
      throw new TypeError('图片描述必须为 1 至 4000 字符')
    }
    validateImageOutput(output.size, output.quality, config.sizes)
    if (!this.ctx.sessions.get(session.id) || this.ctx.sessions.get(session.id) !== session) {
      throw new Error('会话不可用')
    }
    if (sourceIds.length > 5 || new Set(sourceIds).size !== sourceIds.length) {
      throw new TypeError('参考图片数量或标识无效')
    }
    if (sourceIds.length > config.maxEditReferences) throw new TypeError('参考图片超过当前图片服务单次编辑限额，请减少参考图或调整 maxEditReferences')
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
      ...output.size === undefined ? {} : { size: output.size },
      ...output.quality === undefined ? {} : { quality: output.quality },
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
      ...output.size === undefined ? {} : { size: output.size },
      ...output.quality === undefined ? {} : { quality: output.quality },
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
