/**
 * Models settings page store: one snapshot joining the configurable-provider
 * directory (`llm.providers`), the settings namespaces (shared settings mirror),
 * and the referenced credentials (`credentials.describe`). The host stays the
 * single fact source — every mutation writes through the wire and the page
 * re-renders from the next describe, pushed or refetched.
 */

import type {
  ConfigurableProviderView, CredentialView, IApiClient, ModelCatalogFailure, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'

/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = '\u0000probe'

/** One provider row the page renders. */
export interface ProviderRow {
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ConfigurableProviderView
  /** Whether any layer configures this provider (its profile resolves). */
  configured: boolean
  /** Whether the user layer alone carries the profile (removal restores the base). */
  removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  apiKeyEnv: string | undefined
  /** Credential state for {@link apiKeyEnv}, once described. */
  credential: CredentialView | undefined
}

/** 目录中的渠道模型；视觉候选另按显式图片输入能力筛选。 */
export interface VisionModelChoice {
  provider: string
  providerName: string
  model: string
  modelName: string
}

/** 模型设置页面与首次引导共用的快照。 */
export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 成功联接过的快照在后续刷新失败时仍可供编辑器呈现。 */
  hasLoaded: boolean
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Credential enrichment failure; provider/settings rows remain usable. */
  credentialError: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configurable provider joined with its configured/credential state. */
  rows: readonly ProviderRow[]
  /** Namespace views by ns, for the editor's schema/layers/secrets. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  visionModels: readonly VisionModelChoice[]
  /** 视觉模型目录读取失败；与成功返回空候选分开。 */
  visionModelsError: string | null
  /** 已配置或无配置地址、存活且凭据可用的渠道从成功目录返回的模型。 */
  onboardingModels: readonly VisionModelChoice[]
  /** 模型目录整体失败；不能将其解释为空模型列表。 */
  onboardingModelsError: string | null
  /** 单个渠道的目录失败；其他渠道的成功候选仍可选择。 */
  onboardingModelFailures: readonly ModelCatalogFailure[]
  /** agent-default-model 分节经 schema 路径解析出的当前选择。 */
  onboardingDefault: { provider: string; model: string } | null
}

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the page still has
 * to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * The wire protocols a hand-declared route may name, read out of the owning
 * namespace's own schema. This stays a schema read rather than a wire field so
 * the choices the page offers cannot drift from the ones the adapter accepts:
 * both come from the same `Config`.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @param schema - settings schema operations.
 * @returns the protocol identifiers, or an empty list when the schema has none.
 */
