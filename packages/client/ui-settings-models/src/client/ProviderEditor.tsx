/**
 * 按所属设置 schema 编辑渠道，密钥只写入凭据服务。保存只提交显式修改的路径，
 * 不从脱敏视图重建配置分节。无设置分节的 Free 使用内置渠道卡片。
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CredentialView, IApiClient, SettingsNamespaceView, SettingsPathOpView } from 'coding-api-remotes/client'
import { ChannelAdvancedFields, outboundDraftFailure } from './ChannelAdvancedFields.tsx'
import { modelDrafts, validateModels } from './model-editor-helpers.ts'
import { apiKeyFailure } from './apiKey.ts'
import { validChannelUserAgent } from './user-agent.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import { describeModelSchema } from './model-editor-schema.ts'
import { ProtocolPicker, protocolName } from './ProtocolPicker.tsx'
import { identitiesAfterRemoval, modelPresetOf, removeModelPreset, renameModelPreset, saveModelPresetChanges } from './model-presets.ts'
import type { ModelIdentity } from './model-presets.ts'
import { draftAt, pathOps, refFor } from './provider-draft.ts'
import { messageOf, protocolChoices } from './store.ts'
import type { CatalogModel, ModelPresetOption } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

const MAX_CHANNEL_NAME_LENGTH = 64

/** Props of {@link ProviderEditor}. */
export interface ProviderEditorProps {
  /** Provider route id. */
  provider: string
  /** 渠道的生效名称，供标题与名称输入共用。 */
  displayName: string
  /** 父页面已显示详情标题时隐藏表单标题。 */
  hideTitle?: boolean
  /** 手填路由可改显示名称，未声明请求格式时使用 Chat Completions。 */
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
  const fields = node?.type === 'object' ? node.dict : undefined
  const modelNode = fields?.['models']?.type === 'array'
    ? fields['models'].inner
    : fields?.['modelOverrides']?.type === 'dict'
      ? fields['modelOverrides'].inner
      : undefined
  const modelSchema = describeModelSchema(modelNode)
  const hasField = (key: string): boolean => fields?.[key] !== undefined
  const hasModelDirectory = modelNode !== undefined
  // 旧的整节渠道没有用户生成的路由 ID；其密钥引用和公开端点仍由宿主提供默认。
  const rootChannel = settingsPath.length === 0
  const keyRef = refFor(schema, namespace, settingsPath, props.provider)
  // 未编辑时与列表、标题共用目录的生效名称；只在本字段被编辑后写入名称覆盖。
  const channelName = channelNameDraft ?? props.displayName
  const outboundDraft = schema.getPath(draft, ['outbound'])
  const outboundFailure = hasField('outbound') && props.credentialOnly !== true
    ? outboundDraftFailure(outboundDraft)
    : undefined
  // 渠道级 UA：留空表示跟随产品默认，因此只有键入过才校验。
  const draftUserAgent = schema.getPath(draft, ['userAgent'])
  const userAgentFailure = props.credentialOnly !== true
    && typeof draftUserAgent === 'string' && !validChannelUserAgent(draftUserAgent)
    ? 'userAgentInvalid' as const
    : undefined
  const channelNameFailure = hasField('channelName') && props.credentialOnly !== true
    && channelNameDraft !== undefined
    && (channelName.trim().length === 0 || channelName.trim().length > MAX_CHANNEL_NAME_LENGTH)
    ? 'channelNameInvalid' as const
    : undefined

