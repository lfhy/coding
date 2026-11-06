/** 图像设置仅发布非机密字段；凭据明文只跨一次写请求。 */
import type { IApiClient } from 'coding-api-remotes/client'
import { createSnapshotStore, type SettingsScope, type SettingsScopeSnapshot, type SnapshotStore } from 'coding-client-runtime/client'

/** 与图像服务共用的设置命名空间。 */
export const SETTINGS_NAMESPACE = 'image-generation'
/** 不配置引用时 Host 使用的凭据名称。 */
export const DEFAULT_KEY_REF = 'IMAGE_GEN_API_KEY'
/** Host 持有默认值和字段级写入的用户设置。 */
export interface ImageSettings {
  enabled: boolean
  endpoint: string
  model: string
  apiKeyRef: string
  sizes?: Record<string, Record<string, string>>
  maxEditReferences?: number
}

/** 浏览器只校验 JSON 结构；有效比例、档位和像素范围由 Host 的设置校验拥有。 */
export function validSizeTableShape(value: unknown): value is Record<string, Record<string, string>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(tiers => tiers !== null && typeof tiers === 'object'
      && !Array.isArray(tiers) && Object.values(tiers as Record<string, unknown>).every(size => typeof size === 'string'))
}

/** 设置镜像不能接受非法或半截配置。 */
export function decodeImageSettings(value: unknown): ImageSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (typeof fields.enabled !== 'boolean' || typeof fields.endpoint !== 'string'
    || typeof fields.model !== 'string' || typeof fields.apiKeyRef !== 'string') return undefined
  const sizes = fields.sizes
  if (fields.maxEditReferences !== undefined && (!Number.isSafeInteger(fields.maxEditReferences)
    || (fields.maxEditReferences as number) < 1 || (fields.maxEditReferences as number) > 5)) return undefined
  if (sizes !== undefined && !validSizeTableShape(sizes)) return undefined
  return { enabled: fields.enabled, endpoint: fields.endpoint, model: fields.model, apiKeyRef: fields.apiKeyRef,
    ...(sizes === undefined ? {} : { sizes }),
    ...(fields.maxEditReferences === undefined ? {} : { maxEditReferences: fields.maxEditReferences as number }) }
}

/** 服务地址接受任意 HTTP(S) 主机；只拒绝凭据、查询参数和片段等非基址内容。 */
export function validEndpoint(text: string): boolean {
  try {
    const url = new URL(text)
    return ['http:', 'https:'].includes(url.protocol) && url.hostname !== ''
      && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
  } catch { return false }
}

/** 本机无鉴权选项仅适用于回环地址。 */
export function localEndpoint(text: string): boolean {
  if (!validEndpoint(text)) return false
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(text).hostname.toLowerCase())
}

/** 空引用表示无需凭据；非空引用不接受密钥明文、路径或特殊字符。 */
export function validKeyRef(value: string): boolean { return value === '' || /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) }

/** 设置页面只接收配置结果与凭据存在性。 */
export interface ImageSettingsView {
  section: SettingsScopeSnapshot<ImageSettings>
  credential: { status: 'loading' | 'ready' | 'error'; configured: boolean; writable: boolean; ref: string }
  saving: boolean
  failed: boolean
}

/**
 * 判断图像服务是否已配置并启用：入口只在为 true 时出现，避免未配置时留下无效按钮。
 * @param view - 设置页与入口共用的快照。
 * @returns 服务地址、模型和密钥都就绪且已启用时为 true。
 */
export function imageServiceReady(view: ImageSettingsView): boolean {
  const { section, credential } = view
  if (section.status !== 'ready' || section.value?.enabled !== true) return false
  const { endpoint, model, apiKeyRef } = section.value
  if (!endpoint || !model) return false
  return credential.status === 'ready' && credential.configured && credential.ref === apiKeyRef
}

/** 渲染器把此裸 observable 绑定为组件的 `useImageSettings`。 */
export interface ImageSettingsFace {
  hooks: { imageSettings: SnapshotStore<ImageSettingsView> }
  save: (changes: Partial<ImageSettings>, key: string) => Promise<ImageSettingsSaveResult>
}

/** 成功写入的密钥不需在后续字段失败时重复提交。 */
export interface ImageSettingsSaveResult { ok: boolean; keySaved: boolean }

/** 一份设置 scope 可供入口与设置页共用，卸载时拒绝发布迟到的凭据结果。 */
export class ImageSettingsController {
  readonly view: SnapshotStore<ImageSettingsView>
  private disposed = false
  private generation = 0
  private readonly unsubscribe: () => void

  /** @param scope - 图像服务的 Host 命名空间镜像。 @param api - 凭据存在性与单向写入 RPC。 */
  constructor(private readonly scope: SettingsScope<ImageSettings>, private readonly api: Pick<IApiClient, 'credentials'>) {
    this.view = createSnapshotStore<ImageSettingsView>({
      section: scope.getSnapshot(),
      credential: { ref: DEFAULT_KEY_REF, status: 'loading', configured: false, writable: false },
      saving: false, failed: false,
    })
    this.unsubscribe = scope.subscribe(() => {
      const previous = this.view.getSnapshot().section.value?.apiKeyRef
      this.view.update((draft) => { draft.section = scope.getSnapshot() })
      if (previous !== scope.getSnapshot().value?.apiKeyRef) void this.refreshCredential()
    })
    void this.refreshCredential()
  }

