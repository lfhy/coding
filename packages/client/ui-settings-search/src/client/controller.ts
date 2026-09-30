/** 联网搜索设置从两个命名空间派生；凭据读取只有存在性与可写性。 */
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore, type SettingsScope, type SettingsScopeSnapshot, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Web 搜索提供方的持久选择。 */
export type SearchProvider = 'duckduckgo' | 'deepseek-official'
/** 搜索工具所属命名空间。 */
export interface WebSettings { searchProvider: SearchProvider }
/** DeepSeek 搜索提供方所属命名空间。 */
export interface DeepSeekSearchSettings { baseURL?: string; model?: string; apiKeyEnv?: string }
/** 表单提交的三个字符串；空值表示继承部署值。 */
export type DeepSeekSearchDraft = Record<keyof DeepSeekSearchSettings, string>

/** 明确拒绝跨边界不认识的提供方。 */
export function decodeWeb(value: unknown): WebSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const provider = (value as Record<string, unknown>).searchProvider
  return provider === 'duckduckgo' || provider === 'deepseek-official'
    ? { searchProvider: provider }
    : undefined
}

/** 严格收窄 Host 返回的地址、模型与凭据引用。 */
export function decodeDeepSeek(value: unknown): DeepSeekSearchSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (fields.baseURL !== undefined && typeof fields.baseURL !== 'string') return undefined
  if (fields.model !== undefined && typeof fields.model !== 'string') return undefined
  if (fields.apiKeyEnv !== undefined && typeof fields.apiKeyEnv !== 'string') return undefined
  return { ...(fields.baseURL === undefined ? {} : { baseURL: fields.baseURL }),
    ...(fields.model === undefined ? {} : { model: fields.model }),
    ...(fields.apiKeyEnv === undefined ? {} : { apiKeyEnv: fields.apiKeyEnv }) }
}

export const DEFAULT_KEY_REF = 'DEEPSEEK_SEARCH_API_KEY'
const KEY_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 用户草稿的本地校验；空字段表示清除用户覆盖。 */
export function validField(field: keyof DeepSeekSearchSettings, value: string): boolean {
  const text = value.trim()
  if (text === '') return true
  if (field === 'apiKeyEnv') return KEY_REF.test(text)
  if (field === 'model') return true
  try {
    const url = new URL(text)
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '')
    return url.protocol === 'https:' && hostname !== '' && url.username === ''
      && url.password === '' && url.search === '' && url.hash === ''
      && !/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && !hostname.includes(':')
      && hostname !== 'localhost' && !hostname.endsWith('.localhost')
      && !hostname.endsWith('.local') && !hostname.endsWith('.internal')
  } catch {
    return false
  }
}

/** 组件消费的非机密状态；密钥草稿始终留在组件私有 state 中。 */
export interface SearchSettingsState {
  web: SettingsScopeSnapshot<WebSettings>
  deepSeek: SettingsScopeSnapshot<DeepSeekSearchSettings>
  credential: { ref: string; status: 'loading' | 'ready' | 'error'; configured: boolean; writable: boolean }
  saving: boolean
  keySaving: boolean
  failed: boolean
  keyFailed: boolean
}

/** 由 renderer 绑定的 store 与普通操作回调。 */
export interface SearchSettingsFace {
  hooks: { searchSettings: SnapshotStore<SearchSettingsState> }
  chooseProvider: (provider: SearchProvider) => Promise<boolean>
  saveFields: (fields: DeepSeekSearchDraft) => Promise<boolean>
  saveKey: (value: string) => Promise<boolean>
}

/** 保持设置 revision 栅栏和凭据读取代次独立。 */
export class SearchSettingsController {
  readonly store: SnapshotStore<SearchSettingsState>
  private credentialGeneration = 0
  private disposed = false
  private readonly subscriptions: Array<() => void>

  /**
   * @param web - `web` 命名空间派生 scope。
   * @param deepSeek - DeepSeek 提供方派生 scope。
   * @param api - 只用于凭据描述与单向写入的 API。
   */
  constructor(
    private readonly web: SettingsScope<WebSettings>,
    private readonly deepSeek: SettingsScope<DeepSeekSearchSettings>,
    private readonly api: Pick<IApiClient, 'credentials'>,
  ) {
    this.store = createSnapshotStore<SearchSettingsState>({
      web: web.getSnapshot(), deepSeek: deepSeek.getSnapshot(),
      credential: { ref: '', status: 'loading', configured: false, writable: false },
      saving: false, keySaving: false, failed: false, keyFailed: false,
    })
    this.subscriptions = [
      web.subscribe(() => { this.store.update((draft) => { draft.web = web.getSnapshot() }) }),
      deepSeek.subscribe(() => {
        this.store.update((draft) => { draft.deepSeek = deepSeek.getSnapshot() })
        void this.readCredential()
      }),
    ]
    void this.readCredential()
  }

  /** 卸载后停止发布迟到的凭据响应。 */
  dispose(): void {
    this.disposed = true
    this.credentialGeneration++
    for (const unsubscribe of this.subscriptions) unsubscribe()
  }

