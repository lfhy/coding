/** 联网搜索设置从提供方各自命名空间派生；凭据读取只有存在性与可写性。 */
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore, type SettingsScope, type SettingsScopeSnapshot, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Web 搜索提供方的持久选择。 */
export type SearchProvider = 'duckduckgo' | 'deepseek-official' | 'tavily'
/** 需要单独凭据的搜索提供方。 */
export type KeyedSearchProvider = Exclude<SearchProvider, 'duckduckgo'>
/** 搜索工具所属命名空间。 */
export interface WebSettings { searchProvider: SearchProvider }
/** DeepSeek 搜索提供方所属命名空间。 */
export interface DeepSeekSearchSettings { baseURL?: string; proxyURL?: string; model?: string; apiKeyEnv?: string }
/** DuckDuckGo 搜索提供方所属命名空间。 */
export interface DuckDuckGoSearchSettings { proxyURL?: string }
/** Tavily 搜索提供方所属命名空间。 */
export interface TavilySearchSettings { baseURL?: string; proxyURL?: string; apiKeyEnv?: string }
/** 表单提交的字符串；空值表示继承部署值。 */
export type DeepSeekSearchDraft = Record<keyof DeepSeekSearchSettings, string>
/** DuckDuckGo 草稿；空值清除专用代理。 */
export type DuckDuckGoSearchDraft = Record<keyof DuckDuckGoSearchSettings, string>
/** Tavily 草稿；空值继承部署值。 */
export type TavilySearchDraft = Record<keyof TavilySearchSettings, string>
/** 各提供方表单向所属设置 scope 提交的草稿。 */
export type SearchDraft = DeepSeekSearchDraft | DuckDuckGoSearchDraft | TavilySearchDraft

/**
 * 明确拒绝跨边界不认识的提供方。
 * @param value - Host 返回的 `web` 设置分节。
 * @returns 已识别的提供方选择；格式不符时为 undefined。
 */
export function decodeWeb(value: unknown): WebSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const provider = (value as Record<string, unknown>).searchProvider
  return provider === 'duckduckgo' || provider === 'deepseek-official' || provider === 'tavily'
    ? { searchProvider: provider }
    : undefined
}

/**
 * 严格收窄 Host 返回的地址、模型与凭据引用。
 * @param value - Host 返回的 DeepSeek 设置分节。
 * @returns 字段类型合法的设置；格式不符时为 undefined。
 */
export function decodeDeepSeek(value: unknown): DeepSeekSearchSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (fields.baseURL !== undefined && typeof fields.baseURL !== 'string') return undefined
  if (fields.proxyURL !== undefined && typeof fields.proxyURL !== 'string') return undefined
  if (fields.model !== undefined && typeof fields.model !== 'string') return undefined
  if (fields.apiKeyEnv !== undefined && typeof fields.apiKeyEnv !== 'string') return undefined
  return { ...(fields.baseURL === undefined ? {} : { baseURL: fields.baseURL }),
    ...(fields.proxyURL === undefined ? {} : { proxyURL: fields.proxyURL }),
    ...(fields.model === undefined ? {} : { model: fields.model }),
    ...(fields.apiKeyEnv === undefined ? {} : { apiKeyEnv: fields.apiKeyEnv }) }
}

/**
 * 严格收窄 DuckDuckGo 的代理地址。
 * @param value - Host 返回的 DuckDuckGo 设置分节。
 * @returns 字段类型合法的设置；格式不符时为 undefined。
 */
export function decodeDuckDuckGo(value: unknown): DuckDuckGoSearchSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { proxyURL } = value as Record<string, unknown>
  return proxyURL === undefined ? {} : typeof proxyURL === 'string' ? { proxyURL } : undefined
}

/**
 * 严格收窄 Tavily 的地址、代理和凭据引用。
 * @param value - Host 返回的 Tavily 设置分节。
 * @returns 字段类型合法的设置；格式不符时为 undefined。
 */
export function decodeTavily(value: unknown): TavilySearchSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (fields.baseURL !== undefined && typeof fields.baseURL !== 'string') return undefined
  if (fields.proxyURL !== undefined && typeof fields.proxyURL !== 'string') return undefined
  if (fields.apiKeyEnv !== undefined && typeof fields.apiKeyEnv !== 'string') return undefined
  return { ...(fields.baseURL === undefined ? {} : { baseURL: fields.baseURL }),
    ...(fields.proxyURL === undefined ? {} : { proxyURL: fields.proxyURL }),
    ...(fields.apiKeyEnv === undefined ? {} : { apiKeyEnv: fields.apiKeyEnv }) }
}

