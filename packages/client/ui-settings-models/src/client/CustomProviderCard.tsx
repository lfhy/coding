/**
 * The card that declares a provider pi-ai does not ship — an OpenAI-compatible
 * gateway, a self-hosted server, or a provider newer than the installed
 * catalog.
 *
 * This is a create, not an edit, which is why it is its own card rather than
 * the provider editor with extra fields: the route id is being *chosen* here,
 * and the settings address does not exist until it is. One `settings.mutate`
 * sets the whole profile at `providers.<route>`; the key travels separately
 * through `credentials.set` under the reference the profile records, exactly as
 * an existing provider's key does.
 *
 * The three fields a hand-declared route cannot default — endpoint, protocol,
 * and at least one model — are required here rather than at load, so the
 * failure names the field while the user is still looking at it.
 *
 * There is deliberately no reasoning-effort control, here or on the editor
 * card: effort is a per-MODEL capability, and the models under one provider
 * disagree about it, so a provider-scoped control can only be set to a value
 * some of them reject. The composer's model picker offers each model its own
 * levels instead.
 */

import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { apiKeyFailure } from './apiKey.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { validateDeepSeekModels } from './DeepSeekModelsEditor.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import type { ModelDraft } from './ModelListEditor.tsx'
import { deriveKeyRef, messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The settings namespace a hand-declared provider is written into. */
const NS = 'llm-pi-ai'

/**
 * A route id usable as a settings key AND as the stem of a credential name.
 * The leading letter is the second half of that: `deriveKeyRef` uppercases the
 * id and replaces every non-alphanumeric run with `_`, and a credential
 * reference is a POSIX shell identifier, which cannot start with a digit. A
 * digit-leading id passes every check this card makes and then fails at the
 * credential seam with a raw regular expression the user cannot act on.
 */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Props of {@link CustomProviderCard}. */
export interface CustomProviderCardProps {
  /** Route ids already declared, so the card refuses to shadow one. */
  taken: readonly string[]
  /** Wire protocols the adapter can serve, in the order it reports them. */
  protocols: readonly string[]
  /**
   * Revision of the `llm-pi-ai` user section this card opened at, sent with
   * the create so a route another tab declared meanwhile is a refusal rather
   * than a silent overwrite of its whole profile.
   */
  revision: number
  /** Wire faces for the write and for interrogating the endpoint. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** 模态框内使用平面表单，不重复绘制卡片背景和标题。 */
  embedded?: boolean
  /** 模态框打开后聚焦 Provider ID。 */
  autoFocusRoute?: boolean
  /** 提交开始和结束时同步上报；外层关闭路径据此拒绝中途卸载。 */
  onBusyChange?: (busy: boolean) => void
  /** 关闭卡片；profile 已创建时返回其路由 ID，包括凭据写入失败后的取消。 */
  onClose: (changed: boolean, provider?: string) => void | Promise<void>
  /** 新渠道 profile 已提交时折入共享设置镜像，凭据写入失败也保留该事实。 */
  onSettingsCommitted?: (view: SettingsNamespaceView, provider: string) => void
}

/**
 * Render the custom-provider creation card.
 * @param props - existing routes, protocol choices, wire faces, and copy.
 * @returns the creation card.
 */
export function CustomProviderCard(props: CustomProviderCardProps): ReactNode {
  const { taken, protocols, api, t } = props
  const fieldId = useId()
  const routeId = `${fieldId}-route`
  const displayNameId = `${fieldId}-display-name`
  const baseURLId = `${fieldId}-base-url`
  const protocolId = `${fieldId}-protocol`
  const keyId = `${fieldId}-key`
  const formRef = useRef<HTMLDivElement>(null)
  const routeInputRef = useRef<HTMLInputElement>(null)
  const keyInputRef = useRef<HTMLInputElement>(null)
  const focusAfterFailure = useRef(false)
  // Captured at mount, like the editor's: the write must be judged against the
  // section this card was drafted over, not whatever it grew into meanwhile.
  const [openedAt] = useState(() => props.revision)
  const [route, setRoute] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [protocol, setProtocol] = useState(protocols[0] ?? '')
  const [keyDraft, setKeyDraft] = useState('')
  const [models, setModels] = useState<readonly ModelDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  /**
   * The profile write landed. Only the key write can still be outstanding, so
   * the fields that describe the provider are settled and the retry path is
   * the credential alone.
   */
  const [committed, setCommitted] = useState(false)

  useLayoutEffect(() => {
    if (busy || !focusAfterFailure.current) return
    focusAfterFailure.current = false
    const field = committed ? keyInputRef.current : routeInputRef.current
    if (field?.disabled === false) field.focus()
  }, [busy, committed, failure])

  const disabled = props.readOnly || busy
  /** Everything but the key stops being editable once the provider exists. */
  const profileDisabled = disabled || committed

  const routeInvalid = route.length > 0 && !ROUTE_PATTERN.test(route)
  const routeTaken = !committed && taken.includes(route)
  // Rows are checked by the same per-row validator the editor cards use, so a
  // bad row is named by its position here too. Capacities have route-level
  // fallbacks; what a route cannot default is at least one model.
  const modelFailure = validateDeepSeekModels(models)
  // 已提交的 profile 若指向凭据引用，重试不得把清空密钥视为创建完成。
  const keyFailure = committed && keyDraft.trim().length === 0 ? 'keyRequired' : apiKeyFailure(keyDraft)
  // 首次创建可不填写密钥，使用提供方原生认证；已提交 profile 若记录了引用，重试则必须写入密钥。
  const keyValue = keyDraft.trim()
  const ready = route.length > 0 && !routeInvalid && !routeTaken
    && baseURL.length > 0 && protocol.length > 0 && models.length > 0 && modelFailure === undefined
    && keyFailure === undefined
  // The one blocked gate worth a line under the form. A satisfied card says
  // nothing at all rather than printing an empty paragraph.
  const hint = failure !== undefined || ready
    // The key field prints its own failure directly beneath itself, so a card
    // blocked only by the key stays silent here rather than answering with the
    // next unmet gate — which is satisfied, and reads as a second, false fault.
    || keyFailure !== undefined
    // Same for the route id, and it must be tested rather than assumed: the
    // fallback arm below reads "no models yet", so an unmet route gate would
    // fall through to it and contradict the filled-in list right above.
    || route.length === 0 || routeInvalid || routeTaken
    ? undefined
    : baseURL.length === 0
      ? t('customNeedsBaseUrl')
      : modelFailure !== undefined
        ? `${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`
        : t('customNeedsModels')

  /** Perform the create, returning a failure message or undefined. */
  const createOnce = async (): Promise<string | undefined> => {
    const keyRef = deriveKeyRef(route)
    const storesKey = keyValue.length > 0
    if (!committed) {
      const profile = {
        ...displayName.length === 0 ? {} : { displayName },
        // The profile names the conventional reference only when this card is
        // about to store a key, matching the editor: a route declared with the
        // key left blank keeps its provider-native auth path (a credential
        // chain, ADC) instead of resolving a reference nothing ever sets.
        ...storesKey ? { apiKeyEnv: keyRef } : {},
        api: protocol,
        baseURL,
        models: models.map(model => ({ ...model })),
      }
      const response = await api.settings.mutate({
        ns: NS,
        ops: [{ op: 'set', path: ['providers', route], value: profile }],
        // `taken` is a snapshot too, so the id check alone cannot see a route
        // declared after this card opened; the revision makes that race a
        // `settings-conflict` instead of a write over the other profile.
        expectedRevision: openedAt,
      })
      if (!response.result.ok) return response.result.error.message
      props.onSettingsCommitted?.(response.result.value, route)
      // The provider now exists. A retry after the key write below fails must
      // not re-run this mutate: the revision it holds is the one this write
      // just superseded, so the Host would answer `settings-conflict` and the
      // key could never be stored from this card at all.
      setCommitted(true)
    }
    if (storesKey) {
      const stored = await api.credentials.set({ ref: keyRef, value: keyValue })
      // The profile landed; saying the key did not is the only honest report,
      // and the retry above now goes straight back to this write.
      if (!stored.result.ok) return stored.result.error.message
    }
    return undefined
  }

  const create = async (): Promise<void> => {
    props.onBusyChange?.(true)
    // 提交按钮即将禁用；先把焦点移到弹窗内始终可用的关闭按钮。
    if (props.embedded === true) {
      formRef.current?.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('button[aria-label]')?.focus({ preventScroll: true })
    }
    focusAfterFailure.current = false
    setBusy(true)
    setFailure(undefined)
    try {
      const outcome = await createOnce()
      if (outcome !== undefined) {
        focusAfterFailure.current = true
        setFailure(outcome)
        return
      }
      await props.onClose(true, route)
    } catch (error) {
      // A transport failure rejects rather than answering; without this the
      // card would stay busy with nothing shown.
      focusAfterFailure.current = true
      setFailure(messageOf(error))
    } finally {
      props.onBusyChange?.(false)
      setBusy(false)
    }
  }

  return (
    <div ref={formRef} className={props.embedded === true ? styles['customChannelForm'] : styles['editor']}>
      {props.embedded === true ? null : <div className={styles['editorHeader']}>
        <span className={styles['editorTitle']}>{t('customTitle')}</span>
      </div>}
      <div className={styles['field']}>
        <label className={styles['fieldLabel']} htmlFor={routeId}>{t('customRoute')}</label>
        <input
          ref={routeInputRef}
          id={routeId}
          className={styles['input']}
          type="text"
          value={route}
          placeholder="acme-gateway"
          aria-invalid={routeInvalid || routeTaken}
          aria-describedby={`${routeId}-hint`}
          autoFocus={props.autoFocusRoute === true}
          disabled={profileDisabled}
          onChange={(event) => { setRoute(event.target.value) }}
        />
      </div>
      {/* A rejected id reads as a fault, not as guidance — the same split the
          key field below already makes between its failure and its hint. */}
      {routeInvalid || routeTaken
        ? <p id={`${routeId}-hint`} className={styles['error']}>{t(routeInvalid ? 'customRouteInvalid' : 'customRouteTaken')}</p>
        : <p id={`${routeId}-hint`} className={styles['advancedHint']}>{t('customRouteHint')}</p>}
      <div className={styles['field']}>
        <label className={styles['fieldLabel']} htmlFor={displayNameId}>{t('customDisplayName')}</label>
        <input
          id={displayNameId}
          className={styles['input']}
          type="text"
          value={displayName}
          placeholder={route.length === 0 ? t('customDisplayName') : route}
          disabled={profileDisabled}
          onChange={(event) => { setDisplayName(event.target.value) }}
        />
      </div>
      <div className={styles['field']}>
        <label className={styles['fieldLabel']} htmlFor={baseURLId}>{t('baseUrl')}</label>
        <input
          id={baseURLId}
          className={styles['input']}
          type="text"
          value={baseURL}
          placeholder="https://gateway.example/v1"
          disabled={profileDisabled}
          onChange={(event) => { setBaseURL(event.target.value) }}
        />
      </div>
      <div className={styles['field']}>
        <label className={styles['fieldLabel']} htmlFor={protocolId}>{t('customApi')}</label>
        <select
          id={protocolId}
          className={`${styles['input']} ${styles['selectInput']}`}
          value={protocol}
          disabled={profileDisabled}
          onChange={(event) => { setProtocol(event.target.value) }}
        >
          {protocols.map(choice => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </div>
      <div className={styles['field']}>
        <label className={styles['fieldLabel']} htmlFor={keyId}>{t('keyInput')}</label>
        <input
          ref={keyInputRef}
          id={keyId}
          className={styles['input']}
          type="password"
          autoComplete="off"
          value={keyDraft}
          placeholder={t('keyPlaceholder')}
          aria-invalid={keyFailure !== undefined}
          aria-describedby={keyFailure === undefined ? undefined : `${keyId}-error`}
          disabled={disabled}
          onChange={(event) => { setKeyDraft(event.target.value) }}
        />
        {/* A create card has no stored key to keep, so the blank case says
            what a blank field means here instead: this route may authenticate
            through the provider's own ambient discovery or OAuth. */}
        {keyFailure === undefined
          ? null
          : <p id={`${keyId}-error`} className={styles['error']}>{t(keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure)}</p>}
      </div>
      <ModelListEditor
        models={models}
        onChange={setModels}
        probe={{
          settingsNs: NS,
          baseURL,
          api: protocol,
          ...keyValue.length === 0 ? {} : { apiKey: keyValue },
        }}
        probeBlocked={keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure}
        api={api}
        t={t}
        disabled={profileDisabled}
      />
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      {/* Only the gates with something to say render; the route-id gate has its
          own field-level hint, so its blocked state would print an empty line. */}
      {hint === undefined ? null : <p className={styles['advancedHint']}>{hint}</p>}
      <EditorFooter
        t={t}
        busy={busy}
        submitDisabled={disabled || !ready}
        submitLabel="create"
        submitBusyLabel="creating"
        onCancel={() => { void (committed ? props.onClose(true, route) : props.onClose(false)) }}
        onSubmit={() => { void create() }}
      />
    </div>
  )
}