  /** 连接代次变化时，同名引用也需要重新询问新 Host。 */
  refreshAfterReset(): void { void this.readCredential() }

  /** 只刷新当前引用的凭据存在性。 */
  refreshCredential(ref: string): void {
    if (ref === this.store.getSnapshot().credential.ref) void this.readCredential()
  }

  private async readCredential(): Promise<void> {
    const ref = this.deepSeek.getSnapshot().value?.apiKeyEnv ?? DEFAULT_KEY_REF
    if (!KEY_REF.test(ref)) return
    const generation = ++this.credentialGeneration
    const old = this.store.getSnapshot().credential
    if (old.ref !== ref) {
      this.store.update((draft) => { draft.credential = { ref, status: 'loading', configured: false, writable: false } })
    }
    try {
      const response = await this.api.credentials.describe({ refs: [ref] })
      if (this.disposed || generation !== this.credentialGeneration) return
      if (!response.result.ok) throw new Error('credentials.describe refused')
      const view = response.result.value.credentials[ref]
      this.store.update((draft) => {
        draft.credential = { ref, status: 'ready', configured: view?.configured ?? false, writable: view?.writable ?? true }
      })
    } catch {
      if (this.disposed || generation !== this.credentialGeneration) return
      this.store.update((draft) => { draft.credential.status = 'error' })
    }
  }

  /**
   * 更改后续搜索使用的提供方；scope 将当前命名空间 revision 交给 Host。
   * @param provider - 目标提供方。
   * @returns Host 重新投影后是否真的接受该选择。
   */
  async chooseProvider(provider: SearchProvider): Promise<boolean> {
    if (this.store.getSnapshot().saving || !this.web.getSnapshot().writable) return false
    this.store.update((draft) => { draft.saving = true; draft.failed = false })
    try {
      await this.web.set('searchProvider', provider)
      const accepted = this.web.getSnapshot().value?.searchProvider === provider
      this.store.update((draft) => { draft.failed = !accepted })
      return accepted
    } catch {
      this.store.update((draft) => { draft.failed = true })
      return false
    } finally {
      this.store.update((draft) => { draft.saving = false })
    }
  }

  /**
   * 依次提交有变化的字段；每次写入由 scope 使用新的 revision。
   * @param fields - 文本草稿，空值清除用户覆盖。
   * @returns 所有字段被 Host 接受后为 true。
   */
  async saveFields(fields: DeepSeekSearchDraft): Promise<boolean> {
    const snapshot = this.deepSeek.getSnapshot()
    if (this.store.getSnapshot().saving || snapshot.status !== 'ready' || !snapshot.writable) return false
    if (!Object.entries(fields).every(([field, value]) => validField(field as keyof DeepSeekSearchSettings, value))) return false
    this.store.update((draft) => { draft.saving = true; draft.failed = false })
    let accepted = true
    try {
      for (const field of ['baseURL', 'model', 'apiKeyEnv'] as const) {
        const value = fields[field].trim()
        const current = this.deepSeek.getSnapshot()
        const user = current.user as Record<string, unknown> | undefined
        if (value === '') {
          if (user !== undefined && Object.hasOwn(user, field)) await this.deepSeek.unset(field)
          if (Object.hasOwn(this.deepSeek.getSnapshot().user ?? {}, field)) accepted = false
        } else if (value !== current.value?.[field]) {
          await this.deepSeek.set(field, value)
          if (this.deepSeek.getSnapshot().value?.[field] !== value) accepted = false
        }
        if (!accepted) break
      }
    } catch { accepted = false }
    this.store.update((draft) => { draft.saving = false; draft.failed = !accepted })
    return accepted
  }

  /**
   * 密钥只作为请求参数经过此方法，绝不写入 store。
   * @param value - 用户输入的密钥明文。
   * @returns Host 接受且重新报告已配置时为 true。
   */
  async saveKey(value: string): Promise<boolean> {
    const { credential, keySaving } = this.store.getSnapshot()
    if (value.trim() === '' || keySaving || credential.status !== 'ready' || !credential.writable) return false
    this.store.update((draft) => { draft.keySaving = true; draft.keyFailed = false })
    let accepted = false
    try {
      const response = await this.api.credentials.set({ ref: credential.ref, value: value.trim() })
      if (response.result.ok) {
        await this.readCredential()
        const after = this.store.getSnapshot().credential
        accepted = after.ref === credential.ref && after.status === 'ready' && after.configured
      }
    } catch { /* 拒绝通过下方状态提示，不保留密钥到共享 store。 */ }
    this.store.update((draft) => { draft.keySaving = false; draft.keyFailed = !accepted })
    return accepted
  }

  /** @returns renderer 注册使用的普通回调和裸 observable。 */
  inject(): SearchSettingsFace {
    return {
      hooks: { searchSettings: this.store },
      chooseProvider: provider => this.chooseProvider(provider),
      saveFields: fields => this.saveFields(fields),
      saveKey: value => this.saveKey(value),
    }
  }
}
