/**
 * 按适配器家族编辑单个提供方。API 密钥只写入凭据服务，页面不询问环境变量名；
 * DeepSeek 渠道名称与密钥并列显示，只作为设置元数据，不改变固定路由和凭据引用。
 * 自定义设置区承载端点、模型目录和手工声明的 pi-ai 路由身份字段。推理等级属于
 * 单个模型能力，不提供可能被部分模型拒绝的提供方级输入。配置修改只对编辑器可见
 * 字段发出 `settings.mutate` 路径操作，不重建脱敏分节。
 *
 * 应用自带的渠道（如 Free）没有设置分节，它们的卡片是只读的
 * {@link BuiltinChannelCard}，不经过这里。
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CredentialView, IApiClient, SettingsNamespaceView, SettingsPathOpView } from 'coding-api-remotes/client'
import { OutboundSelect } from 'coding-client-ui-primitives'
import {
  DeepSeekModelsEditor, modelDrafts, validateDeepSeekModels,
} from './DeepSeekModelsEditor.tsx'
import { apiKeyFailure } from './apiKey.ts'
import { MAX_USER_AGENT_LENGTH, validChannelUserAgent } from './user-agent.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import { identitiesAfterRemoval, modelPresetOf, removeModelPreset, renameModelPreset, saveModelPresetChanges } from './model-presets.ts'
import type { ModelIdentity } from './model-presets.ts'
import { deriveKeyRef, messageOf, protocolChoices } from './store.ts'
import type { CatalogModel, ModelPresetOption } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Per-adapter-family curated field sets (unknown namespaces get the hint alone). */
type EditorLayout = 'deepseek' | 'pi-ai' | 'unknown'

/** DeepSeek 地址输入框展示的公共端点占位值。 */
const DEEPSEEK_PUBLIC_BASE_URL = 'https://api.deepseek.com'
const MAX_CHANNEL_NAME_LENGTH = 64

/** Props of {@link ProviderEditor}. */
export interface ProviderEditorProps {
  /** Provider route id. */
  provider: string
  /** 目录提供的生效名称，供标题与未编辑的 DeepSeek 名称输入共用。 */
  displayName: string
  /** Hide the title row (the add card renders its own provider select). */
  hideTitle?: boolean
  /**
   * Whether the adapter reports this route as hand-declared — absent from its
   * installed catalog. This only controls whether the route's display name is
   * editable; every editable pi-ai profile can set its channel protocol.
   */
  declared?: boolean
  /** The owning namespace view (schema, layers, secrets). */
  namespace: SettingsNamespaceView
  /** Settings-owned synchronous schema and immutable path operations. */
  schema: SettingsSchemaOperations
  /** Path from the section root to this provider's profile. */
  settingsPath: readonly string[]
  /** Wire faces for writes and for interrogating a provider endpoint. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Render only the credential field and actions, without provider settings. */
  credentialOnly?: boolean
  /** Require a newly entered credential before this editor can submit. */
  credentialRequired?: boolean
  /** Give the credential field initial focus when this editor mounts. */
  autoFocusCredential?: boolean
  /** 初始展开自定义设置区；引导弹窗用它直接展示 Base URL 和模型目录。 */
  defaultCustomizedOpen?: boolean
  /** 模型页常显凭据、地址和目录；引导卡片仍使用折叠布局。 */
  channelLayout?: boolean
  /** Override the dismiss action copy. */
  cancelLabel?: keyof typeof en
  /** Override the idle commit action copy. */
  submitLabel?: keyof typeof en
  /** Override the in-flight commit action copy. */
  submitBusyLabel?: keyof typeof en
  /** Close the editor; `changed` reports whether an Apply committed. */
  onClose: (changed: boolean) => void | Promise<void>
  /** 本卡片成功写入后的脱敏分节应答，交给设置镜像而非另读文档。 */
  onSettingsCommitted?: (view: SettingsNamespaceView) => void
  /** 模型默认模式所属分节与可选名单，均来自共享设置镜像。 */
  presetNamespace?: SettingsNamespaceView | undefined
  presets?: readonly ModelPresetOption[]
  presetsError?: string | null | undefined
  /** 适配器实际列出的目录行，仅在 profile 未声明 models 时供独立设置窗口使用。 */
  catalogModels?: readonly CatalogModel[] | undefined
}

