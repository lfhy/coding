/**
 * 联网搜索设置从各提供方自己的命名空间派生；凭据读取只有存在性与可写性。
 *
 * 出站与模型渠道共用同一套语义（直连／内置代理池／自定义代理）：这里镜像 Host 侧
 * `coding-proxy-pool` 的 `OutboundConfig` 形状，只负责表单校验与写入，真正的地址
 * 解析由各搜索提供方在请求期向代理池询问。
 */
import type { IApiClient } from 'coding-api-remotes/client'
import {
  createSnapshotStore, type SettingsScope, type SettingsScopeSnapshot, type SnapshotStore,
} from 'coding-client-runtime/client'

/**
 * 设置页可选的搜索提供方。
 *
 * `duckduckgo`／`bing`／`searxng` 完全免密钥；`anysearch`／`firecrawl`／`keenable`／
 * `parallel` 有匿名额度、密钥从环境变量读取；`deepseek-official`／`tavily` 用凭据服务。
 */
export type SearchProvider =
  | 'duckduckgo'
  | 'bing'
  | 'searxng'
  | 'anysearch'
  | 'firecrawl'
  | 'keenable'
  | 'parallel'
  | 'deepseek-official'
  | 'tavily'
/** 需要单独凭据的搜索提供方。 */
export type KeyedSearchProvider = Extract<SearchProvider, 'deepseek-official' | 'tavily'>
/** 搜索工具所属命名空间。 */
export interface WebSettings { searchProvider: SearchProvider }
/** 渠道级出站选择，与模型渠道同形。 */
export interface OutboundSettings { mode: 'direct' | 'pool' | 'custom'; customUrl?: string }
/** DeepSeek 搜索提供方所属命名空间。 */
export interface DeepSeekSearchSettings { baseURL?: string; outbound?: OutboundSettings; model?: string; apiKeyEnv?: string }
/** DuckDuckGo 搜索提供方所属命名空间。 */
export interface DuckDuckGoSearchSettings { outbound?: OutboundSettings }
/** Bing 搜索提供方所属命名空间。 */
export interface BingSearchSettings { market?: string; outbound?: OutboundSettings }
/** Tavily 搜索提供方所属命名空间。 */
export interface TavilySearchSettings { baseURL?: string; outbound?: OutboundSettings; apiKeyEnv?: string }
/** 只带出站选择的免费来源（DuckDuckGo／SearXNG）。 */
export interface FreeSearchSettings { outbound?: OutboundSettings }
/** 有匿名额度、可覆盖基址的免费来源（AnySearch／Firecrawl／Keenable／Parallel）。 */
export interface EnvKeyedSearchSettings { baseURL?: string; outbound?: OutboundSettings }

/** 每个来源暴露给表单的文本字段。 */
export const SOURCE_FIELDS: Record<SearchProvider, readonly ('baseURL' | 'market' | 'model' | 'apiKeyEnv')[]> = {
  duckduckgo: [],
  bing: ['market'],
  searxng: [],
  anysearch: ['baseURL'],
  firecrawl: ['baseURL'],
  keenable: ['baseURL'],
  parallel: ['baseURL'],
  'deepseek-official': ['baseURL', 'model', 'apiKeyEnv'],
  tavily: ['baseURL', 'apiKeyEnv'],
}

/** 从环境变量取密钥的来源，面板提示用。 */
export const SOURCE_KEY_ENV: Partial<Record<SearchProvider, string>> = {
  anysearch: 'ANYSEARCH_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
  keenable: 'KEENABLE_API_KEY',
  parallel: 'PARALLEL_API_KEY',
}
/** 一次表单提交的草稿：字符串字段为空表示清除覆盖，出站是整体对象。 */
export type SearchDraft = Record<string, string | OutboundSettings>

/** DeepSeek 搜索默认的凭据引用。 */
export const DEFAULT_KEY_REF = 'DEEPSEEK_SEARCH_API_KEY'
/** Tavily 搜索默认的凭据引用。 */
export const DEFAULT_TAVILY_KEY_REF = 'TAVILY_API_KEY'
const KEY_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 收窄出站选择；形状不符时返回 undefined，避免把坏值写回设置。
 * @param value - Host 返回的出站字段。
 * @returns 合法的出站选择；缺失或形状不符时为 undefined。
 */
export function decodeOutbound(value: unknown): OutboundSettings | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const mode = record.mode
  if (mode !== 'direct' && mode !== 'pool' && mode !== 'custom') return undefined
  if (record.customUrl !== undefined && typeof record.customUrl !== 'string') return undefined
  return { mode, ...record.customUrl === undefined ? {} : { customUrl: record.customUrl } }
}

/**
 * 判断一次出站选择能否保存：自定义模式要求不含凭据、查询与片段的 http(s) 地址。
 * @param value - 表单里的出站选择。
 * @returns 可提交时为 true；直连与内置代理池总是可提交。
 */
