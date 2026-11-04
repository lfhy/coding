/** 图像设置仅发布非机密字段；凭据明文只跨一次写请求。 */
import type { IApiClient } from 'coding-api-remotes/client'
import { createSnapshotStore, type SettingsScope, type SettingsScopeSnapshot, type SnapshotStore } from 'coding-client-runtime/client'

/** 与图像服务共用的设置命名空间。 */
export const SETTINGS_NAMESPACE = 'image-generation'
/** 不配置引用时 Host 使用的凭据名称。 */
export const DEFAULT_KEY_REF = 'IMAGE_GEN_API_KEY'
/** Host 持有默认值和字段级写入的用户设置。 */
export interface ImageSettings { enabled: boolean; endpoint: string; model: string; apiKeyRef: string }

/** 设置镜像不能接受非法或半截配置。 */
export function decodeImageSettings(value: unknown): ImageSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (typeof fields.enabled !== 'boolean' || typeof fields.endpoint !== 'string'
    || typeof fields.model !== 'string' || typeof fields.apiKeyRef !== 'string') return undefined
  return { enabled: fields.enabled, endpoint: fields.endpoint, model: fields.model, apiKeyRef: fields.apiKeyRef }
}

/** 服务地址允许 HTTPS 与回环 HTTP，拒绝其他明文地址及嵌入的凭据。 */
export function validEndpoint(text: string): boolean {
  try {
    if (!/^https?:\/\//iu.test(text)) return false
    const url = new URL(text)
    const authority = text.slice(text.indexOf('//') + 2).split(/[/?#]/u, 1)[0]
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
    return (loopback || url.protocol === 'https:' && url.hostname.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/u.test(url.hostname))
      && (url.protocol === 'https:' || url.protocol === 'http:' && loopback) && !authority?.includes('@')
      && url.username === '' && url.password === '' && !text.includes('?') && !text.includes('#')
  } catch { return false }
}

/** 空引用表示无需凭据；非空引用不接受密钥明文、路径或特殊字符。 */
export function validKeyRef(value: string): boolean { return value === '' || /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) }

/** 设置页面只接收配置结果与凭据存在性。 */
export interface ImageSettingsView {
  section: SettingsScopeSnapshot<ImageSettings>
  credential: { status: 'loading' | 'ready' | 'error'; configured: boolean; writable: boolean; ref: string }
  saving: boolean
  failed: boolean
  keySaving: boolean
  keyFailed: boolean
}

/** 渲染器把此裸 observable 绑定为组件的 `useImageSettings`。 */
export interface ImageSettingsFace {
  hooks: { imageSettings: SnapshotStore<ImageSettingsView> }
  save: (changes: Partial<ImageSettings>) => Promise<boolean>
  saveKey: (value: string) => Promise<boolean>
}

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
      saving: false, failed: false, keySaving: false, keyFailed: false,
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
   * 保存字段时按各次返回的新 revision 顺序写入；未配置可保存启用偏好，但 Host 不会报告可用。
   * @param changes - 通过表单校验的非机密字段。
   * @returns 所有写入均被 Host 投影时为 true。
   */
  async save(changes: Partial<ImageSettings>): Promise<boolean> {
    const section = this.scope.getSnapshot()
    if (this.view.getSnapshot().saving || section.status !== 'ready' || !section.writable) return false
    if ((changes.endpoint !== undefined && changes.endpoint !== '' && !validEndpoint(changes.endpoint))
      || (changes.model !== undefined && !changes.model.trim())
      || (changes.apiKeyRef !== undefined && !validKeyRef(changes.apiKeyRef))) return false
    this.view.update((draft) => { draft.saving = true; draft.failed = false })
    let accepted = true
    try {
      for (const [field, value] of Object.entries(changes)) {
        if (this.disposed) { accepted = false; break }
        if (this.scope.getSnapshot().value?.[field as keyof ImageSettings] === value) continue
        await this.scope.set(field, value)
        if (this.scope.getSnapshot().value?.[field as keyof ImageSettings] !== value) { accepted = false; break }
      }
    } catch { accepted = false }
    if (!this.disposed) this.view.update((draft) => { draft.saving = false; draft.failed = !accepted })
    return accepted
  }

  /**
   * 密钥明文不进入状态镜像，提交后只询问当前引用是否已配置。
   * @param value - 表单持有的密钥明文。
   * @returns Host 接受且随后确认配置时为 true。
   */
  async saveKey(value: string): Promise<boolean> {
    const credential = this.view.getSnapshot().credential
    if (!value.trim() || this.view.getSnapshot().keySaving || credential.status !== 'ready' || !credential.writable) return false
    this.view.update((draft) => { draft.keySaving = true; draft.keyFailed = false })
    let accepted = false
    try {
      const response = await this.api.credentials.set({ ref: credential.ref, value: value.trim() })
      if (response.result.ok && !this.disposed && credential.ref === this.view.getSnapshot().credential.ref) {
        await this.refreshCredential()
        accepted = this.view.getSnapshot().credential.configured && this.view.getSnapshot().credential.status === 'ready'
      }
    } catch { /* 保存失败仅公开安全状态。 */ }
    if (!this.disposed) this.view.update((draft) => { draft.keySaving = false; draft.keyFailed = !accepted })
    return accepted
  }

  /** @returns 给设置组件的非机密快照与操作。 */
  inject(): ImageSettingsFace {
    return { hooks: { imageSettings: this.view }, save: changes => this.save(changes), saveKey: value => this.saveKey(value) }
  }
}
