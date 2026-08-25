/** 工作区选择菜单、目录采用流程与远程连接输入。 */
import type { FormEvent, ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button, IconFolderClose16, IconGlobeOutline14, IconProjectAddOutline16,
  IconNewChatOutline16, IconSearchOutline16, Input, Menu, Modal, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'
import { RemoteHostUrlError } from './remote.ts'

const OPEN_FOLDER = '::open-folder'
const CONNECT_REMOTE = '::connect-remote'
const WITHOUT_PROJECT = '::without-project'

/** 选择器核心属性；侧边栏只传目录操作，Hero 额外传远程和无项目操作。 */
export interface WorkspacePickFlowProps {
  /** 所在 slot 的本地化函数。 */
  t: WorkspacePickerProps['t']
  /** 锚点选择器是否展开。 */
  open: boolean
  /** 菜单定位锚点。 */
  anchorRef?: RefObject<HTMLElement | null> | undefined
  /** 工作区列表的标准 selector hook。 */
  useWorkspaces: <S>(selector: (state: WorkspaceListState) => S) => S
  /** 采用 Host 目录并创建工作区。 */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
  /** 当前表层的目录流是否已由能力包占用。 */
  useDirectoryFlow: SnapshotSelectorHook<boolean>
  /** 渲染目录流 slot。 */
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
  /** 选中已有或新建的工作区。 */
  onPick: (workspaceId: WorkspaceId) => void
  /** 关闭菜单。 */
  onClose: () => void
  /** 侧边栏“添加工作区”入口只保留目录流。 */
  addOnly?: boolean
  /** 菜单相对锚点的展开方向。 */
  side?: 'bottom' | 'top' | 'right'
  /** 当前工作区。 */
  selectedId?: WorkspaceId | undefined
  /** 创建并打开不归属任何工作区的会话。 */
  startSessionWithoutWorkspace?: (() => Promise<void>) | undefined
  /** 跳转至输入地址对应的远程 Host 页面。 */
  connectRemote?: ((address: string) => void | Promise<void>) | undefined
}

/** 将任意失败值转换为可显示的错误文本。 */
function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** 将远程地址校验错误转换为当前界面的本地化文案。 */
function remoteErrorText(t: WorkspacePickerProps['t'], reason: unknown): string {
  if (!(reason instanceof RemoteHostUrlError)) return errorText(reason)
  switch (reason.code) {
    case 'empty': return t('picker.remote.error.empty')
    case 'missing-protocol': return t('picker.remote.error.missingProtocol')
    case 'unsupported-protocol': return t('picker.remote.error.unsupportedProtocol')
    case 'credentials': return t('picker.remote.error.credentials')
  }
}

/**
 * 渲染工作区选择菜单及其目录、远程和无项目操作。
 * @param props - 选择器的数据、操作与 slot 渲染权限。
 * @returns 菜单与所拥有的对话框。
 */
export function WorkspacePickFlow({
  t,
  open,
  anchorRef,
  useWorkspaces,
  createWorkspace,
  useDirectoryFlow,
  renderDirectoryFlow,
  onPick,
  onClose,
  addOnly = false,
  side = 'bottom',
  selectedId,
  startSessionWithoutWorkspace,
  connectRemote,
}: WorkspacePickFlowProps) {
  const workspaceSnapshot = useWorkspaces(state => state)
  const workspaces = workspaceSnapshot.items
  const getAnchorRect = useCallback(
    () => anchorRef?.current?.getBoundingClientRect() ?? null,
    [anchorRef],
  )
  const [folderErrorOpen, setFolderErrorOpen] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [flowOpen, setFlowOpen] = useState(false)
  const [pickingFolder, setPickingFolder] = useState(false)
  const [query, setQuery] = useState('')
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [remoteAddress, setRemoteAddress] = useState('')
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [remoteConnecting, setRemoteConnecting] = useState(false)
  const [startingWithoutProject, setStartingWithoutProject] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const flowBusy = flowOpen || pickingFolder
  const actionBusy = flowBusy || remoteConnecting || startingWithoutProject
  const flowAvailable = useDirectoryFlow(occupied => occupied)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleWorkspaces = useMemo(() => workspaces.filter(workspace => (
    normalizedQuery === ''
      || workspace.title.toLocaleLowerCase().includes(normalizedQuery)
      || workspace.path.toLocaleLowerCase().includes(normalizedQuery)
  )), [normalizedQuery, workspaces])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  useEffect(() => {
    if (flowOpen && !flowAvailable) setFlowOpen(false)
  }, [flowAvailable, flowOpen])

  const closeFolderError = (): void => {
    setFolderErrorOpen(false)
    setFolderError(null)
  }

  const adoptDirectory = (path: string): Promise<void> => (
    createWorkspace({ path }).then((workspace) => {
      setFlowOpen(false)
      onPick(workspace.workspaceId)
    }).catch((reason: unknown) => {
      setFolderError(errorText(reason))
      setFlowOpen(false)
      setFolderErrorOpen(true)
    })
  )

  const openDirectoryFlow = useCallback((): void => {
    onClose()
    setFolderErrorOpen(false)
    setFolderError(null)
    setFlowOpen(true)
  }, [onClose])

  const closeRemote = (): void => {
    if (remoteConnecting) return
    setRemoteOpen(false)
    setRemoteAddress('')
    setRemoteError(null)
  }

  const submitRemote = (event?: FormEvent<HTMLFormElement>): void => {
    event?.preventDefault()
    if (connectRemote === undefined || remoteConnecting) return
    setRemoteError(null)
    setRemoteConnecting(true)
    void Promise.resolve().then(() => connectRemote(remoteAddress)).then(
      () => { setRemoteOpen(false) },
      (reason: unknown) => { setRemoteError(remoteErrorText(t, reason)) },
    ).finally(() => { setRemoteConnecting(false) })
  }

  const startWithoutProject = (): void => {
    if (startSessionWithoutWorkspace === undefined || startingWithoutProject) return
    onClose()
    setSessionError(null)
    setStartingWithoutProject(true)
    void startSessionWithoutWorkspace().catch((reason: unknown) => {
      setSessionError(errorText(reason))
    }).finally(() => { setStartingWithoutProject(false) })
  }

  const folderEntries: MenuEntry[] = flowAvailable
    ? [{
      id: OPEN_FOLDER,
      label: addOnly ? t('menu.addWorkspace') : t('picker.openFolder'),
      icon: <IconProjectAddOutline16 size={16} />,
      disabled: actionBusy,
    }]
    : []
  const workspaceEntries: MenuEntry[] = visibleWorkspaces.map(workspace => ({
    id: workspace.workspaceId,
    label: workspace.title,
    icon: <IconFolderClose16 size={16} />,
    disabled: actionBusy,
  }))
  if (!addOnly && normalizedQuery !== '' && workspaceEntries.length === 0 && workspaceSnapshot.phase === 'ready') {
    workspaceEntries.push({ type: 'label', id: '::no-matches', text: t('picker.noMatches') })
  }
  const auxiliaryEntries: MenuEntry[] = addOnly
    ? []
    : [
      ...folderEntries,
      ...(connectRemote === undefined ? [] : [{
        id: CONNECT_REMOTE,
        label: t('picker.remoteConnect'),
        icon: <IconGlobeOutline14 size={16} />,
        disabled: actionBusy,
      }]),
      ...(startSessionWithoutWorkspace === undefined ? [] : [{
        id: WITHOUT_PROJECT,
        label: t('picker.noProject'),
        icon: <IconNewChatOutline16 size={16} />,
        disabled: actionBusy,
      }]),
    ]
  const menuEntries = addOnly ? folderEntries : workspaceEntries
  const menuFooter = addOnly ? undefined : auxiliaryEntries
  const menuIsEmpty = menuEntries.length === 0 && (menuFooter?.length ?? 0) === 0
  const listSettled = addOnly || workspaceSnapshot.phase === 'ready'
  const addIsTheOnlyEntry = addOnly && listSettled && folderEntries.length === 1

  useEffect(() => {
    if (open && addIsTheOnlyEntry && !flowBusy) openDirectoryFlow()
  }, [addIsTheOnlyEntry, flowBusy, open, openDirectoryFlow])

  const flowOwner: DirectoryFlowOwnerProps = {
    open: flowOpen,
    busy: pickingFolder,
    onPicked: (path) => {
      setPickingFolder(true)
      void adoptDirectory(path).finally(() => { setPickingFolder(false) })
    },
    onCancel: () => { setFlowOpen(false) },
    onError: (message) => {
      setFlowOpen(false)
      setFolderError(message)
      setFolderErrorOpen(true)
    },
  }

  const handleSelect = (id: string): void => {
    if (id === OPEN_FOLDER) {
      openDirectoryFlow()
      return
    }
    if (id === CONNECT_REMOTE) {
      onClose()
      setRemoteOpen(true)
      return
    }
    if (id === WITHOUT_PROJECT) {
      startWithoutProject()
      return
    }
    onPick(id as WorkspaceId)
  }

  return (
    <>
      <Menu
        open={open && !addIsTheOnlyEntry && !menuIsEmpty}
        anchor={null}
        header={!addOnly ? (
          <Input
            className={css.searchInput ?? ''}
            icon={<IconSearchOutline16 size={16} />}
            aria-label={t('picker.search.aria')}
            placeholder={t('picker.search.placeholder')}
            value={query}
            autoFocus
            onChange={(event) => { setQuery(event.target.value) }}
          />
        ) : undefined}
        items={menuEntries}
        {...menuFooter !== undefined ? { footer: menuFooter } : {}}
        selectedId={selectedId}
        onSelect={handleSelect}
        onClose={onClose}
        side={side}
        portal
        getAnchorRect={getAnchorRect}
      />
      {open && !addIsTheOnlyEntry && !menuIsEmpty && workspaceSnapshot.phase === 'pending' && (
        <div className={css.menuStatus} role="status">{t('picker.loading')}</div>
      )}
      {renderDirectoryFlow(flowOwner)}
      <Modal
        open={folderErrorOpen}
        onClose={closeFolderError}
        closeLabel={t('close')}
        title={t('folderError.title')}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} onClick={closeFolderError}>{t('cancel')}</Button>
            <Button variant="primary" className={css.modalAction} disabled={!flowAvailable} onClick={openDirectoryFlow}>{t('folderError.retry')}</Button>
          </>
        )}
      >
        <div className={css.modalError} role="alert">{folderError}</div>
      </Modal>
      <Modal
        open={remoteOpen}
        onClose={closeRemote}
        closeLabel={t('close')}
        title={t('picker.remote.title')}
        description={t('picker.remote.description')}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} disabled={remoteConnecting} onClick={closeRemote}>{t('cancel')}</Button>
            <Button
              variant="primary"
              className={css.modalAction}
              disabled={remoteConnecting || remoteAddress.trim() === ''}
              onClick={() => { submitRemote() }}
            >
              {t('picker.remote.confirm')}
            </Button>
          </>
        )}
      >
        <form className={css.remoteForm} onSubmit={submitRemote}>
          <label className={css.remoteLabel} htmlFor="workspace-remote-address">{t('picker.remote.address')}</label>
          <Input
            id="workspace-remote-address"
            className={css.remoteInput ?? ''}
            type="url"
            inputMode="url"
            autoFocus
            disabled={remoteConnecting}
            placeholder={t('picker.remote.placeholder')}
            value={remoteAddress}
            onChange={(event) => { setRemoteAddress(event.target.value) }}
          />
          {remoteError !== null && <div className={css.modalError} role="alert">{remoteError}</div>}
        </form>
      </Modal>
      <Modal
        open={sessionError !== null}
        onClose={() => { setSessionError(null) }}
        closeLabel={t('close')}
        title={t('picker.sessionError.title')}
        footer={<Button variant="primary" className={css.modalAction} onClick={() => { setSessionError(null) }}>{t('close')}</Button>}
      >
        <div className={css.modalError} role="alert">{sessionError}</div>
      </Modal>
    </>
  )
}

/** 将 Hero slot 的属性适配到通用选择器。 */
export function WorkspacePicker({
  open,
  anchorRef,
  useWorkspaces,
  selectedId,
  onPick,
  onClose,
  createWorkspace,
  startSessionWithoutWorkspace,
  connectRemote,
  useDirectoryFlow,
  renderSlot,
  t,
}: WorkspacePickerProps) {
  return (
    <WorkspacePickFlow
      t={t}
      open={open}
      anchorRef={anchorRef}
      useWorkspaces={useWorkspaces}
      createWorkspace={createWorkspace}
      startSessionWithoutWorkspace={startSessionWithoutWorkspace}
      connectRemote={connectRemote}
      useDirectoryFlow={useDirectoryFlow}
      renderDirectoryFlow={owner => renderSlot('conversation.hero.workspace.directoryFlow', owner)}
      selectedId={selectedId}
      onPick={onPick}
      onClose={onClose}
    />
  )
}