/** DeepSeek 搜索默认的凭据引用。 */
export const DEFAULT_KEY_REF = 'DEEPSEEK_SEARCH_API_KEY'
/** Tavily 搜索默认的凭据引用。 */
export const DEFAULT_TAVILY_KEY_REF = 'TAVILY_API_KEY'
const KEY_REF = /^[A-Za-z_][A-Za-z0-9_]*$/
type SearchSettingsField = keyof DeepSeekSearchSettings | keyof TavilySearchSettings | keyof DuckDuckGoSearchSettings

/**
 * 校验用户草稿；空字段表示清除用户覆盖，代理允许本机地址但不能包含凭据。
 * @param field - 提供方字段名。
 * @param value - 尚未提交的文本。
 * @param provider - 地址所属提供方；默认沿用公网域名校验。
 * @returns 字段可提交时为 true。
 */
export function validField(field: SearchSettingsField, value: string, provider: SearchProvider = 'tavily'): boolean {
  const text = value.trim()
  if (text === '') return true
  if (field === 'apiKeyEnv') return KEY_REF.test(text)
  if (field === 'model') return true
  if (!(field === 'proxyURL' ? /^https?:\/\//i : /^https:\/\//i).test(text)) return false
  try {
    const url = new URL(text)
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '')
    const authority = text.slice(text.indexOf('//') + 2).split(/[/?#]/, 1)[0]
    if ((field === 'proxyURL' ? url.protocol !== 'http:' && url.protocol !== 'https:' : url.protocol !== 'https:')
      || hostname === '' || authority?.includes('@') || url.username !== '' || url.password !== ''
      || text.includes('?') || text.includes('#')) return false
    if (field === 'proxyURL') return true
    return (provider === 'deepseek-official' || hostname.includes('.')) && !hostname.split('.').includes('')
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
  duckDuckGo: SettingsScopeSnapshot<DuckDuckGoSearchSettings>
  deepSeek: SettingsScopeSnapshot<DeepSeekSearchSettings>
  tavily: SettingsScopeSnapshot<TavilySearchSettings>
  credential: { provider?: KeyedSearchProvider; ref: string; status: 'loading' | 'ready' | 'error'; configured: boolean; writable: boolean }
  saving: boolean
  keySaving: boolean
  failed: boolean
  keyFailed: boolean
}

/** 由 renderer 绑定的 store 与普通操作回调。 */
export interface SearchSettingsFace {
  hooks: { searchSettings: SnapshotStore<SearchSettingsState> }
  chooseProvider: (provider: SearchProvider) => Promise<boolean>
  saveFields: (provider: SearchProvider, fields: SearchDraft) => Promise<boolean>
  saveKey: (value: string) => Promise<boolean>
}

/** 保持设置 revision 栅栏和凭据读取代次独立。 */
export class SearchSettingsController {
  /** 只含设置投影和凭据描述、不含密钥明文的共享状态。 */
  readonly store: SnapshotStore<SearchSettingsState>
  private credentialGeneration = 0
  private disposed = false
  private readonly subscriptions: Array<() => void>

  /**
   * @param web - `web` 命名空间派生 scope。
   * @param duckDuckGo - DuckDuckGo 提供方派生 scope。
   * @param deepSeek - DeepSeek 提供方派生 scope。
   * @param tavily - Tavily 提供方派生 scope。
   * @param api - 只用于凭据描述与单向写入的 API。
   */
  constructor(
    private readonly web: SettingsScope<WebSettings>,
    private readonly duckDuckGo: SettingsScope<DuckDuckGoSearchSettings>,
    private readonly deepSeek: SettingsScope<DeepSeekSearchSettings>,
    private readonly tavily: SettingsScope<TavilySearchSettings>,
    private readonly api: Pick<IApiClient, 'credentials'>,
  ) {
    this.store = createSnapshotStore<SearchSettingsState>({
      web: web.getSnapshot(), duckDuckGo: duckDuckGo.getSnapshot(), deepSeek: deepSeek.getSnapshot(), tavily: tavily.getSnapshot(),
      credential: { ref: '', status: 'loading', configured: false, writable: false },
      saving: false, keySaving: false, failed: false, keyFailed: false,
    })
    this.subscriptions = [
      web.subscribe(() => {
        const previous = this.store.getSnapshot().web.value?.searchProvider
        this.store.update((draft) => {
          draft.web = web.getSnapshot()
          if (previous !== draft.web.value?.searchProvider) { draft.failed = false; draft.keyFailed = false }
        })
        if (previous !== web.getSnapshot().value?.searchProvider) void this.readCredential()
      }),
      deepSeek.subscribe(() => {
        this.store.update((draft) => { draft.deepSeek = deepSeek.getSnapshot() })
        if (web.getSnapshot().value?.searchProvider === 'deepseek-official') void this.readCredential()
      }),
      duckDuckGo.subscribe(() => { this.store.update((draft) => { draft.duckDuckGo = duckDuckGo.getSnapshot() }) }),
      tavily.subscribe(() => {
        this.store.update((draft) => { draft.tavily = tavily.getSnapshot() })
        if (web.getSnapshot().value?.searchProvider === 'tavily') void this.readCredential()
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

  /**
   * 只刷新当前引用的凭据存在性。
   * @param ref - 外部更新通知涉及的凭据引用。
   */
  refreshCredential(ref: string): void {
    if (ref === this.store.getSnapshot().credential.ref) void this.readCredential()
  }

  private async readCredential(): Promise<void> {
    const provider = this.web.getSnapshot().value?.searchProvider
    const generation = ++this.credentialGeneration
    if (provider === 'duckduckgo' || provider === undefined) {
      this.store.update((draft) => { draft.credential = { ref: '', status: 'ready', configured: false, writable: false } })
      return
    }
    const ref = provider === 'tavily'
      ? this.tavily.getSnapshot().value?.apiKeyEnv ?? DEFAULT_TAVILY_KEY_REF
      : this.deepSeek.getSnapshot().value?.apiKeyEnv ?? DEFAULT_KEY_REF
    if (!KEY_REF.test(ref)) {
      this.store.update((draft) => { draft.credential = { provider, ref, status: 'error', configured: false, writable: false } })
      return
    }
    this.store.update((draft) => { draft.credential = { provider, ref, status: 'loading', configured: false, writable: false } })
    try {
      const response = await this.api.credentials.describe({ refs: [ref] })
      if (this.disposed || generation !== this.credentialGeneration) return
      if (!response.result.ok) throw new Error('credentials.describe refused')
      const view = response.result.value.credentials[ref]
      this.store.update((draft) => {
        draft.credential = { provider, ref, status: 'ready', configured: view?.configured ?? false, writable: view?.writable ?? true }
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
   * 依次提交所属提供方有变化的字段；每次写入由 scope 使用新的 revision。
   * @param provider - 草稿所属提供方。
   * @param fields - 文本草稿，空值清除用户覆盖。
   * @returns 所有字段被 Host 接受后为 true。
   */
  async saveFields(provider: SearchProvider, fields: SearchDraft): Promise<boolean> {
    const scope: SettingsScope<DeepSeekSearchSettings | TavilySearchSettings | DuckDuckGoSearchSettings> = provider === 'tavily'
      ? this.tavily : provider === 'duckduckgo' ? this.duckDuckGo : this.deepSeek
    const snapshot = scope.getSnapshot()
    if (this.store.getSnapshot().saving || snapshot.status !== 'ready' || !snapshot.writable) return false
    if (!Object.entries(fields).every(([field, value]) => validField(field as keyof DeepSeekSearchSettings, value, provider))) return false
    this.store.update((draft) => { draft.saving = true; draft.failed = false })
    let accepted = true
    try {
      for (const field of (provider === 'duckduckgo' ? ['proxyURL'] : provider === 'tavily'
        ? ['baseURL', 'proxyURL', 'apiKeyEnv'] : ['baseURL', 'proxyURL', 'model', 'apiKeyEnv'])) {
        const raw = (fields as Record<string, string>)[field]
        if (raw === undefined) { accepted = false; break }
        const value = raw.trim()
        const current = scope.getSnapshot()
        const user = current.user as Record<string, unknown> | undefined
        if (value === '') {
          if (user !== undefined && Object.hasOwn(user, field)) await scope.unset(field)
          if (Object.hasOwn(scope.getSnapshot().user ?? {}, field)) accepted = false
        } else if (value !== (current.value as Record<string, string> | undefined)?.[field]) {
          await scope.set(field, value)
          if ((scope.getSnapshot().value as Record<string, string> | undefined)?.[field] !== value) accepted = false
        }
        if (!accepted) break
      }
    } catch { accepted = false }
    this.store.update((draft) => {
      draft.saving = false
      draft.failed = !accepted && draft.web.value?.searchProvider === provider
    })
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
      if (response.result.ok && credential.provider === this.store.getSnapshot().web.value?.searchProvider
        && credential.ref === this.store.getSnapshot().credential.ref) {
        await this.readCredential()
        const after = this.store.getSnapshot().credential
        accepted = after.provider === credential.provider && after.ref === credential.ref && after.status === 'ready' && after.configured
      }
    } catch { /* 拒绝通过下方状态提示，不保留密钥到共享 store。 */ }
    this.store.update((draft) => {
      draft.keySaving = false
      draft.keyFailed = !accepted && draft.credential.provider === credential.provider && draft.credential.ref === credential.ref
    })
    return accepted
  }

  /**
   * 将非机密状态和操作暴露给设置组件。
   * @returns renderer 注册使用的普通回调和裸 observable。
   */
  inject(): SearchSettingsFace {
    return {
      hooks: { searchSettings: this.store },
      chooseProvider: provider => this.chooseProvider(provider),
      saveFields: (provider, fields) => this.saveFields(provider, fields),
      saveKey: value => this.saveKey(value),
    }
  }
}