  const protocols = useMemo(
    () => protocolChoices(namespace, schema, [...settingsPath, 'api']),
    [namespace, schema, settingsPath],
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
  const modelFailure = validateModels(schema.getPath(draft, ['models']), {
    reasoning: modelSchema.reasoningShape, reasoningLevels: modelSchema.reasoningLevels,
  })
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
  const automaticApi = props.declared === true || rootChannel ? 'openai-completions' : undefined
  const probeApi = channelApi ?? (props.declared === true ? automaticApi : undefined)
  const unsetApiLabel = inheritedApi !== undefined ? `${t('channelApiInherit')} (${protocolName(inheritedApi)})`
    : automaticApi === undefined ? t('customApiUnset') : `${t('customApiUnset')} (${protocolName(automaticApi)})`
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
    const withChannelName = hasField('channelName') && channelNameDraft !== undefined
      ? schema.setPath(draft, ['channelName'], channelNameDraft.trim())
      : draft
    // 只有 schema 把凭据引用当作显式字段（没有默认引用）时，键入的密钥才需要写回
    // 该字段；有默认引用的渠道仍由部署决定环境变量名，留空也照常使用提供方原生认证。
    const withKeyRef = !rootChannel && hasField('apiKeyEnv')
      && stringAt(draft, 'apiKeyEnv') === undefined
      && stringAt(fallback, 'apiKeyEnv') === undefined && keyValue.length > 0
      ? schema.setPath(withChannelName, ['apiKeyEnv'], keyRef)
      : withChannelName
    const next = withKeyRef
    if (props.credentialOnly !== true) {
      // The same checker gates the submit button, so a card cannot reach this
      // with a bad row; it stays because the schema check below would refuse
      // the write with a message naming a path instead of the row, and because
      // nothing but this function decides what is written.
      const failure = validateModels(schema.getPath(next, ['models']), {
        reasoning: modelSchema.reasoningShape, reasoningLevels: modelSchema.reasoningLevels,
      })
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
    // 只对地址在分节内部的 profile 生效：整节渠道的配置对象始终存在。
    const materializesNativeProfile = settingsPath.length > 0
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

  const curatedFields = (): ReactNode => {
    const ownsIdentity = hasField('displayName') && props.declared === true
    const customModels = schema.getPath(draft, ['models'])
    const modelsOverridden = schema.hasPath(draft, ['models'])
    const defaults = modelDrafts(inheritedModels())
    const inherited = modelsOverridden ? modelDrafts(customModels) : defaults
    const catalogOnly = hasField('modelOverrides') && inherited.length === 0 && (props.catalogModels?.length ?? 0) > 0
    const deployedOverrides = schema.getPath(namespace.base, [...settingsPath, 'modelOverrides'])
    const catalogManaged = catalogOnly && typeof deployedOverrides === 'object' && deployedOverrides !== null
      && Object.keys(deployedOverrides).length > 0
    const modelProtocols = protocolChoices(namespace, schema, [
      ...settingsPath, ...(catalogOnly ? ['modelOverrides', 'model'] : ['models', '0']), 'api',
    ])
    const deploymentModelProtocols = new Map<string, string>()
    const models: Record<string, unknown>[] = catalogOnly ? (props.catalogModels ?? []).map((model) => {
      const fromBase = schema.getPath(namespace.base, [...settingsPath, 'modelOverrides', model.id])
      const fromDraft = schema.getPath(draft, ['modelOverrides', model.id])
      const base = typeof fromBase === 'object' && fromBase !== null && !Array.isArray(fromBase)
        ? fromBase as Record<string, unknown> : {}
      const override = typeof fromDraft === 'object' && fromDraft !== null && !Array.isArray(fromDraft)
        ? fromDraft as Record<string, unknown> : {}
      const deployedProtocol = stringAt(base, 'api')
      if (deployedProtocol !== undefined) deploymentModelProtocols.set(model.id, deployedProtocol)
      // 部署格式是单独的继承值，不是用户已选的选项。设回继承只取消用户覆盖。
      const row: Record<string, unknown> = { id: model.id, name: model.name, ...base, ...override }
      if (override['api'] === undefined) Reflect.deleteProperty(row, 'api')
      return row
    }) : inherited
    const keyPlaceholder = keyLocked
      ? t('keyEnvLocked')
      : keyState?.configured === true && props.credentialRequired !== true
        ? t('keyStored')
        : t(rootChannel ? 'keyPlaceholder' : 'keyPlaceholderNative')
    const catalogProps = {
      models,
      overridden: modelsOverridden,
      t,
      disabled,
      onChange: (next: Record<string, unknown>[]) => {
        if (!catalogOnly || next.length !== models.length) {
          // 导入时整份目录具化，用户的模型覆盖随行迁移。
          setDraft((current) => {
            const updated = schema.setPath(current, ['models'], next)
            return catalogOnly ? schema.deletePath(updated, ['modelOverrides']) : updated
          })
          return
        }
        // 就地编辑目录行只提交用户层字段，不能回写部署层字段。
        setDraft((current) => {
          let updated = current
          for (const [index, before] of models.entries()) {
            const after = next[index]
            const id = before['id']
            if (after === undefined || typeof id !== 'string' || after['id'] !== id) continue
            const stored = schema.getPath(updated, ['modelOverrides', id])
            const override = typeof stored === 'object' && stored !== null && !Array.isArray(stored)
              ? { ...stored as Record<string, unknown> } : {}
            for (const key of ['name', 'api', 'contextWindow', 'maxTokens', modelSchema.modalityKey, 'reasoningEfforts']) {
              if (key === undefined || JSON.stringify(before[key]) === JSON.stringify(after[key])) continue
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
      ...defaults.length === 0 ? {} : {
        onReset: () => { setDraft(current => schema.deletePath(current, ['models'])) },
      },
      onModelIdChange: (index: number, oldId: string, newId: string, duplicate: boolean) => {
        const prior = modelIdentity.current.get(index)
          ?? { original: oldId || newId, invalid: false, lastValid: oldId || newId }
        const invalid = duplicate || newId.length === 0
        if (newId === prior.original && !invalid) modelIdentity.current.delete(index)
        else modelIdentity.current.set(index, { original: prior.original, invalid, lastValid: invalid ? prior.lastValid : newId })
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
          if (preset === modelPresetOf(presetView, schema, props.provider, id)) next.delete(id)
          else next.set(id, preset)
          return next
        })
      },
      presetDisabled: presetView === undefined,
    }
    const Customized = props.channelLayout === true ? 'div' : 'details'
    return (
      <>
        {hasField('channelName') && props.credentialOnly !== true ? (
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
                placeholder={rootChannel ? 'https://api.deepseek.com' : stringAt(fallback, 'baseURL') ?? t('baseUrlDefault')}
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
            {ownsIdentity
              ? (
                <div className={styles['field']}>
                  <span className={styles['fieldLabel']}>{t('customDisplayName')}</span>
                  <input
                    className={styles['input']}
                    type="text"
                    value={stringAt(draft, 'displayName') ?? ''}
                    // 清除名称后显示部署值，不能从生效层读回旧覆盖。
                    placeholder={stringAt(schema.getPath(namespace.base, settingsPath), 'displayName')
                      ?? props.provider}
                    aria-label={t('customDisplayName')}
                    disabled={disabled}
                    onChange={(event) => { setField('displayName', event.target.value) }}
                  />
                </div>
              )
              : null}
            {protocols.length > 0
              ? (
                <div className={styles['field']}>
                  <span className={styles['fieldLabel']}>{t('customApi')}</span>
                  <ProtocolPicker label={t('customApi')} unsetLabel={unsetApiLabel} protocols={protocols}
                    value={stringAt(draft, 'api')} disabled={disabled} onChange={(value) => { setField('api', value) }} />
                </div>
              )
              : null}
            {/* 出站与渠道级 UA 只在特定网关或网络环境下需要，默认收起，避免挤压
                端点与模型目录这类常用字段。 */}
            <ChannelAdvancedFields t={t} disabled={disabled} outbound={outboundDraft} outboundFailure={outboundFailure}
              {...hasField('outbound') ? { onOutboundChange: (next) => {
                setDraft(current => schema.setPath(current, ['outbound'], next))
              } } : {}}
              userAgent={typeof draftUserAgent === 'string' ? draftUserAgent : ''} userAgentFailure={userAgentFailure}
              onUserAgentChange={(value) => { setField('userAgent', value) }} />
            <ModelListEditor {...catalogProps} probe={probe} modelSchema={modelSchema}
              capacityHints={{ contextWindow: '256K', maxTokens: hasField('defaultMaxTokens') ? '32K' : '256K' }}
              probeBlocked={keyFailure ?? (catalogManaged ? 'catalogManaged' : undefined)} api={api}
              protocols={modelProtocols} channelProtocol={channelApi ?? automaticApi}
              deploymentModelProtocols={deploymentModelProtocols}
              catalogOnly={catalogOnly}
              providerName={props.displayName}
              {...hasField('thinking') ? { inheritedReasoningEfforts:
                schema.getPath(fallback, ['thinking']) === 'disabled' ? ['off'] : modelSchema.reasoningLevels } : {}}
              reasoningDisabled={schema.getPath(fallback, ['thinking']) === 'disabled'} />
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
      {!hasModelDirectory
        ? <p className={styles['advancedHint']}>{t('advancedHint')}</p>
        : curatedFields()}
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
        submitDisabled={disabled || !hasModelDirectory
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
