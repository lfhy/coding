/**
 * 设置模态框的模型分区：中列显示渠道，右列显示渠道详情。
 * 写入由编辑器和页面控制器执行，组件只持有导航、草稿和弹窗交互状态。
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

/** 模型分区由 slot 注入的设置镜像与写入能力。 */
export interface ModelsSectionInjected {
  /** 首次挂载时加载，接收推送失效通知后刷新的共享页面 store。 */
  controller: ModelsSettingsStore
  hooks: {
    /** 由 UI renderer 绑定为 useSnapshot 的页面快照。 */
    snapshot: ModelsSettingsStore['store']
  }
  /** 编辑器写入使用的 wire 接口。 */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** 设置 schema 与路径读取操作。 */
  schema: SettingsSchemaOperations
  /** 分区文案。 */
  t: (key: keyof typeof en) => string
}

/**
 * slot outlet 展开 inject face；引导可隐藏本分区标题，外层弹窗自行提供标题。
 */
export type ModelsSectionProps = Partial<InjectFace<ModelsSectionInjected>> & {
  /** 引导弹窗拥有自己的标题时隐藏设置分区标题。 */
  hideHeader?: boolean
}

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
 * 绘制模型设置中的渠道目录与详情。
 * @param props - slot 注入的能力及可选标题呈现配置。
 * @returns 模型分区；尚未注入依赖时不渲染。
 */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, api, schema, t, hideHeader = false } = props
  if (
    controller === undefined || useSnapshot === undefined || api === undefined
    || schema === undefined || t === undefined
  ) return null
  return <Loaded injected={{ controller, useSnapshot, api, schema, t }} hideHeader={hideHeader} />
}

function Loaded({ injected, hideHeader }: { injected: ModelsSectionFace; hideHeader: boolean }): ReactNode {
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
        setSavedTarget(undefined)
      })
      .finally(() => { setDeleting(false) })
  }

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error' && !state.hasLoaded) {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.retry() }}>
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

  const directory = state.rows.filter(row => row.entry.settingsNs !== '' && state.namespaces.has(row.entry.settingsNs))
  // 主列表保留已有 profile；未配置的目录条目只由显式添加流程呈现。
  const channels = directory.filter(row => row.configured)
  const addable = directory.filter(row => !row.configured)
  const addTarget = adding ? editing : undefined
  const addNamespace = addTarget === undefined ? undefined : state.namespaces.get(addTarget.settingsNs)
  // 自定义渠道由 pi-ai 分节持有；未挂载该分节时不能声明渠道。
  const protocols = protocolChoices(state.namespaces.get('llm-pi-ai'), schema)

  const current = channels.find(row => row.entry.provider === selected) ?? channels[0]
  const currentTarget = current === undefined ? undefined : targetOf(current)
  const currentNamespace = currentTarget === undefined ? undefined : state.namespaces.get(currentTarget.settingsNs)
  const visibleProviders = channels.filter(row =>
    `${row.entry.displayName} ${row.entry.provider}`.toLocaleLowerCase().includes(providerQuery.toLocaleLowerCase()))
  return (
    <div className={styles['modelsSurface']}>
      {state.status === 'error' && !hideHeader ? <div role="alert" className={styles['error']}>
        {`${t('loadFailed')}: ${state.error ?? ''}`}{' '}
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.retry() }}>
          {t('retry')}
        </button>
      </div> : null}
      {!hideHeader ? <header className={styles['modelsHeader']}><h1>{t('title')}</h1></header> : null}
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
            <button type="button" className={styles['channelAdd']} disabled={addable.length === 0 || !state.writable || state.status !== 'ready'}
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
            <button type="button" className={styles['channelAdd']} disabled={protocols.length === 0 || !state.writable || state.status !== 'ready'}
              onClick={() => {
                setSavedTarget(undefined)
                setDeclaring(true)
                setAdding(false)
                setMobileDetail(true)
              }}>
              <IconPlusOutline16 size={16} />{t('customAdd')}
            </button>
          </div>
        </aside>
        <main className={`${styles['channelDetail']} ${!mobileDetail ? styles['mobileHiddenDetail'] : ''}`}
          onChangeCapture={() => { setSavedTarget(undefined) }}>
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
                }}>{addable.map(row => (
                    <option key={row.entry.provider} value={row.entry.provider}>{row.entry.displayName}</option>
                  ))}</select>
              </label>
              <ProviderEditor key={addTarget.provider} {...addTarget} namespace={addNamespace} schema={schema} api={api} t={t}
                readOnly={!state.writable || state.status !== 'ready'} channelLayout
                onSettingsCommitted={(view) => { controller.acceptSettingsView(view) }}
                onClose={async (changed) => {
                  await closeEditor(changed, addTarget)
                  if (changed) setSelected(addTarget.provider)
                  setEditorEpoch(n => n + 1)
                }} />
            </div>
          ) : declaring ? (
            <CustomProviderCard taken={state.rows.map(row => row.entry.provider)} protocols={protocols}
              revision={state.namespaces.get('llm-pi-ai')?.revision ?? 0} api={api} t={t} readOnly={!state.writable || state.status !== 'ready'}
              onSettingsCommitted={(view) => { controller.acceptSettingsView(view) }}
              onClose={async (changed) => {
                if (changed) await controller.load()
                setDeclaring(false)
              }} />
          ) : currentTarget !== undefined && currentNamespace !== undefined ? (
            <div className={styles['channelEditor']}>
              <div className={styles['channelHeading']}>
                <h2>{currentTarget.displayName}</h2>
                {current?.removable ? <button type="button" className={styles['dangerButton']} disabled={!state.writable || state.status !== 'ready'}
                  onClick={() => { setDeleteTarget(currentTarget) }}>{t('remove')}</button> : null}
              </div>
              <ProviderEditor key={`${currentTarget.provider}:${editorEpoch}`} {...currentTarget} namespace={currentNamespace}
                schema={schema} api={api} t={t} readOnly={!state.writable || state.status !== 'ready'} hideTitle channelLayout
                onSettingsCommitted={(view) => { controller.acceptSettingsView(view) }}
                onClose={async (changed) => {
                  if (changed) await announceSaved(currentTarget)
                  setEditorEpoch(n => n + 1)
                }} />
            </div>
          ) : <p className={styles['intro']}>{t('intro')}</p>}
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
    </div>
  )

}
