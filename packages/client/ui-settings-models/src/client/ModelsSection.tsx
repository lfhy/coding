/**
 * 模型设置页从已配置渠道目录、共享设置镜像与凭据状态组成两栏视图。
 * 当前渠道常显编辑器；图片降级目标只从模型目录明确声明的视觉能力中选择。
 * 写入由编辑器和页面控制器执行，组件只保存搜索、选中和弹窗交互状态。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronLeftOutline14, IconPlusOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-icons'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { CustomProviderCard } from './CustomProviderCard.tsx'
import { deriveKeyRef, messageOf, protocolChoices } from './store.ts'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { ProviderEditor } from './ProviderEditor.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelsSettingsStore
  hooks: {
    /** Page snapshot bound by the UI renderer as useSnapshot. */
    snapshot: ModelsSettingsStore['store']
  }
  /** Wire faces the editor writes through. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Settings schema and immutable path callbacks. */
  schema: SettingsSchemaOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type ModelsSectionProps = Partial<InjectFace<ModelsSectionInjected>>

type ModelsSectionFace = InjectFace<ModelsSectionInjected>

/** Provider identity shared by row actions and confirmation copy. */
export interface ProviderIdentity {
  /** Stable provider route id. */
  provider: string
  /** Human-facing provider name. */
  displayName: string
}

/** One existing row or dormant directory entry addressed by an editor action. */
interface EditorTarget extends ProviderIdentity {
  settingsNs: string
  settingsPath: readonly string[]
  /** Writable credential identified under this page's conventional reference. */
  credentialRef?: string
  /** The adapter reports this route as one it does not ship (see {@link ProviderEditorProps.declared}). */
  declared?: boolean
}

/**
 * Remove one user-added provider and its page-managed credential. Credential
 * removal comes first so a second-step failure leaves the provider row visible
 * and the whole operation safely retryable; both unsets are idempotent.
 * The settings removal names the profile rather than rebuilding its whole
 * namespace from a partial view.
 * @param api - settings and credential wire faces.
 * @param controller - the page store to refresh.
 * @param target - the provider's settings address and optional managed credential.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function removeProviderProfile(
  api: Pick<IApiClient, 'settings' | 'credentials'>,
  controller: ModelsSettingsStore,
  target: { settingsNs: string; settingsPath: readonly string[]; credentialRef?: string },
): Promise<string | undefined> {
  try {
    if (target.credentialRef !== undefined) {
      const credential = await api.credentials.unset({ ref: target.credentialRef })
      if (!credential.result.ok) return credential.result.error.message
    }
    const response = await api.settings.mutate({
      ns: target.settingsNs,
      ops: [{ op: 'unset', path: [...target.settingsPath] }],
    })
    if (!response.result.ok) return response.result.error.message
  } catch (error) {
    // The transport rejected rather than answering; the caller must be able
    // to retry the idempotent operation instead of the row silently staying.
    return messageOf(error)
  }
  await controller.load()
  return undefined
}

/**
 * Whether a whole-section provider still needs its first key: an unconfigured
 * credential opens the setup card instead of showing a row. This is the
 * first-run posture alone — a user who can already reach some provider gets an
 * ordinary row with the missing-key dot, since nothing here is blocking them.
 * @param row - the joined provider row.
 * @param anyUsable - whether any joined row can already serve requests.
 * @returns whether to render the setup card.
 */
export function needsSetup(row: ProviderRow, anyUsable: boolean): boolean {
  if (anyUsable) return false
  if (row.entry.settingsPath.length > 0) return false
  return row.credential?.configured !== true
}

function targetOf(row: ProviderRow): EditorTarget {
  const managedRef = deriveKeyRef(row.entry.provider)
  const credentialRef = row.apiKeyEnv === managedRef
    && row.credential?.configured === true
    && row.credential.writable
    ? managedRef
    : undefined
  return {
    provider: row.entry.provider,
    displayName: row.entry.displayName,
    settingsNs: row.entry.settingsNs,
    settingsPath: row.entry.settingsPath,
    ...credentialRef === undefined ? {} : { credentialRef },
    // Absent is not "shipped": an adapter that answers nothing leaves the
    // route-level fields only a declared route owns off the card, exactly as
    // it leaves the custom tag off the row.
    ...row.entry.declared === true ? { declared: true } : {},
  }
}