export function protocolChoices(
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
): string[] {
  if (namespace === undefined) return []
  const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function apiKeyEnvOf(
  namespace: SettingsNamespaceView | undefined,
  path: readonly string[],
  schema: SettingsSchemaOperations,
): string | undefined {
  if (namespace === undefined) return undefined
  const profile = schema.getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** The models settings page controller (one per settings surface). */
export class ModelsSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle', hasLoaded: false, error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(),
    visionModels: [], visionModelsError: null,
    onboardingModels: [], onboardingModelsError: null, onboardingModelFailures: [], onboardingDefault: null,
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param api - the wire face (credentials/llm domains, and settings writes).
   * @param describeFace - the shared mirror's describe face (namespace views and writability).
   */
  constructor(
    private readonly api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>,
    private readonly schema: SettingsSchemaOperations,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  /**
   * 同步折入本页写入的分节应答；后续目录联接从这面唯一镜像读取。
   * @param view - Host 已接受且脱敏的设置分节。
   * @returns 无返回值。
   */
  acceptSettingsView(view: SettingsNamespaceView): void {
    this.describeFace.acceptView(view)
  }

  /**
   * 用户重试时强制刷新设置镜像，然后重新联接目录；普通失效通知只读取已有镜像。
   * @returns 无返回值；失败诊断保存在页面快照中。
   */
  async retry(): Promise<void> {
    await this.describeFace.refresh()
    await this.load()
  }

  /**
   * 原子设置视觉路由的两个字段，避免中间出现只选渠道或只选模型的无效状态。
   * @param target - 要保存的渠道和模型；省略则同时清除选择。
   * @returns 写入失败的诊断，成功时为 undefined。
   */
  async setVisionTarget(target: { provider: string; model: string } | undefined): Promise<string | undefined> {
    const namespace = this.store.getSnapshot().namespaces.get('vision-understanding')
    if (namespace === undefined) return 'vision-understanding settings unavailable'
    try {
      const response = await this.api.settings.mutate({
        ns: namespace.ns,
        expectedRevision: namespace.revision,
        ops: target === undefined
          ? [{ op: 'unset', path: ['provider'] }, { op: 'unset', path: ['model'] }]
          : [{ op: 'set', path: ['provider'], value: target.provider }, { op: 'set', path: ['model'], value: target.model }],
      })
      if (!response.result.ok) return response.result.error.message
      this.describeFace.acceptView(response.result.value)
      await this.load()
      return undefined
    } catch (error) {
      return messageOf(error)
    }
  }

  /**
   * 将当前目录中可启动的模型设为 agent 默认模型，并清除旧模型的推理档位。
   * @param target - 同一代联接产出的渠道与模型。
   * @returns 写入失败或选择失效的诊断；成功时为 undefined。
   */
  async selectOnboardingModel(target: { provider: string; model: string }): Promise<string | undefined> {
    const state = this.store.getSnapshot()
    if (state.status !== 'ready' || !state.onboardingModels.some(choice =>
      choice.provider === target.provider && choice.model === target.model)) {
      return '所选模型不在当前可用目录中，请重试加载后选择。'
    }
    if (!state.writable) return '默认模型设置只读，无法保存选择。'
    const namespace = state.namespaces.get('agent-default-model')
    if (namespace === undefined) return 'agent-default-model 设置不可用，无法保存默认模型。'
    try {
      const response = await this.api.settings.mutate({
        ns: namespace.ns,
        expectedRevision: namespace.revision,
        ops: [
          { op: 'set', path: ['provider'], value: target.provider },
          { op: 'set', path: ['model'], value: target.model },
          { op: 'unset', path: ['reasoningEffort'] },
        ],
      })
      if (!response.result.ok) return response.result.error.message
      this.describeFace.acceptView(response.result.value)
      await this.load()
      return onboardingReadiness(this.store.getSnapshot()).kind === 'ready'
        ? undefined : '默认模型已保存，但无法确认当前模型目录；请重试加载。'
    } catch (error) {
      return messageOf(error)
    }
  }

  /**
   * 刷新渠道、唯一设置镜像、批量凭据与完整模型目录；只有同一代全部结束后才发布可完成快照。
   * 渠道或首次设置读取失败保留旧行并报告错误；设置镜像后续刷新失败沿用其已持有视图。
   * @returns 无返回值；快照承载结果和失败诊断。
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let providers: ConfigurableProviderView[]
    let writable: boolean
    let views: readonly SettingsNamespaceView[]
    try {
      const [providersResponse] = await Promise.all([
        this.api.llm.providers({}),
        this.describeFace.ensure(),
      ])
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      const mirrored = this.describeFace.getSnapshot()
      if (mirrored.view === undefined) {
        throw new Error(mirrored.error ?? 'settings are unavailable in this browser')
      }
      if (mirrored.error !== null) throw new Error(mirrored.error)
      providers = providersResponse.result.value.providers
      writable = mirrored.view.writable
      views = mirrored.view.namespaces
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const defaultSection = namespaces.get('agent-default-model')
    const defaultProvider = defaultSection === undefined ? undefined : this.schema.getPath(defaultSection.value, ['provider'])
    const defaultModel = defaultSection === undefined ? undefined : this.schema.getPath(defaultSection.value, ['model'])
    const onboardingDefault = typeof defaultProvider === 'string' && typeof defaultModel === 'string'
      ? { provider: defaultProvider, model: defaultModel } : null
    const rows: ProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || this.schema.getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && this.schema.hasPath(namespace.user, entry.settingsPath)
        && !this.schema.hasPath(namespace.base, entry.settingsPath)
      return {
        entry,
        configured,
        removable,
        apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath, this.schema),
        credential: undefined,
      }
    })
    const refs = [...new Set(rows.flatMap(row => row.apiKeyEnv === undefined ? [] : [row.apiKeyEnv]))]
    let credentials: Record<string, CredentialView> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      try {
        const response = await this.api.credentials.describe({ refs })
        // 凭据读取失败不阻止设置页展示渠道；首次引导仍从单独诊断中拒绝完成。
        if (response.result.ok) credentials = response.result.value.credentials
        else credentialError = response.result.error.message
      } catch (error) {
        credentialError = messageOf(error)
      }
    }
    const joinedRows = rows.map(row => ({
      ...row,
      ...row.apiKeyEnv !== undefined && credentials[row.apiKeyEnv] !== undefined
        ? { credential: credentials[row.apiKeyEnv] }
        : {},
    }))
    let visionModels: VisionModelChoice[] = []
    let visionModelsError: string | null = null
    let onboardingModels: VisionModelChoice[] = []
    let onboardingModelsError: string | null = null
    let onboardingModelFailures: ModelCatalogFailure[] = []
    try {
      const response = await this.api.llm.models({})
      if (!response.result.ok) {
        onboardingModelsError = response.result.error.message
      } else {
        const usable = new Set(joinedRows.filter(row => routeAvailable(row) && providerUsable(row))
          .map(row => row.entry.provider))
        const visionUsable = new Set(joinedRows.filter(row => row.configured && providerUsable(row))
          .map(row => row.entry.provider))
        onboardingModelFailures = response.result.value.failures.filter(failure => usable.has(failure.id))
        onboardingModels = response.result.value.groups.flatMap(group => usable.has(group.id)
          ? group.models.map(model => ({
            provider: group.id, providerName: group.name, model: model.id, modelName: model.name,
          })) : [])
        if (namespaces.has('vision-understanding')) {
          const visionFailures = response.result.value.failures.filter(failure => visionUsable.has(failure.id))
          visionModelsError = visionFailures.length > 0
            ? visionFailures.map(failure => `${failure.name} (${failure.id}): ${failure.message}`).join('; ')
            : null
          visionModels = response.result.value.groups.flatMap(group => visionUsable.has(group.id)
            ? group.models.filter(model => model.inputModalities?.includes('image') === true)
              .map(model => ({ provider: group.id, providerName: group.name, model: model.id, modelName: model.name }))
            : [])
        }
      }
    } catch (error) {
      onboardingModelsError = messageOf(error)
    }
    if (namespaces.has('vision-understanding') && onboardingModelsError !== null) {
      visionModelsError = onboardingModelsError
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.hasLoaded = true
      s.error = null
      s.credentialError = credentialError
      s.writable = writable
      s.rows = joinedRows
      s.namespaces = namespaces
      s.visionModels = visionModels
      s.visionModelsError = visionModelsError
      s.onboardingModels = onboardingModels
      s.onboardingModelsError = onboardingModelsError
      s.onboardingModelFailures = onboardingModelFailures
      s.onboardingDefault = onboardingDefault
    })
  }
}

/**
 * 已注册的渠道满足其显式凭据引用时可用于列出的模型；无引用由提供方原生认证。
 * @param row - 已联接凭据的渠道行。
 * @returns 渠道目前是否具备调用条件。
 */
export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active) return false
  if (row.apiKeyEnv === undefined) return true
  return row.credential?.configured === true
}

/** Host 附加的已注册无配置地址渠道不需要 settings profile。 */
function routeAvailable(row: ProviderRow): boolean {
  return row.configured || (row.entry.settingsNs === '' && row.entry.settingsPath.length === 0)
}

/** 首次引导只从本代 Models 联接结果计算完成状态。 */
export type OnboardingReadiness =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'needs-setup'; reason: 'no-provider' | 'credential-missing' | 'no-models' }
  | { kind: 'needs-selection' }
  | {
    kind: 'unavailable'
    reason:
      | 'load-failed'
      | 'credentials-unavailable'
      | 'settings-read-only'
      | 'credential-read-only'
      | 'catalog-unavailable'
      | 'catalog-provider-failed'
    detail?: string
  }