/** A user-section subtree as a plain draft object (absent → empty). */
function draftAt(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  path: readonly string[],
): Record<string, unknown> {
  const subtree = schema.getPath(namespace.user, path)
  if (typeof subtree !== 'object' || subtree === null || Array.isArray(subtree)) return {}
  return structuredClone(subtree) as Record<string, unknown>
}

/**
 * The minimal path ops carrying `after` over `before`, both as the card sees
 * them. Only keys the card observed are named; fields absent from both sides
 * produce no op, which is why edits are path-addressed rather than a rebuilt
 * section.
 * @param base - path of the edited subtree inside the user section.
 * @param before - the subtree as loaded, or undefined when it is new.
 * @param after - the subtree as edited.
 * @returns ordered set/unset ops; empty when nothing changed.
 */
export function pathOps(
  base: readonly string[],
  before: unknown,
  after: Record<string, unknown>,
): SettingsPathOpView[] {
  const previous = typeof before === 'object' && before !== null && !Array.isArray(before)
    ? before as Record<string, unknown>
    : {}
  const ops: SettingsPathOpView[] = []
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(previous[key]) === JSON.stringify(value)) continue
    ops.push({ op: 'set', path: [...base, key], value })
  }
  for (const key of Object.keys(previous)) {
    if (!(key in after)) ops.push({ op: 'unset', path: [...base, key] })
  }
  return ops
}

/** The editor layout the owning namespace selects. */
function layoutOf(ns: string): EditorLayout {
  if (ns === 'llm-deepseek') return 'deepseek'
  if (ns === 'llm-pi-ai') return 'pi-ai'
  return 'unknown'
}

/** DeepSeek 渠道的出站草稿；未配置时 undefined。 */
type DeepSeekOutboundDraft = { mode: 'direct' | 'pool' | 'custom'; customUrl?: string }

/** 出站草稿里唯一会阻止保存的情况：自定义模式缺少合法 http(s) 地址。 */
function outboundDraftFailure(value: unknown): 'channelOutboundInvalid' | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { mode?: unknown; customUrl?: unknown }
  if (record.mode !== 'custom') return undefined
  return typeof record.customUrl === 'string' && /^https?:\/\//.test(record.customUrl)
    ? undefined
    : 'channelOutboundInvalid'
}

/** The credential reference this profile resolves keys through. */
function refFor(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  path: readonly string[],
  provider: string,
): string {
  const profile = schema.getPath(namespace.value, path)
  const named = typeof profile === 'object' && profile !== null
    ? (profile as { apiKeyEnv?: unknown }).apiKeyEnv
    : undefined
  return typeof named === 'string' && named.length > 0 ? named : deriveKeyRef(provider)
}

/**
 * Render one provider's editing card.
 * @param props - the addressed profile plus wire faces and copy.
 * @returns the editor card.
 */