export function validOutbound(value: OutboundSettings): boolean {
  if (value.mode !== 'custom') return true
  const text = value.customUrl?.trim() ?? ''
  if (!/^https?:\/\//i.test(text)) return false
  try {
    const url = new URL(text)
    const authority = text.slice(text.indexOf('//') + 2).split(/[/?#]/, 1)[0]
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.hostname === '' || authority?.includes('@') || url.username !== '' || url.password !== '') return false
    return !text.includes('?') && !text.includes('#')
  } catch {
    return false
  }
}

/**
 * 明确拒绝跨边界不认识的提供方。
 * @param value - Host 返回的 `web` 设置分节。
 * @returns 已识别的提供方选择；格式不符时为 undefined。
 */
export function decodeWeb(value: unknown): WebSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const provider = (value as Record<string, unknown>).searchProvider
  return Object.hasOwn(SOURCE_FIELDS, provider as string) ? { searchProvider: provider as SearchProvider } : undefined
}

/**
 * 收窄只带出站选择的免费来源（DuckDuckGo／SearXNG）。
 * @param value - Host 返回的来源设置分节。
 * @returns 合法的设置；出站形状不符时为 undefined。
 */
export function decodeFree(value: unknown): FreeSearchSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const outbound = decodeOutbound((value as Record<string, unknown>).outbound)
  if ((value as Record<string, unknown>).outbound !== undefined && outbound === undefined) return undefined
  return outbound === undefined ? {} : { outbound }
}

/** 收窄一个免费来源的基址与出站选择（AnySearch／Firecrawl／Keenable／Parallel）。 */
export function decodeEnvKeyed(value: unknown): EnvKeyedSearchSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (fields.baseURL !== undefined && typeof fields.baseURL !== 'string') return undefined
  const outbound = decodeOutbound(fields.outbound)
  if (fields.outbound !== undefined && outbound === undefined) return undefined
  return { ...(fields.baseURL === undefined ? {} : { baseURL: fields.baseURL }),
    ...(outbound === undefined ? {} : { outbound }) }
}

/**
 * 严格收窄 Host 返回的地址、模型、出站与凭据引用。
 * @param value - Host 返回的 DeepSeek 设置分节。
 * @returns 字段类型合法的设置；格式不符时为 undefined。
 */
export function decodeDeepSeek(value: unknown): DeepSeekSearchSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (fields.baseURL !== undefined && typeof fields.baseURL !== 'string') return undefined
  if (fields.model !== undefined && typeof fields.model !== 'string') return undefined
  if (fields.apiKeyEnv !== undefined && typeof fields.apiKeyEnv !== 'string') return undefined
  const outbound = decodeOutbound(fields.outbound)
  if (fields.outbound !== undefined && outbound === undefined) return undefined
  return { ...(fields.baseURL === undefined ? {} : { baseURL: fields.baseURL }),
    ...(outbound === undefined ? {} : { outbound }),
    ...(fields.model === undefined ? {} : { model: fields.model }),
    ...(fields.apiKeyEnv === undefined ? {} : { apiKeyEnv: fields.apiKeyEnv }) }
}

/**
 * 严格收窄 DuckDuckGo 的出站选择。
 * @param value - Host 返回的 DuckDuckGo 设置分节。
 * @returns 字段类型合法的设置；格式不符时为 undefined。
 */
export function decodeDuckDuckGo(value: unknown): DuckDuckGoSearchSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const outbound = decodeOutbound(record.outbound)
  if (record.outbound !== undefined && outbound === undefined) return undefined
  return outbound === undefined ? {} : { outbound }
}

/**
 * 严格收窄 Bing 的 market 与出站选择。
 * @param value - Host 返回的 Bing 设置分节。
 * @returns 字段类型合法的设置；格式不符时为 undefined。
 */
export function decodeBing(value: unknown): BingSearchSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (fields.market !== undefined && typeof fields.market !== 'string') return undefined
  const outbound = decodeOutbound(fields.outbound)
  if (fields.outbound !== undefined && outbound === undefined) return undefined
  return { ...(fields.market === undefined ? {} : { market: fields.market }),
    ...(outbound === undefined ? {} : { outbound }) }
}

/**
 * 严格收窄 Tavily 的地址、出站与凭据引用。
 * @param value - Host 返回的 Tavily 设置分节。
 * @returns 字段类型合法的设置；格式不符时为 undefined。
 */