/** Stable visible and accessible identity for one provider target. */
export function providerTargetLabel(target: ProviderIdentity): string {
  return target.provider === target.displayName
    ? target.provider
    : `${target.displayName} (${target.provider})`
}

/** Replace the one provider placeholder in localized destructive-action copy. */
export function providerCopy(template: string, target: ProviderIdentity): string {
  return template.replace('{provider}', () => providerTargetLabel(target))
}

/**
 * Render the Models section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, api, schema, t } = props
  if (
    controller === undefined || useSnapshot === undefined || api === undefined
    || schema === undefined || t === undefined
  ) return null
  return <Loaded injected={{ controller, useSnapshot, api, schema, t }} />
}

function Loaded({ injected }: { injected: ModelsSectionFace }): ReactNode {
  const { controller, api, schema, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)
  const [editing, setEditing] = useState<EditorTarget | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<EditorTarget | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<ProviderIdentity | undefined>(undefined)
  const [declaring, setDeclaring] = useState(false)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [providerQuery, setProviderQuery] = useState('')
  const [mobileDetail, setMobileDetail] = useState(false)
  const [editorEpoch, setEditorEpoch] = useState(0)
  const [visionBusy, setVisionBusy] = useState(false)
  const [visionError, setVisionError] = useState<string | undefined>(undefined)

  const announceSaved = async (target: ProviderIdentity): Promise<void> => {
    // 等待镜像与渠道目录联接完成，再让保存提示和新的编辑器读取同一 revision。
    await controller.load()
    setSavedTarget(target)
  }

  const closeEditor = async (changed: boolean, target: ProviderIdentity): Promise<void> => {
    if (changed) await announceSaved(target)
    setEditing(undefined)
    setAdding(false)
    setDeclaring(false)
  }

  const closeDelete = (): void => {
    if (deleting) return
    setDeleteTarget(undefined)
    setDeleteFailure(undefined)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteFailure(undefined)
    void removeProviderProfile(api, controller, deleteTarget)
      .then((failure) => {
        if (failure !== undefined) {
          setDeleteFailure(failure)
          return
        }
        setDeleteTarget(undefined)
      })
      .finally(() => { setDeleting(false) })
  }

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  // The saved provider as the directory currently names it. The route id is
  // what the apply cannot change, so it is what the notice is keyed by; a row
  // the same apply removed keeps the captured identity, since nothing newer
  // exists to name it with.
  const savedRow = savedTarget === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === savedTarget.provider)
  const savedIdentity = savedRow === undefined
    ? savedTarget
    : { provider: savedRow.entry.provider, displayName: savedRow.entry.displayName }

  const configured = state.rows.filter(row => row.configured)
  const directory = state.rows.filter(row => row.entry.settingsNs !== '' && state.namespaces.has(row.entry.settingsNs))
  const addable = state.rows.filter(row => !row.configured && row.entry.settingsNs !== '')
  const addTarget = adding ? editing : undefined
  const addNamespace = addTarget === undefined ? undefined : state.namespaces.get(addTarget.settingsNs)
  // Hand-declared routes live in the pi-ai namespace, which is also the only
  // one whose schema names the protocols one may speak; without it mounted
  // there is nothing to declare and the entry point stays disabled.
  const protocols = protocolChoices(state.namespaces.get('llm-pi-ai'), schema)

  const current = directory.find(row => row.entry.provider === selected) ?? configured[0] ?? directory[0]
  const currentTarget = current === undefined ? undefined : targetOf(current)
  const currentNamespace = currentTarget === undefined ? undefined : state.namespaces.get(currentTarget.settingsNs)
  const visibleProviders = directory.filter(row =>
    `${row.entry.displayName} ${row.entry.provider}`.toLocaleLowerCase().includes(providerQuery.toLocaleLowerCase()))
  const visionNamespace = state.namespaces.get('vision-understanding')
  const visionProvider = visionNamespace === undefined ? undefined : schema.getPath(visionNamespace.value, ['provider'])
  const visionModel = visionNamespace === undefined ? undefined : schema.getPath(visionNamespace.value, ['model'])
  const visionValue = typeof visionProvider === 'string' && typeof visionModel === 'string'
    ? JSON.stringify([visionProvider, visionModel]) : ''
  const visionKnown = state.visionModels.some(choice => JSON.stringify([choice.provider, choice.model]) === visionValue)

  const chooseVision = (value: string): void => {
    const choice = state.visionModels.find(item => JSON.stringify([item.provider, item.model]) === value)
    setVisionBusy(true)
    setVisionError(undefined)
    void controller.setVisionTarget(choice === undefined ? undefined : { provider: choice.provider, model: choice.model })
      .then((error) => { setVisionError(error) })
      .finally(() => { setVisionBusy(false) })
  }

  return (
    <div className={styles['channelPage']}>
      <aside className={`${styles['channelRail']} ${mobileDetail ? styles['mobileHidden'] : ''}`} aria-label={t('provider')}>
        <label className={styles['channelSearch']}>
          <IconSearchOutline16 size={17} />
          <input value={providerQuery} onChange={(event) => { setProviderQuery(event.target.value) }}
            placeholder={t('searchProviders')} aria-label={t('searchProviders')} />
        </label>
        <div className={styles['channelRows']}>
          {visibleProviders.map(row => (
            <button key={row.entry.provider} type="button"
              className={`${styles['channelRow']} ${current?.entry.provider === row.entry.provider ? styles['channelSelected'] : ''}`}
              aria-current={current?.entry.provider === row.entry.provider ? 'true' : undefined}
              onClick={() => {
                setSavedTarget(undefined)
                setSelected(row.entry.provider)
                setAdding(false)
                setDeclaring(false)
                setMobileDetail(true)
              }}>
              <span className={styles['channelAvatar']} aria-hidden="true">{row.entry.displayName.charAt(0).toLocaleUpperCase()}</span>
              <span className={styles['channelName']}>{row.entry.displayName}</span>
              {row.credential?.configured === true ? <span className={styles['channelConfigured']}>{t('configuredShort')}</span> : null}
            </button>
          ))}
        </div>
        <div className={styles['channelAddActions']}>
          <button type="button" className={styles['channelAdd']} disabled={addable.length === 0 || !state.writable}
            onClick={() => {
              const first = addable[0]
              if (first === undefined) return
              setSavedTarget(undefined)
              setAdding(true)
              setDeclaring(false)
              setEditing(targetOf(first))
              setMobileDetail(true)
            }}>
            <IconPlusOutline16 size={16} />{t('add')}
          </button>
          <button type="button" className={styles['channelAdd']} disabled={protocols.length === 0 || !state.writable}
            onClick={() => { setSavedTarget(undefined); setDeclaring(true); setAdding(false); setMobileDetail(true) }}>
            <IconPlusOutline16 size={16} />{t('customAdd')}
          </button>
        </div>
      </aside>
      <main className={`${styles['channelDetail']} ${!mobileDetail ? styles['mobileHiddenDetail'] : ''}`}>
        <button type="button" className={styles['channelBack']} onClick={() => { setMobileDetail(false) }}>
          <IconChevronLeftOutline14 size={16} />{t('provider')}
        </button>
        {savedIdentity === undefined ? null : <p role="status" className={styles['savedNotice']}>{providerCopy(t('savedProvider'), savedIdentity)}</p>}
        {!state.writable ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
        {adding && addTarget !== undefined && addNamespace !== undefined ? (
          <div className={styles['channelEditor']}>
            <label className={styles['field']}><span className={styles['fieldLabel']}>{t('provider')}</span>
              <select className={`${styles['input']} ${styles['selectInput']}`} value={addTarget.provider} onChange={(event) => {
                const row = addable.find(candidate => candidate.entry.provider === event.target.value)
                if (row !== undefined) {
                  setSavedTarget(undefined)
                  setEditing(targetOf(row))
                }
              }}>{addable.map(row => <option key={row.entry.provider} value={row.entry.provider}>{row.entry.displayName}</option>)}</select>
            </label>
            <ProviderEditor key={addTarget.provider} {...addTarget} namespace={addNamespace} schema={schema} api={api} t={t}
              readOnly={!state.writable} channelLayout
              onSettingsCommitted={(view) => { controller.acceptSettingsView(view) }}
              onClose={async (changed) => {
                await closeEditor(changed, addTarget)
                if (changed) setSelected(addTarget.provider)
                setEditorEpoch(n => n + 1)
              }} />
          </div>
        ) : declaring ? (
          <CustomProviderCard taken={state.rows.map(row => row.entry.provider)} protocols={protocols}
            revision={state.namespaces.get('llm-pi-ai')?.revision ?? 0} api={api} t={t} readOnly={!state.writable}
            onSettingsCommitted={(view) => { controller.acceptSettingsView(view) }}
            onClose={async (changed) => {
              if (changed) await controller.load()
              setDeclaring(false)
            }} />
        ) : currentTarget !== undefined && currentNamespace !== undefined ? (
          <div className={styles['channelEditor']}>
            <div className={styles['channelHeading']}>
              <h2>{currentTarget.displayName}</h2>
              {current?.removable ? <button type="button" className={styles['dangerButton']} disabled={!state.writable}
                onClick={() => { setDeleteTarget(currentTarget) }}>{t('remove')}</button> : null}
            </div>
            <ProviderEditor key={`${currentTarget.provider}:${editorEpoch}`} {...currentTarget} namespace={currentNamespace}
              schema={schema} api={api} t={t} readOnly={!state.writable} hideTitle channelLayout
              onSettingsCommitted={(view) => { controller.acceptSettingsView(view) }}
              onClose={async (changed) => {
                if (changed) await announceSaved(currentTarget)
                setEditorEpoch(n => n + 1)
              }} />
          </div>
        ) : <p className={styles['intro']}>{t('intro')}</p>}
        {visionNamespace === undefined ? null : <section className={styles['visionFallback']} aria-label={t('visionTool')}>
          <h3>{t('visionTool')}</h3>
          <p>{t('visionToolDescription')}</p>
          <label className={styles['field']}><span className={styles['fieldLabel']}>{t('visionRoute')}</span>
            <select className={`${styles['input']} ${styles['selectInput']}`} value={visionValue}
              disabled={!state.writable || visionBusy} onChange={(event) => { chooseVision(event.target.value) }}>
              <option value="">{t('visionNotConfigured')}</option>
              {visionValue !== '' && !visionKnown ? <option value={visionValue}>{`${String(visionProvider)}/${String(visionModel)}`}</option> : null}
              {state.visionModels.map(choice => <option key={JSON.stringify([choice.provider, choice.model])}
                value={JSON.stringify([choice.provider, choice.model])}>{`${choice.providerName} / ${choice.modelName}`}</option>)}
            </select>
          </label>
          {visionBusy ? <p role="status">{t('applying')}</p> : null}
          {visionError === undefined ? null : <p role="alert" className={styles['error']}>{visionError}</p>}
        </section>}
      </main>
      <Modal open={deleteTarget !== undefined} onClose={closeDelete}
        title={deleteTarget === undefined ? '' : providerCopy(t('deleteTitle'), deleteTarget)} closeLabel={t('close')}
        description={deleteTarget === undefined ? '' : providerCopy(deleteTarget.credentialRef === undefined
          ? t('deleteDescription') : t('deleteDescriptionWithCredential'), deleteTarget)}
        footer={<><Button variant="outline" autoFocus disabled={deleting} onClick={closeDelete}>{t('cancel')}</Button>
          <Button variant="outline" disabled={deleting} onClick={confirmDelete}>{deleteTarget === undefined ? '' : providerCopy(t('deleteConfirm'), deleteTarget)}</Button></>}>
        {deleteFailure === undefined ? null : <p role="alert" className={styles['error']}>{deleteFailure}</p>}
      </Modal>
    </div>
  )

}
