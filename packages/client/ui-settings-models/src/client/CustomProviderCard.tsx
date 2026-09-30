/**
 * 自定义渠道的两步本地草稿：先填写渠道信息，再编辑模型目录。
 * 最终确认才写入完整 profile；密钥单独存储，失败后只重试凭据。
 */

import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { apiKeyFailure } from './apiKey.ts'
import { generateChannelId } from './channel-id.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { validateDeepSeekModels } from './DeepSeekModelsEditor.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import type { ModelDraft } from './ModelListEditor.tsx'
import { deriveKeyRef, messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

const NS = 'llm-pi-ai'
const MAX_CHANNEL_NAME_LENGTH = 64
const TABS = ['channel', 'models'] as const
type DraftTab = typeof TABS[number]

/** 自定义渠道创建表单的数据与写入能力。 */
export interface CustomProviderCardProps {
  /** 全部目录路由及已存 profile 的 ID，用于生成时避免冲突。 */
  taken: readonly string[]
  /** 适配器支持的上游请求格式，按 schema 顺序展示。 */
  protocols: readonly string[]
  /** 打开草稿时的 revision；后续并发变更必须拒绝创建。 */
  revision: number
  /** 设置、凭据写入及端点模型发现接口。 */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** 分区文案。 */
  t: (key: keyof typeof en) => string
  /** 设置只读时禁止写入。 */
  readOnly: boolean
  /** 模态框内使用平面表单，不重复绘制卡片背景和标题。 */
  embedded?: boolean
  /** 模态框打开后聚焦渠道名称。 */
  autoFocusName?: boolean
  /** 提交开始和结束时同步上报；外层关闭路径据此拒绝中途卸载。 */
  onBusyChange?: (busy: boolean) => void
  /** 关闭卡片；profile 已创建时返回其路由 ID，包括凭据写入失败后的取消。 */
  onClose: (changed: boolean, provider?: string) => void | Promise<void>
  /** 新渠道 profile 已提交时折入共享设置镜像，凭据写入失败也保留该事实。 */
  onSettingsCommitted?: (view: SettingsNamespaceView, provider: string) => void
}

/**
 * 绘制保留本地渠道信息与模型草稿的创建表单。
 * @param props - 已占用路由、格式选项、写入接口与呈现配置。
 * @returns 两步创建表单。
 */
export function CustomProviderCard(props: CustomProviderCardProps): ReactNode {
  const { taken, protocols, api, t } = props
  const fieldId = useId()
  const displayNameId = `${fieldId}-display-name`
  const baseURLId = `${fieldId}-base-url`
  const protocolId = `${fieldId}-protocol`
  const keyId = `${fieldId}-key`
  const formRef = useRef<HTMLDivElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const keyInputRef = useRef<HTMLInputElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const focusAfterFailure = useRef(false)
  const submitting = useRef(false)
  const profileCommitted = useRef(false)
  const committedStoresKey = useRef(false)
  // revision 和路由 ID 都归本次草稿所有；未知写入结果也不得换 ID 重建渠道。
  const [openedAt] = useState(() => props.revision)
  const [route] = useState(() => generateChannelId(taken))
  const [activeTab, setActiveTab] = useState<DraftTab>('channel')
  const [displayName, setDisplayName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [protocol, setProtocol] = useState(protocols[0] ?? '')
  const [keyDraft, setKeyDraft] = useState('')
  const [models, setModels] = useState<readonly ModelDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [committed, setCommitted] = useState(false)

  useLayoutEffect(() => {
    if (props.autoFocusName === true) nameInputRef.current?.focus()
  }, [props.autoFocusName])

  useLayoutEffect(() => {
    if (busy || !focusAfterFailure.current) return
    focusAfterFailure.current = false
    const field = committed && !committedStoresKey.current ? tabRefs.current[0]
      : committed ? keyInputRef.current : nameInputRef.current
    if (field?.disabled === false) field.focus()
  }, [activeTab, busy, committed, failure])

  const disabled = props.readOnly || busy
  const profileDisabled = disabled || committed
  const nameValue = displayName.trim()
  const nameInvalid = nameValue.length === 0 || nameValue.length > MAX_CHANNEL_NAME_LENGTH
  const baseURLValue = baseURL.trim()
  const routeTaken = !committed && taken.includes(route)
  const modelFailure = validateDeepSeekModels(models)
  // 已提交 profile 指向凭据引用，重试不能把清空密钥视为创建完成。
  const keyFailure = committed && !committedStoresKey.current ? undefined
    : committed && keyDraft.trim().length === 0 ? 'keyRequired' : apiKeyFailure(keyDraft)
  const keyValue = keyDraft.trim()
  const channelReady = !nameInvalid && baseURLValue.length > 0 && protocols.includes(protocol)
    && !routeTaken && keyFailure === undefined
  const ready = committed ? keyFailure === undefined
    : channelReady && models.length > 0 && modelFailure === undefined

  const selectTab = (tab: DraftTab): void => {
    if (busy || (tab === 'models' && !channelReady)) return
    setActiveTab(tab)
    tabRefs.current[TABS.indexOf(tab)]?.focus({ preventScroll: true })
  }

  const createOnce = async (): Promise<string | undefined> => {
    const keyRef = deriveKeyRef(route)
    const storesKey = profileCommitted.current ? committedStoresKey.current : keyValue.length > 0
    if (!profileCommitted.current) {
      const profile = {
        displayName: nameValue,
        // 留空密钥保持原生认证路径，不记录无人设置的凭据引用。
        ...storesKey ? { apiKeyEnv: keyRef } : {},
        api: protocol,
        baseURL: baseURLValue,
        models: models.map(model => ({ ...model })),
      }
      const response = await api.settings.mutate({
        ns: NS,
        ops: [{ op: 'set', path: ['providers', route], value: profile }],
        expectedRevision: openedAt,
      })
      if (!response.result.ok) return response.result.error.message
      // 凭据或后续刷新失败时，重试不得再次提交已创建的 profile。
      committedStoresKey.current = storesKey
      profileCommitted.current = true
      setCommitted(true)
      props.onSettingsCommitted?.(response.result.value, route)
    }
    if (storesKey) {
      const stored = await api.credentials.set({ ref: keyRef, value: keyValue })
      if (!stored.result.ok) return stored.result.error.message
    }
    return undefined
  }

  const showFailure = (message: string): void => {
    setActiveTab('channel')
    focusAfterFailure.current = true
    setFailure(message)
  }

  const create = async (): Promise<void> => {
    if (!ready || disabled || submitting.current) return
    submitting.current = true
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
        showFailure(outcome)
        return
      }
      await props.onClose(true, route)
    } catch (error) {
      showFailure(messageOf(error))
    } finally {
      submitting.current = false
      props.onBusyChange?.(false)
      setBusy(false)
    }
  }

  return (
    <div ref={formRef} className={props.embedded === true ? styles['customChannelForm'] : styles['editor']}>
      {props.embedded === true ? null : <div className={styles['editorHeader']}>
        <span className={styles['editorTitle']}>{t('customTitle')}</span>
      </div>}
      <div className={styles['customChannelTabs']} role="tablist" aria-label={t('customSteps')}>
        {TABS.map((tab, index) => <button key={tab} type="button" role="tab"
          ref={(element) => { tabRefs.current[index] = element }}
          id={`${fieldId}-tab-${tab}`} aria-controls={`${fieldId}-panel-${tab}`}
          aria-selected={activeTab === tab} tabIndex={activeTab === tab ? 0 : -1}
          className={styles['customChannelTab']} disabled={busy || (tab === 'models' && !channelReady)}
          onClick={() => { selectTab(tab) }}
          onKeyDown={(event) => {
            let nextIndex: number
            switch (event.key) {
              case 'ArrowRight': nextIndex = (index + 1) % TABS.length; break
              case 'ArrowLeft': nextIndex = (index - 1 + TABS.length) % TABS.length; break
              case 'Home': nextIndex = 0; break
              case 'End': nextIndex = TABS.length - 1; break
              default: return
            }
            event.preventDefault()
            selectTab(TABS[nextIndex] as DraftTab)
          }}>
          {t(tab === 'channel' ? 'customChannelInfo' : 'customModelsStep')}
        </button>)}
      </div>
      <div className={styles['customChannelPanel']} role="tabpanel"
        id={`${fieldId}-panel-${activeTab}`} aria-labelledby={`${fieldId}-tab-${activeTab}`}>
        {activeTab === 'channel' ? <>
          <div className={styles['field']}>
            <label className={styles['fieldLabel']} htmlFor={displayNameId}>{t('channelName')}</label>
            <input ref={nameInputRef} id={displayNameId} className={styles['input']} type="text"
              value={displayName} placeholder={t('channelName')} required
              aria-invalid={displayName.length > 0 && nameInvalid}
              aria-describedby={displayName.length > 0 && nameInvalid ? `${displayNameId}-error` : undefined}
              disabled={profileDisabled}
              onChange={(event) => { setDisplayName(event.target.value) }} />
            {displayName.length > 0 && nameInvalid
              ? <p id={`${displayNameId}-error`} className={styles['error']} role="alert">{t('channelNameInvalid')}</p> : null}
          </div>
          <div className={styles['field']}>
            <label className={styles['fieldLabel']} htmlFor={baseURLId}>{t('baseUrl')}</label>
            <input id={baseURLId} className={styles['input']} type="text" value={baseURL}
              placeholder="https://gateway.example/v1" required disabled={profileDisabled}
              onChange={(event) => { setBaseURL(event.target.value) }} />
          </div>
          <div className={styles['field']}>
            <label className={styles['fieldLabel']} htmlFor={protocolId}>{t('customApi')}</label>
            <select id={protocolId} className={`${styles['input']} ${styles['selectInput']}`}
              value={protocol} disabled={profileDisabled}
              onChange={(event) => { setProtocol(event.target.value) }}>
              {protocols.map(choice => <option key={choice} value={choice}>{choice}</option>)}
            </select>
          </div>
          <div className={styles['field']}>
            <label className={styles['fieldLabel']} htmlFor={keyId}>{t('keyInput')}</label>
            <input ref={keyInputRef} id={keyId} className={styles['input']} type="password" autoComplete="off"
              value={keyDraft} placeholder={t('keyPlaceholderNative')} aria-invalid={keyFailure !== undefined}
              aria-describedby={keyFailure === undefined ? undefined : `${keyId}-error`}
              disabled={disabled || (committed && !committedStoresKey.current)}
              onChange={(event) => { setKeyDraft(event.target.value) }} />
            {keyFailure === undefined ? null
              : <p id={`${keyId}-error`} className={styles['error']} role="alert">{t(keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure)}</p>}
          </div>
          {routeTaken ? <p className={styles['error']} role="alert">{t('customRouteTaken')}</p> : null}
          {!nameInvalid && baseURLValue.length === 0 ? <p className={styles['advancedHint']}>{t('customNeedsBaseUrl')}</p> : null}
        </> : <>
          <ModelListEditor models={models} onChange={setModels}
            probe={{ settingsNs: NS, baseURL: baseURLValue, api: protocol,
              ...keyValue.length === 0 ? {} : { apiKey: keyValue } }}
            api={api} t={t} disabled={profileDisabled} />
          {modelFailure === undefined
            ? models.length === 0 ? <p className={styles['advancedHint']}>{t('customNeedsModels')}</p> : null
            : <p className={styles['error']} role="alert">{`${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`}</p>}
        </>}
      </div>
      {failure !== undefined ? <p className={styles['error']} role="alert">{failure}</p> : null}
      <div className={styles['customChannelActions']}>
        {activeTab === 'models' ? <button type="button" className={styles['secondaryButton']}
          disabled={busy} onClick={() => { selectTab('channel') }}>{t('customBack')}</button> : null}
        <EditorFooter t={t} busy={busy}
          submitDisabled={disabled || (activeTab === 'channel' && !committed ? !channelReady : !ready)}
          submitLabel={committed ? 'retry' : activeTab === 'channel' ? 'customNext' : 'create'}
          submitBusyLabel="creating"
          onCancel={() => { void (committed ? props.onClose(true, route) : props.onClose(false)) }}
          onSubmit={() => {
            if (activeTab === 'channel' && !committed) selectTab('models')
            else void create()
          }} />
      </div>
    </div>
  )
}