export function decodeTavily(value: unknown): TavilySearchSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (fields.baseURL !== undefined && typeof fields.baseURL !== 'string') return undefined
  if (fields.apiKeyEnv !== undefined && typeof fields.apiKeyEnv !== 'string') return undefined
  const outbound = decodeOutbound(fields.outbound)
  if (fields.outbound !== undefined && outbound === undefined) return undefined
  return { ...(fields.baseURL === undefined ? {} : { baseURL: fields.baseURL }),
    ...(outbound === undefined ? {} : { outbound }),
    ...(fields.apiKeyEnv === undefined ? {} : { apiKeyEnv: fields.apiKeyEnv }) }
}

/**
 * 校验用户键入的文本字段；空字段表示清除用户覆盖。
 * @param field - 提供方字段名。
 * @param value - 尚未提交的文本。
 * @param provider - 地址所属提供方；默认沿用公网域名校验。
 * @returns 字段可提交时为 true。
 */
export function validField(
  field: 'baseURL' | 'market' | 'model' | 'apiKeyEnv',
  value: string,
  provider: SearchProvider = 'tavily',
): boolean {
  const text = value.trim()
  if (text === '') return true
  if (field === 'apiKeyEnv') return KEY_REF.test(text)
  if (field === 'model' || field === 'market') return true
  if (!/^https:\/\//i.test(text)) return false
  try {
    const url = new URL(text)
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '')
    const authority = text.slice(text.indexOf('//') + 2).split(/[/?#]/, 1)[0]
    if (url.protocol !== 'https:' || hostname === '' || authority?.includes('@')
      || url.username !== '' || url.password !== '' || text.includes('?') || text.includes('#')) return false
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
  bing: SettingsScopeSnapshot<BingSearchSettings>
  searxng: SettingsScopeSnapshot<FreeSearchSettings>
  anysearch: SettingsScopeSnapshot<EnvKeyedSearchSettings>
  firecrawl: SettingsScopeSnapshot<EnvKeyedSearchSettings>
  keenable: SettingsScopeSnapshot<EnvKeyedSearchSettings>
  parallel: SettingsScopeSnapshot<EnvKeyedSearchSettings>
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
  private readonly duckDuckGo: SettingsScope<DuckDuckGoSearchSettings>
  private readonly bing: SettingsScope<BingSearchSettings>
  private readonly searxng: SettingsScope<FreeSearchSettings>
  private readonly anysearch: SettingsScope<EnvKeyedSearchSettings>
  private readonly firecrawl: SettingsScope<EnvKeyedSearchSettings>
  private readonly keenable: SettingsScope<EnvKeyedSearchSettings>
  private readonly parallel: SettingsScope<EnvKeyedSearchSettings>
  private readonly deepSeek: SettingsScope<DeepSeekSearchSettings>
  private readonly tavily: SettingsScope<TavilySearchSettings>

  /**
   * @param web - `web` 命名空间派生 scope。
   * @param duckDuckGo - DuckDuckGo 提供方派生 scope。
   * @param bing - Bing 提供方派生 scope。
   * @param deepSeek - DeepSeek 提供方派生 scope。
   * @param tavily - Tavily 提供方派生 scope。
   * @param api - 只用于凭据描述与单向写入的 API。
   */
  constructor(
    private readonly web: SettingsScope<WebSettings>,
    scopes: {
      duckDuckGo: SettingsScope<DuckDuckGoSearchSettings>
      bing: SettingsScope<BingSearchSettings>
      searxng: SettingsScope<FreeSearchSettings>
      anysearch: SettingsScope<EnvKeyedSearchSettings>
      firecrawl: SettingsScope<EnvKeyedSearchSettings>
      keenable: SettingsScope<EnvKeyedSearchSettings>
      parallel: SettingsScope<EnvKeyedSearchSettings>
      deepSeek: SettingsScope<DeepSeekSearchSettings>
      tavily: SettingsScope<TavilySearchSettings>
    },
    private readonly api: Pick<IApiClient, 'credentials'>,
  ) {
    const { duckDuckGo, bing, searxng, anysearch, firecrawl, keenable, parallel, deepSeek, tavily } = scopes
    this.duckDuckGo = duckDuckGo
    this.bing = bing
    this.searxng = searxng
    this.anysearch = anysearch
    this.firecrawl = firecrawl
    this.keenable = keenable
    this.parallel = parallel
    this.deepSeek = deepSeek
    this.tavily = tavily
    this.store = createSnapshotStore<SearchSettingsState>({
      web: web.getSnapshot(), duckDuckGo: duckDuckGo.getSnapshot(), bing: bing.getSnapshot(),
      searxng: searxng.getSnapshot(), anysearch: anysearch.getSnapshot(), firecrawl: firecrawl.getSnapshot(),
      keenable: keenable.getSnapshot(), parallel: parallel.getSnapshot(),
      deepSeek: deepSeek.getSnapshot(), tavily: tavily.getSnapshot(),
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
      bing.subscribe(() => { this.store.update((draft) => { draft.bing = bing.getSnapshot() }) }),
      searxng.subscribe(() => { this.store.update((draft) => { draft.searxng = searxng.getSnapshot() }) }),
      anysearch.subscribe(() => { this.store.update((draft) => { draft.anysearch = anysearch.getSnapshot() }) }),
      firecrawl.subscribe(() => { this.store.update((draft) => { draft.firecrawl = firecrawl.getSnapshot() }) }),
      keenable.subscribe(() => { this.store.update((draft) => { draft.keenable = keenable.getSnapshot() }) }),
      parallel.subscribe(() => { this.store.update((draft) => { draft.parallel = parallel.getSnapshot() }) }),
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
    if (provider !== 'deepseek-official' && provider !== 'tavily') {
      this.store.update((draft) => { draft.credential = { ref: '', status: 'ready', configured: false, writable: false } })
      return
    }
    const keyed = provider
    const ref = keyed === 'tavily'
      ? this.tavily.getSnapshot().value?.apiKeyEnv ?? DEFAULT_TAVILY_KEY_REF
      : this.deepSeek.getSnapshot().value?.apiKeyEnv ?? DEFAULT_KEY_REF
    if (!KEY_REF.test(ref)) {
      this.store.update((draft) => { draft.credential = { provider: keyed, ref, status: 'error', configured: false, writable: false } })
      return
    }
    this.store.update((draft) => { draft.credential = { provider: keyed, ref, status: 'loading', configured: false, writable: false } })
    try {
      const response = await this.api.credentials.describe({ refs: [ref] })
      if (this.disposed || generation !== this.credentialGeneration) return
      if (!response.result.ok) throw new Error('credentials.describe refused')
      const view = response.result.value.credentials[ref]
      this.store.update((draft) => {
        draft.credential = { provider: keyed, ref, status: 'ready', configured: view?.configured ?? false, writable: view?.writable ?? true }
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
   * @param fields - 文本或出站草稿；空字符串清除用户覆盖。
   * @returns 所有字段被 Host 接受后为 true。
   */
  async saveFields(provider: SearchProvider, fields: SearchDraft): Promise<boolean> {
    const scope: SettingsScope<DeepSeekSearchSettings | TavilySearchSettings | DuckDuckGoSearchSettings
    | BingSearchSettings | FreeSearchSettings | EnvKeyedSearchSettings> = provider === 'tavily'
      ? this.tavily
      : provider === 'duckduckgo'
        ? this.duckDuckGo
        : provider === 'bing'
          ? this.bing
          : provider === 'searxng'
            ? this.searxng
            : provider === 'anysearch'
              ? this.anysearch
              : provider === 'firecrawl'
                ? this.firecrawl
                : provider === 'keenable' ? this.keenable : provider === 'parallel' ? this.parallel : this.deepSeek
    const snapshot = scope.getSnapshot()
    if (this.store.getSnapshot().saving || snapshot.status !== 'ready' || !snapshot.writable) return false
    const order = ['outbound', ...SOURCE_FIELDS[provider]]
    const acceptable = order.every((field) => {
      const raw = fields[field]
      if (raw === undefined) return false
      return typeof raw === 'string'
        ? validField(field as 'baseURL' | 'model' | 'apiKeyEnv', raw, provider)
        : validOutbound(raw)
    })
    if (!acceptable) return false
    this.store.update((draft) => { draft.saving = true; draft.failed = false })
    let accepted = true
    try {
      for (const field of order) {
        const raw = fields[field]
        if (raw === undefined) { accepted = false; break }
        const current = scope.getSnapshot()
        const user = current.user as Record<string, unknown> | undefined
        if (typeof raw === 'string') {
          const value = raw.trim()
          if (value === '') {
            if (user !== undefined && Object.hasOwn(user, field)) await scope.unset(field)
            if (Object.hasOwn(scope.getSnapshot().user ?? {}, field)) accepted = false
          } else if (value !== (current.value as Record<string, unknown> | undefined)?.[field]) {
            await scope.set(field, value)
            if ((scope.getSnapshot().value as Record<string, unknown> | undefined)?.[field] !== value) accepted = false
          }
        } else {
          const next = raw.mode === 'custom'
            ? { mode: 'custom', customUrl: raw.customUrl?.trim() ?? '' }
            : { mode: raw.mode }
          // 未保存出站即直连：草稿仍是直连时不写一条冗余覆盖。
          const stored = decodeOutbound((current.value as Record<string, unknown> | undefined)?.outbound)
            ?? { mode: 'direct' }
          if (JSON.stringify(stored) !== JSON.stringify(next)) {
            await scope.set(field, next)
            const after = decodeOutbound((scope.getSnapshot().value as Record<string, unknown> | undefined)?.[field])
            if (JSON.stringify(after) !== JSON.stringify(next)) accepted = false
          }
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