export function ProviderEditor(props: ProviderEditorProps): ReactNode {
  const { namespace, schema, settingsPath, api, t } = props
  const channelNameId = useId()
  const [draft, setDraft] = useState<Record<string, unknown>>(() => draftAt(schema, namespace, settingsPath))
  const [channelNameDraft, setChannelNameDraft] = useState<string | undefined>(undefined)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyState, setKeyState] = useState<CredentialView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [customizedOpen, setCustomizedOpen] = useState(() => props.defaultCustomizedOpen === true)
  // 设置成功后立即推进重试基线，并保留已写入字段，避免后续凭据重试随刷新误删它们。
  const [committedOriginal, setCommittedOriginal] = useState<unknown>(
    () => schema.getPath(namespace.user, settingsPath),
  )
  const [expectedRevision, setExpectedRevision] = useState(() => namespace.revision)
  const [presetView, setPresetView] = useState(() => props.presetNamespace)
  const [presetChanges, setPresetChanges] = useState<ReadonlyMap<string, string | undefined>>(() => new Map())
  const modelIdentity = useRef(new Map<number, ModelIdentity>())
  const [keyCommitted, setKeyCommitted] = useState(false)
  const root = useMemo(() => schema.rehydrate(namespace.schema), [namespace.schema, schema])
  const node = useMemo(() => schema.nodeAtPath(root, settingsPath), [root, schema, settingsPath])
  const fallback = schema.getPath(namespace.value, settingsPath)
  const disabled = props.readOnly || busy
  const layout = layoutOf(namespace.ns)
  const keyRef = refFor(schema, namespace, settingsPath, props.provider)
  // 未编辑时与列表、标题共用目录的生效名称；只在本字段被编辑后写入名称覆盖。
  const channelName = channelNameDraft ?? props.displayName
  const outboundDraft = schema.getPath(draft, ['outbound'])
  const outboundFailure = layout === 'deepseek' && props.credentialOnly !== true
    ? outboundDraftFailure(outboundDraft)
    : undefined
  // 渠道级 UA：留空表示跟随产品默认，因此只有键入过才校验。
  const draftUserAgent = schema.getPath(draft, ['userAgent'])
  const userAgentFailure = props.credentialOnly !== true
    && typeof draftUserAgent === 'string' && !validChannelUserAgent(draftUserAgent)
    ? 'userAgentInvalid' as const
    : undefined
  const channelNameFailure = layout === 'deepseek' && props.credentialOnly !== true
    && channelNameDraft !== undefined
    && (channelName.trim().length === 0 || channelName.trim().length > MAX_CHANNEL_NAME_LENGTH)
    ? 'channelNameInvalid' as const
    : undefined

  // The same schema read the create card makes, so the choices offered here
  // and there cannot drift apart: both come from the adapter's own `Config`.
  // Only the pi-ai layout has a per-route protocol for the read to find, and
  // it rehydrates the whole section schema, so the other layouts skip it.
  const protocols = useMemo(
    () => layout === 'pi-ai' ? protocolChoices(namespace, schema) : [],
    [layout, namespace, schema],
  )

  useEffect(() => {
    let stale = false
    setKeyState(undefined)
    // The key state is a placeholder hint, not a precondition for editing:
    // neither a business rejection nor a transport failure may reach the
    // browser as an unhandled rejection, so the card simply renders without
    // the "already configured" hint.
    void api.credentials.describe({ refs: [keyRef] }).then(
      (response) => {
        if (stale || !response.result.ok) return
        setKeyState(response.result.value.credentials[keyRef])
      },
      () => undefined,
    )
    return () => { stale = true }
  }, [api.credentials, keyRef])

  const stringAt = (source: unknown, key: string): string | undefined => {
    const value = schema.getPath(source, [key])
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined
  }
  const setField = (key: string, next: string | undefined): void => {
    // A value of nothing but whitespace is cleared, not stored: `stringAt`
    // already reports it as absent, so the field would otherwise render empty
    // while the draft still carried the spaces into `settings.yaml`, where
    // both adapters would accept that non-empty string as a real value.
    const value = next === undefined || next.trim().length === 0 ? undefined : next
    setDraft(current => value === undefined
      ? schema.deletePath(current, [key])
      : schema.setPath(current, [key], value))
  }

  // The model list is validated by the same per-row checker for both families,
  // so a bad row is named by its position rather than by a blanket message.
  const modelFailure = validateDeepSeekModels(schema.getPath(draft, ['models']), layout === 'deepseek' ? 'deepseek' : 'pi-ai')
  const keyFailure = apiKeyFailure(keyDraft)
  // What a probe or a write must carry: the typed key with paste whitespace
  // removed. A blank field yields an empty string, which both call sites read
  // as "no key supplied" rather than as a key — that is how a card whose
  // provider already has a stored key is edited without re-entering it.
  const keyValue = keyDraft.trim()
  const credentialRequiredFailure = props.credentialRequired === true && !keyCommitted
    && keyDraft.length > 0 && keyValue.length === 0
    ? 'keyRequired' as const
    : undefined
  const shownKeyFailure = credentialRequiredFailure ?? keyFailure
  // 渠道级协议的编辑值只沿用户层和 composition base 继承；清空用户覆盖后不能从
  // effective 层读取旧值，否则控件会把刚清除的覆盖重新显示出来。未声明时交给 Host
  // 使用默认的 Chat Completions 协议，但页面仍保留“未设置”状态以便清除覆盖。
  const inheritedApi = stringAt(schema.getPath(namespace.base, settingsPath), 'api')
  const channelApi = stringAt(draft, 'api') ?? inheritedApi
  // 探测使用 effective profile：目录默认协议和已保存的路由协议都应影响请求。
  const probeApi = stringAt(draft, 'api') ?? stringAt(fallback, 'api')
  const probeBaseURL = stringAt(draft, 'baseURL') ?? stringAt(fallback, 'baseURL')
  const probe = {
    settingsNs: namespace.ns,
    // Naming the route lets an adapter that already describes it answer from
    // its own registry — better metadata, no network call, no endpoint needed.
    provider: props.provider,
    ...probeBaseURL === undefined ? {} : { baseURL: probeBaseURL },
    ...probeApi === undefined ? {} : { api: probeApi },
    ...keyValue.length === 0 ? {} : { apiKey: keyValue },
  }
  /**
   * The write for this card, or a failure message. Every edit travels as
   * path ops against the STORED section: the draft comes from the redacted
   * descriptor, so a wholesale replace rebuilt from it could delete fields
   * outside the card. Ops name only the fields this card can see.
   */
  const applyOnce = async (): Promise<string | undefined> => {
    const ns = namespace.ns
    const withChannelName = layout === 'deepseek' && channelNameDraft !== undefined
      ? schema.setPath(draft, ['channelName'], channelNameDraft.trim())
      : draft
    // pi-ai 仅在存储密钥时记录约定引用，留空仍可使用提供方原生认证。
    const withKeyRef = layout === 'pi-ai' && stringAt(draft, 'apiKeyEnv') === undefined
      && stringAt(fallback, 'apiKeyEnv') === undefined && keyValue.length > 0
      ? schema.setPath(withChannelName, ['apiKeyEnv'], keyRef)
      : withChannelName
    const next = withKeyRef
    if (props.credentialOnly !== true) {
      // The same checker gates the submit button, so a card cannot reach this
      // with a bad row; it stays because the schema check below would refuse
      // the write with a message naming a path instead of the row, and because
      // nothing but this function decides what is written.
      const failure = validateDeepSeekModels(schema.getPath(next, ['models']), layout === 'deepseek' ? 'deepseek' : 'pi-ai')
      /* v8 ignore next 3 -- unreachable from the card: the same failure disables submit */
      if (failure !== undefined) {
        return `${t('model')} ${String(failure.index + 1)}: ${t(failure.key)}`
      }
    }
    /* v8 ignore next -- apply is only reachable from the rendered card, which required a resolved node */
    if (props.credentialOnly !== true && node !== undefined && settingsPath.length === 0) {
      const sectionError = schema.validate(node, next)
      if (sectionError !== undefined) return sectionError
    }
    const materializesNativeProfile = layout === 'pi-ai'
      && fallback === undefined
      && committedOriginal === undefined
      && Object.keys(next).length === 0
    const ops: SettingsPathOpView[] = props.credentialOnly === true
      ? []
      : materializesNativeProfile
        ? [{ op: 'set', path: [...settingsPath], value: {} }]
        : pathOps(settingsPath, committedOriginal, next)
    if (ops.length > 0) {
      const response = await api.settings.mutate({ ns, ops, expectedRevision })
      if (!response.result.ok) {
        return response.result.error.code === 'settings-conflict'
          ? t('conflict')
          : response.result.error.message
      }
      props.onSettingsCommitted?.(response.result.value)
      setCommittedOriginal(schema.getPath(response.result.value.user, settingsPath))
      setExpectedRevision(response.result.value.revision)
      setDraft(next)
    }
    if (keyValue.length > 0) {
      const stored = await api.credentials.set({ ref: keyRef, value: keyValue })
      if (!stored.result.ok) return stored.result.error.message
      setKeyCommitted(true)
      setKeyDraft('')
    }
    const presetResult = await saveModelPresetChanges(api, presetView, presetChanges, props.provider,
      props.onSettingsCommitted, t('conflict'))
    if (presetResult.failure !== undefined) return presetResult.failure
    if (presetResult.view !== undefined) {
      setPresetView(presetResult.view)
      setPresetChanges(new Map())
    }
    return undefined
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const failure = await applyOnce()
      if (failure !== undefined) {
        setFailure(failure)
        return
      }
      await props.onClose(true)
    } catch (error) {
      // A transport failure (disconnect, a request the host refuses) rejects
      // rather than answering; without this the card would stay busy forever
      // with no error shown.
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  if (node === undefined) {
    // A directory entry addressing a position its schema cannot resolve is a
    // host-side inconsistency; showing it beats a blank card.
    return <p className={styles['error']}>{`${props.provider}: unresolvable settings path`}</p>
  }

  const keyLocked = keyState?.writable === false

  /**
   * The catalog beneath the user layer: what the composition entry pinned, or
   * else the schema default that `resolve` would supply. The effective value
   * cannot answer this — it still carries the stored override until the unset
   * is applied, so reading it would echo that override straight back the
   * moment reset drops it, leaving the rows unchanged until a reload.
   */
  const inheritedModels = (): unknown => {
    const pinned = schema.getPath(namespace.base, [...settingsPath, 'models'])
    return pinned ?? schema.nodeAtPath(root, [...settingsPath, 'models'])?.meta.default
  }

  /**
   * The curated fields of one known adapter family. The family arrives
   * narrowed so the per-family branches below are total: an unknown namespace
   * renders the hint instead and never reaches this body.
   */
  const curatedFields = (family: 'deepseek' | 'pi-ai'): ReactNode => {
    // What a hand-declared route names for itself and nothing else can supply.
    // A whole-section `llm-deepseek` profile is a composition fact with no
    // per-route identity for its schema to carry, hence the family test.
    const ownsIdentity = family === 'pi-ai' && props.declared === true
    const customModels = schema.getPath(draft, ['models'])
    const modelsOverridden = schema.hasPath(draft, ['models'])
    const inherited = modelDrafts(modelsOverridden ? customModels : inheritedModels())
    const catalogOnly = family === 'pi-ai' && inherited.length === 0 && (props.catalogModels?.length ?? 0) > 0
    const models: Record<string, unknown>[] = catalogOnly ? (props.catalogModels ?? []).map((model) => {
      const fromBase = schema.getPath(namespace.base, [...settingsPath, 'modelOverrides', model.id])
      const fromDraft = schema.getPath(draft, ['modelOverrides', model.id])
      const base = typeof fromBase === 'object' && fromBase !== null && !Array.isArray(fromBase)
        ? fromBase as Record<string, unknown> : {}
      const override = typeof fromDraft === 'object' && fromDraft !== null && !Array.isArray(fromDraft)
        ? fromDraft as Record<string, unknown> : {}
      return { id: model.id, name: model.name, ...base, ...override }
    }) : inherited
    const defaultContextWindow = schema.getPath(fallback, ['defaultContextWindow'])
    const defaultMaxTokens = schema.getPath(fallback, ['maxTokens'])
    const keyPlaceholder = keyLocked
      ? t('keyEnvLocked')
      : keyState?.configured === true && props.credentialRequired !== true
        ? t('keyStored')
        : family === 'pi-ai' ? t('keyPlaceholderNative') : t('keyPlaceholder')
    /** What both family editors take: the rows, whose layer owns them, and the two writes. */
    const catalogProps = {
      models,
      overridden: modelsOverridden,
      t,
      disabled,
      onChange: (next: Record<string, unknown>[]) => {
        if (!catalogOnly || next.length !== models.length) {
          // 端点导入将整份目录具化；行已合入原有覆盖，不能再并存 modelOverrides。
          setDraft((current) => {
            const updated = schema.setPath(current, ['models'], next)
            return catalogOnly ? schema.deletePath(updated, ['modelOverrides']) : updated
          })
          return
        }
        // catalog 仍由适配器持有；就地更正只写 modelOverrides，不生成替换目录。
        setDraft((current) => {
          let updated = current
          for (const [index, before] of models.entries()) {
            const after = next[index]
            const id = before['id']
            if (after === undefined || typeof id !== 'string' || after['id'] !== id) continue
            const stored = schema.getPath(updated, ['modelOverrides', id])
            const override = typeof stored === 'object' && stored !== null && !Array.isArray(stored)
              ? { ...stored as Record<string, unknown> } : {}
            for (const key of ['name', 'api', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts']) {
              if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue
              const value = after[key]
              if (value === undefined) Reflect.deleteProperty(override, key)
              else override[key] = value
            }
            updated = Object.keys(override).length === 0
              ? schema.deletePath(updated, ['modelOverrides', id])
              : schema.setPath(updated, ['modelOverrides', id], override)
          }
          return updated
        })
      },
      onReset: () => { setDraft(current => schema.deletePath(current, ['models'])) },
      onModelIdChange: (index: number, oldId: string, newId: string, duplicate: boolean) => {
        const prior = modelIdentity.current.get(index)
          ?? { original: oldId || newId, invalid: false, lastValid: oldId || newId }
        const invalid = duplicate || newId.length === 0
        if (newId === prior.original && !invalid) modelIdentity.current.delete(index)
        else modelIdentity.current.set(index, {
          original: prior.original, invalid, lastValid: invalid ? prior.lastValid : newId,
        })
        setPresetChanges(current => renameModelPreset(current, presetView, schema, props.provider,
          prior.original, prior.invalid ? prior.lastValid : oldId, newId, invalid))
      },
      onModelRemove: (index: number, id: string) => {
        const identity = modelIdentity.current.get(index)
        const original = identity?.original ?? id
        const { shifted, recovered } = identitiesAfterRemoval(modelIdentity.current, models, index)
        modelIdentity.current = shifted
        setPresetChanges((current) => {
          let next = removeModelPreset(current, presetView, schema, props.provider,
            original, identity?.invalid === true ? identity.lastValid : id)
          for (const row of recovered) {
            next = renameModelPreset(next, presetView, schema, props.provider,
              row.identity.original, row.identity.lastValid, row.id, false)
          }
          return next
        })
      },
      presets: props.presets ?? [],
      presetsError: props.presetsError,
      presetForModel: (id: string) => presetChanges.has(id)
        ? presetChanges.get(id) : modelPresetOf(presetView, schema, props.provider, id),
      onPresetChange: (id: string, preset: string | undefined) => {
        setPresetChanges((current) => {
          const next = new Map(current)
          const original = modelPresetOf(presetView, schema, props.provider, id)
          if (preset === original) next.delete(id)
          else next.set(id, preset)
          return next
        })
      },
      presetDisabled: presetView === undefined,
    }
    /**
     * 渠道级出站：直连／内置代理池／自定义代理。写入草稿的 `outbound` 路径，
     * 与端点、模型一起随保存提交；池规则为直连时选择内置池也按直连处理。
     * 控件用共享的 `OutboundSelect`：设置页里其余出站选择（Free 渠道、代理池、
     * 联网搜索）都渲染同一份语义与样式。
     */
    const outboundField = (): ReactNode => {
      const record = typeof outboundDraft === 'object' && outboundDraft !== null
        ? outboundDraft as Record<string, unknown>
        : {}
      const storedMode = record['mode']
      const mode = storedMode === 'pool' || storedMode === 'custom' ? storedMode : 'direct'
      const customUrl = typeof record['customUrl'] === 'string' ? record['customUrl'] : ''
      const write = (next: DeepSeekOutboundDraft): void => {
        setDraft(current => schema.setPath(current, ['outbound'], next))
      }
      return <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('channelOutbound')}</span>
        <OutboundSelect
          value={{ mode, customUrl }}
          disabled={disabled}
          invalid={outboundFailure !== undefined}
          urlPlaceholder="http://proxy.example:8080"
          labels={{
            group: t('channelOutbound'),
            direct: t('channelOutboundDirect'),
            pool: t('channelOutboundPool'),
            custom: t('channelOutboundCustom'),
            url: t('channelOutboundUrl'),
          }}
          onChange={(next) => {
            write(next.mode === 'custom'
              ? { mode: 'custom', customUrl: next.customUrl ?? '' }
              : { mode: next.mode })
          }}
          onCustomUrlChange={(next) => { write({ mode: 'custom', customUrl: next }) }}
        />
        {outboundFailure === undefined ? null : <p className={styles['error']} role="alert">{t(outboundFailure)}</p>}
      </div>
    }
    const Customized = props.channelLayout === true ? 'div' : 'details'
    return (
      <>
        {family === 'deepseek' && props.credentialOnly !== true ? (
          <div className={styles['field']}>
            <label className={styles['fieldLabel']} htmlFor={channelNameId}>{t('channelName')}</label>
            <input
              id={channelNameId}
              className={styles['input']}
              type="text"
              value={channelName}
              aria-invalid={channelNameFailure !== undefined}
              aria-describedby={channelNameFailure === undefined ? undefined : `${channelNameId}-error`}
              disabled={disabled}
              onChange={(event) => {
                setChannelNameDraft(event.target.value)
              }}
            />
            {channelNameFailure === undefined ? null : (
              <p id={`${channelNameId}-error`} className={styles['error']} role="alert">
                {t(channelNameFailure)}
              </p>
            )}
          </div>
        ) : null}
        {props.credentialOnly === true
          ? null
          : (
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
              <input
                className={styles['input']}
                type="text"
                value={stringAt(draft, 'baseURL') ?? ''}
                placeholder={family === 'deepseek'
                  ? DEEPSEEK_PUBLIC_BASE_URL
                  : stringAt(fallback, 'baseURL') ?? t('baseUrlDefault')}
                aria-label={t('baseUrl')}
                disabled={disabled}
                onChange={(event) => {
                  setField('baseURL', event.target.value === '' ? undefined : event.target.value)
                }}
              />
            </div>
          )}
        <div className={styles['field']}>
          <span className={styles['fieldLabel']}>{t('keyInput')}</span>
          <input
            className={styles['input']}
            type="password"
            autoComplete="off"
            value={keyDraft}
            placeholder={keyPlaceholder}
            aria-label={t('keyInput')}
            aria-invalid={shownKeyFailure !== undefined}
            required={props.credentialRequired === true}
            autoFocus={props.autoFocusCredential === true}
            disabled={disabled || keyLocked}
            onChange={(event) => { setKeyDraft(event.target.value) }}
          />
          {shownKeyFailure === undefined ? null : <p className={styles['error']}>{t(shownKeyFailure)}</p>}
        </div>
        {props.credentialOnly === true ? null : <Customized
          className={styles['customized']}
          {...props.channelLayout === true ? {} : {
            open: customizedOpen,
            onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => {
              setCustomizedOpen(event.currentTarget.open)
            },
          }}
        >
          {props.channelLayout === true ? null : <summary className={styles['customizedSummary']}>{t('customized')}</summary>}
          <div className={styles['customizedBody']}>
            {/* The name and the protocol are the create card's two remaining
                profile fields; a route the adapter ships defaults both from
                its catalog entry and neither belongs on its card. */}
            {ownsIdentity
              ? (
                <div className={styles['field']}>
                  <span className={styles['fieldLabel']}>{t('customDisplayName')}</span>
                  <input
                    className={styles['input']}
                    type="text"
                    value={stringAt(draft, 'displayName') ?? ''}
                    // What this route is called the moment the field is
                    // cleared, which is the layer beneath the one this field
                    // edits: a `cordis.yml` may pin a name for a route the
                    // catalog does not ship, and only when nothing does is
                    // the answer the route id. Reading the effective value
                    // instead would echo the stored override back as the
                    // thing clearing restores.
                    placeholder={stringAt(schema.getPath(namespace.base, settingsPath), 'displayName')
                      ?? props.provider}
                    aria-label={t('customDisplayName')}
                    disabled={disabled}
                    onChange={(event) => { setField('displayName', event.target.value) }}
                  />
                </div>
              )
              : null}
            {/* 渠道协议可覆盖已安装目录的默认模型协议；未设置时交给 Host 默认或目录继承，
                因此它与仅手工声明路由可改的显示名称是两条独立能力。 */}
            {family === 'pi-ai'
              ? (
                <div className={styles['field']}>
                  <span className={styles['fieldLabel']}>{t('customApi')}</span>
                  <select
                    className={`${styles['input']} ${styles['selectInput']}`}
                    value={channelApi ?? ''}
                    aria-label={t('customApi')}
                    disabled={disabled}
                    onChange={(event) => { setField('api', event.target.value) }}
                  >
                    {channelApi === undefined ? <option value="">{t('customApiUnset')}</option> : null}
                    {protocols.map(choice => <option key={choice} value={choice}>{choice}</option>)}
                  </select>
                </div>
              )
              : null}
            {/* 出站与渠道级 UA 只在特定网关或网络环境下需要，默认收起，避免挤压
                端点与模型目录这类常用字段。 */}
            <details className={styles['advanced']}>
              <summary className={styles['customizedSummary']}>{t('advancedSettings')}</summary>
              <div className={styles['customizedBody']}>
                {family === 'deepseek' ? outboundField() : null}
                <div className={styles['field']}>
                  <span className={styles['fieldLabel']}>{t('userAgent')}</span>
                  <input
                    className={styles['input']}
                    type="text"
                    value={typeof draftUserAgent === 'string' ? draftUserAgent : ''}
                    placeholder={t('userAgentPlaceholder')}
                    aria-label={t('userAgent')}
                    aria-invalid={userAgentFailure !== undefined}
                    aria-describedby={userAgentFailure === undefined ? undefined : `${channelNameId}-user-agent-error`}
                    disabled={disabled}
                    maxLength={MAX_USER_AGENT_LENGTH}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => { setField('userAgent', event.target.value) }}
                  />
                  {userAgentFailure === undefined
                    ? <p className={styles['advancedHint']}>{t('userAgentHint')}</p>
                    : <p id={`${channelNameId}-user-agent-error`} className={styles['error']} role="alert">{t(userAgentFailure)}</p>}
                </div>
              </div>
            </details>
            {/* Both families edit the same rows through the same contract; only
                the extras differ — DeepSeek's inherited capacities, pi-ai's
                endpoint interrogation. */}
            {family === 'deepseek' && props.channelLayout !== true
              ? (
                <DeepSeekModelsEditor
                  {...catalogProps}
                  defaultContextWindow={typeof defaultContextWindow === 'number'
                    ? defaultContextWindow
                    : undefined}
                  defaultMaxTokens={typeof defaultMaxTokens === 'number' ? defaultMaxTokens : undefined}
                />
              )
              : <ModelListEditor {...catalogProps} probe={probe}
                probeBlocked={keyFailure ?? (catalogOnly
                  && schema.getPath(namespace.base, [...settingsPath, 'modelOverrides']) !== undefined
                  ? 'catalogManaged' : undefined)} api={api}
                {...family === 'pi-ai' ? { protocols, channelProtocol: probeApi } : {}}
                catalogOnly={catalogOnly}
                providerName={props.displayName}
                {...family === 'deepseek' ? { inheritedReasoningEfforts:
                  schema.getPath(fallback, ['thinking']) === 'disabled' ? ['off'] : ['off', 'low', 'high', 'max'] } : {}}
                reasoningDisabled={family === 'deepseek' && schema.getPath(fallback, ['thinking']) === 'disabled'} />}
          </div>
        </Customized>}
      </>
    )
  }

  return (
    <div className={props.channelLayout === true ? styles['channelFields'] : props.credentialOnly === true ? styles['addBlock'] : styles['editor']}>
      {props.hideTitle === true
        ? null
        : (
          <div className={styles['editorHeader']}>
            <span className={styles['editorTitle']}>{props.displayName}</span>
            {props.provider !== props.displayName
              ? <span className={styles['editorRoute']}>{props.provider}</span>
              : null}
          </div>
        )}
      {layout === 'unknown'
        ? <p className={styles['advancedHint']}>{`${t('advancedHint')} (${namespace.ns})`}</p>
        : curatedFields(layout)}
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      {props.credentialOnly === true || modelFailure === undefined
        ? null
        : (
          <p className={styles['advancedHint']}>
            {`${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`}
          </p>
        )}
      <EditorFooter
        t={t}
        busy={busy}
        submitDisabled={disabled || layout === 'unknown'
          || (props.credentialOnly !== true && modelFailure !== undefined)
          || channelNameFailure !== undefined
          || outboundFailure !== undefined
          || userAgentFailure !== undefined
          || shownKeyFailure !== undefined
          || (props.credentialRequired === true && !keyCommitted && keyValue.length === 0)}
        submitLabel={props.submitLabel ?? 'apply'}
        submitBusyLabel={props.submitBusyLabel ?? 'applying'}
        {...props.cancelLabel === undefined ? {} : { cancelLabel: props.cancelLabel }}
        onCancel={() => { void props.onClose(false) }}
        onSubmit={() => { void apply() }}
      />
    </div>
  )
}