/**
 * 只有当前默认模型匹配本代可启动候选，首次引导才可完成。
 * @param state - 渠道、设置、凭据与完整模型目录的同代快照。
 * @returns 可开始、待配置、待选择或不可完成的诊断。
 */
export function onboardingReadiness(state: ModelsSettingsState): OnboardingReadiness {
  if (state.status === 'idle' || state.status === 'loading') return { kind: 'loading' }
  if (state.status === 'error') {
    return { kind: 'unavailable', reason: 'load-failed', ...state.error === null ? {} : { detail: state.error } }
  }
  if (state.onboardingModelsError !== null) {
    return { kind: 'unavailable', reason: 'catalog-unavailable', detail: state.onboardingModelsError }
  }
  if (state.onboardingDefault !== null && state.onboardingModels.some(choice =>
    choice.provider === state.onboardingDefault?.provider && choice.model === state.onboardingDefault.model)) {
    return { kind: 'ready' }
  }
  if (!state.writable || !state.namespaces.has('agent-default-model')) {
    return { kind: 'unavailable', reason: 'settings-read-only' }
  }
  if (state.onboardingModels.length > 0) return { kind: 'needs-selection' }
  if (state.onboardingModelFailures.length > 0) {
    return { kind: 'unavailable', reason: 'catalog-provider-failed', detail: state.onboardingModelFailures
      .map(failure => `${failure.name} (${failure.id}): ${failure.message}`).join('; ') }
  }
  const configured = state.rows.filter(row => routeAvailable(row) && row.entry.active)
  if (configured.length === 0) return { kind: 'needs-setup', reason: 'no-provider' }
  if (state.credentialError !== null) {
    return { kind: 'unavailable', reason: 'credentials-unavailable', detail: state.credentialError }
  }
  const missing = configured.find(row => row.apiKeyEnv !== undefined && row.credential?.configured !== true)
  if (missing !== undefined) {
    if (missing.credential === undefined) {
      return { kind: 'unavailable', reason: 'credentials-unavailable' }
    }
    if (!missing.credential.writable) return { kind: 'unavailable', reason: 'credential-read-only' }
    return { kind: 'needs-setup', reason: 'credential-missing' }
  }
  return { kind: 'needs-setup', reason: 'no-models' }
}