  /** 卸载后清除作用域订阅，并抛弃晚到的读回。 */
  dispose(): void { this.disposed = true; this.generation++; this.unsubscribe() }

  /** 连接重置或凭据更新后，只刷新当前引用的存在性。 */
  async refreshCredential(): Promise<void> {
    const ref = this.scope.getSnapshot().value?.apiKeyRef ?? DEFAULT_KEY_REF
    const generation = ++this.generation
    this.view.update((draft) => { draft.credential = { ref, status: 'loading', configured: false, writable: false } })
    if (ref === '') {
      this.view.update((draft) => { draft.credential = { ref, status: 'ready', configured: true, writable: false } })
      return
    }
    if (!validKeyRef(ref)) {
      this.view.update((draft) => { draft.credential.status = 'error' })
      return
    }
    try {
      const response = await this.api.credentials.describe({ refs: [ref] })
      if (this.disposed || generation !== this.generation) return
      if (!response.result.ok) throw new Error('credentials unavailable')
      const current = response.result.value.credentials[ref]
      this.view.update((draft) => {
        draft.credential = { ref, status: 'ready', configured: current?.configured ?? false, writable: current?.writable ?? true }
      })
    } catch {
      if (this.disposed || generation !== this.generation) return
      this.view.update((draft) => { draft.credential.status = 'error' })
    }
  }

  /**
   * 已启用服务的配置变更先停用，再写非机密字段与密钥，最后按表单意图恢复启用。
   * @param changes - 通过表单校验的非机密字段。
   * @param key - 仅在本次请求中使用的密钥明文，空值表示不更改。
   * @returns 完成状态及密钥写入确认；字段失败后可只重试尚未写入的部分。
   */
  async save(changes: Partial<ImageSettings>, key = ''): Promise<ImageSettingsSaveResult> {
    const rejected = { ok: false, keySaved: false }
    const section = this.scope.getSnapshot()
    if (this.view.getSnapshot().saving || section.status !== 'ready' || !section.writable) return rejected
    if ((changes.endpoint !== undefined && changes.endpoint !== '' && !validEndpoint(changes.endpoint))
      || (changes.model !== undefined && !changes.model.trim())
      || (changes.sizes !== undefined && (typeof changes.sizes !== 'object' || Array.isArray(changes.sizes)))
      || (changes.maxEditReferences !== undefined && (!Number.isSafeInteger(changes.maxEditReferences)
        || changes.maxEditReferences < 1 || changes.maxEditReferences > 5))
      || (changes.apiKeyRef !== undefined && !validKeyRef(changes.apiKeyRef))) return rejected
    const targetRef = changes.apiKeyRef ?? section.value?.apiKeyRef ?? DEFAULT_KEY_REF
    const targetEndpoint = changes.endpoint ?? section.value?.endpoint ?? ''
    if (targetRef === '' && targetEndpoint !== '' && !localEndpoint(targetEndpoint)) return rejected
    if (key.trim() && targetRef === '') return rejected
    const configChanged = (['endpoint', 'model', 'apiKeyRef', 'sizes', 'maxEditReferences'] as const)
      .some(field => changes[field] !== undefined && changes[field] !== section.value?.[field])
    const intendedEnabled = changes.enabled ?? section.value?.enabled ?? false
    this.view.update((draft) => { draft.saving = true; draft.failed = false })
    let accepted = true
    let keySaved = false
    try {
      if (configChanged && section.value?.enabled === true) {
        await this.scope.set('enabled', false)
        accepted = this.scope.getSnapshot().value?.enabled === false
      }
      for (const [field, value] of Object.entries(changes).filter(([field]) => field !== 'enabled' && accepted)) {
        if (this.disposed) { accepted = false; break }
        if (JSON.stringify(this.scope.getSnapshot().value?.[field as keyof ImageSettings]) === JSON.stringify(value)) continue
        await this.scope.set(field, value)
        if (JSON.stringify(this.scope.getSnapshot().value?.[field as keyof ImageSettings]) !== JSON.stringify(value)) {
          accepted = false; break
        }
      }
      if (accepted && key.trim()) {
        await this.refreshCredential()
        const current = this.view.getSnapshot().credential
        if (this.scope.getSnapshot().status !== 'ready' || !this.scope.getSnapshot().writable
          || current.status !== 'ready' || !current.writable || current.ref !== targetRef) accepted = false
        else {
          const response = await this.api.credentials.set({ ref: targetRef, value: key.trim() })
          keySaved = response.result.ok && !this.disposed
          accepted = keySaved
          if (keySaved) await this.refreshCredential()
        }
      }
      if (accepted && intendedEnabled) {
        let credential = this.view.getSnapshot().credential
        if (credential.ref !== targetRef || credential.status !== 'ready' || !credential.configured) {
          await this.refreshCredential()
          credential = this.view.getSnapshot().credential
        }
        accepted = credential.ref === targetRef && credential.status === 'ready' && credential.configured
      }
      if (accepted && this.scope.getSnapshot().value?.enabled !== intendedEnabled) {
        await this.scope.set('enabled', intendedEnabled)
        accepted = this.scope.getSnapshot().value?.enabled === intendedEnabled
      }
    } catch { accepted = false }
    if (!this.disposed) this.view.update((draft) => { draft.saving = false; draft.failed = !accepted })
    return { ok: accepted, keySaved }
  }

  /** @returns 给设置组件的非机密快照与操作。 */
  inject(): ImageSettingsFace {
    return { hooks: { imageSettings: this.view }, save: (changes, key) => this.save(changes, key) }
  }
}
