/** 工作区选择菜单、目录采用流程与 Remote-SSH 向导。 */
import type { ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutline16, IconCloseOutline16, IconCodeOutline16,
  IconFolderClose16, IconFolderOpenOutline16, IconProjectAddOutline16,
  IconNewChatOutline16, IconSearchOutline16, Input, Menu, Modal, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'
import remoteCss from './RemoteSshWizard.module.css'
import {
  getRemoteSshBridge, RemoteSshBridgeError, RemoteSshConfigError,
  validateRemoteSshConfig, type RemoteSshAuthKind, type RemoteSshConnectInput,
  type RemoteSshDirectoryListing, type RemoteSshProgress,
} from './remote.ts'

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
}

/** 将任意失败值转换为可显示的错误文本。 */
function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * 渲染工作区选择菜单及其目录、Remote-SSH 和无项目操作。
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
  const [startingWithoutProject, setStartingWithoutProject] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const flowBusy = flowOpen || pickingFolder
  const actionBusy = flowBusy || startingWithoutProject
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
      {
        id: CONNECT_REMOTE,
        label: t('picker.remoteConnect'),
        icon: <IconCodeOutline16 size={16} />,
        disabled: actionBusy,
      },
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
      <RemoteSshWizard
        open={remoteOpen}
        onClose={() => { setRemoteOpen(false) }}
        t={t}
        createWorkspace={createWorkspace}
        onPick={onPick}
      />
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
      useDirectoryFlow={useDirectoryFlow}
      renderDirectoryFlow={owner => renderSlot('conversation.hero.workspace.directoryFlow', owner)}
      selectedId={selectedId}
      onPick={onPick}
      onClose={onClose}
    />
  )
}

type WizardStep = 'config' | 'progress' | 'directory'

type ConnectedRemote = {
  connectionId: string
  homePath?: string | undefined
}

type HostKeyConfirmation = {
  confirmationId: string
  fingerprint: string
  algorithm: string
}

const remoteSteps = [
  { id: 'config', label: 'picker.remote.step.config', hint: 'picker.remote.step.config.hint' },
  { id: 'progress', label: 'picker.remote.step.progress', hint: 'picker.remote.step.progress.hint' },
  { id: 'directory', label: 'picker.remote.step.directory', hint: 'picker.remote.step.directory.hint' },
] as const

const remoteProgressPhases: readonly RemoteSshProgress['phase'][] = [
  'authenticating', 'probing', 'uploading', 'starting', 'ready',
]

let fallbackRemoteAttemptSequence = 0

/** 为一次 native Connect 生成只用于取消与进度关联的短期标识。 */
function remoteAttemptId(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  fallbackRemoteAttemptSequence++
  return `wizard-${Date.now().toString(36)}-${fallbackRemoteAttemptSequence.toString(36)}`
}

/** 将 bridge 或表单异常转为不包含认证材料的可显示文本。 */
function remoteErrorText(t: WorkspacePickerProps['t'], reason: unknown): string {
  if (reason instanceof RemoteSshConfigError) {
    switch (reason.code) {
      case 'host': return t('picker.remote.error.host')
      case 'port': return t('picker.remote.error.port')
      case 'username': return t('picker.remote.error.username')
      case 'secret': return t('picker.remote.error.secret')
    }
  }
  if (reason instanceof RemoteSshBridgeError) return t('picker.remote.error.bridge')
  return reason instanceof Error ? reason.message : t('picker.remote.error.bridge')
}

/** 把远端路径向上一层折叠，兼容 POSIX 与 Windows agent 返回的路径。 */
function remoteParentPath(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/'
  if (separator === '\\' && /^[A-Za-z]:\\$/u.test(path)) return path
  if (separator === '\\') {
    const uncRoot = path.match(/^\\\\[^\\]+\\[^\\]+/u)?.[0]
    if (uncRoot !== undefined && (path === uncRoot || path === `${uncRoot}\\`)) return uncRoot
  }
  const trimmed = path.endsWith(separator) && path.length > 1 ? path.slice(0, -1) : path
  const at = trimmed.lastIndexOf(separator)
  if (at <= 0) return separator
  if (separator === '\\' && at === 2 && /^[A-Za-z]:/u.test(trimmed)) return trimmed.slice(0, at + 1)
  return trimmed.slice(0, at)
}

/** 将当前向导步骤映射到静态字典键，避免把运行时字符串扩宽为未校验的翻译键。 */
function remoteStepCopy(t: WorkspacePickerProps['t'], step: WizardStep): { title: string; description: string } {
  switch (step) {
    case 'config': return { title: t('picker.remote.config.title'), description: t('picker.remote.config.description') }
    case 'progress': return { title: t('picker.remote.progress.title'), description: t('picker.remote.progress.description') }
    case 'directory': return { title: t('picker.remote.directory.title'), description: t('picker.remote.directory.description') }
  }
}

/** 连接阶段的静态本地化名称。 */
function remoteProgressLabel(t: WorkspacePickerProps['t'], phase: RemoteSshProgress['phase']): string {
  switch (phase) {
    case 'authenticating': return t('picker.remote.progress.authenticating')
    case 'probing': return t('picker.remote.progress.probing')
    case 'uploading': return t('picker.remote.progress.uploading')
    case 'starting': return t('picker.remote.progress.starting')
    case 'ready': return t('picker.remote.progress.ready')
    case 'failed': return t('picker.remote.progress.failed')
  }
}

/** 远程工作区向导的属性。 */
interface RemoteSshWizardProps {
  open: boolean
  onClose: () => void
  t: WorkspacePickerProps['t']
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
  onPick: (workspaceId: WorkspaceId) => void
}

/**
 * 从 SSH 配置、主机密钥确认到 marker 工作区创建的一次性桌面流程。
 * @param props - 对话框控制、工作区采用和本地化属性。
 * @returns 三步 Remote-SSH 对话框。
 */
export function RemoteSshWizard({ open, onClose, t, createWorkspace, onPick }: RemoteSshWizardProps) {
  const bridge = useMemo(() => (open ? getRemoteSshBridge() : undefined), [open])
  const [step, setStep] = useState<WizardStep>('config')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [authKind, setAuthKind] = useState<RemoteSshAuthKind>('password')
  const [secret, setSecret] = useState('')
  const [progress, setProgress] = useState<Omit<RemoteSshProgress, 'attemptId'>>({ phase: 'authenticating', message: '' })
  const [hostKey, setHostKey] = useState<HostKeyConfirmation | undefined>()
  const [connection, setConnection] = useState<ConnectedRemote | undefined>()
  const [directory, setDirectory] = useState<RemoteSshDirectoryListing | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [connecting, setConnecting] = useState(false)
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [selectingDirectory, setSelectingDirectory] = useState(false)
  const attempt = useRef(0)
  const directoryRequest = useRef(0)
  const activeConnection = useRef<ConnectedRemote | undefined>()
  const pendingHostKey = useRef<HostKeyConfirmation | undefined>()
  const connectOperation = useRef<number | undefined>()
  const nativeConnectAttempt = useRef<{ generation: number; attemptId: string } | undefined>()
  const selectionInFlight = useRef(false)
  // 已经发出的选择请求临时持有连接。外部关闭向导时，不能在 marker 发布前
  // 抢先关闭它；若选择失败，持有者再归还连接。
  const pendingSelections = useRef(new Map<string, boolean>())
  const lastBridge = useRef<typeof bridge>()

  useEffect(() => {
    if (bridge !== undefined) lastBridge.current = bridge
  }, [bridge])

  const rejectPendingHostKey = useCallback(async (): Promise<void> => {
    const confirmation = pendingHostKey.current
    pendingHostKey.current = undefined
    if (confirmation !== undefined) {
      await lastBridge.current?.rejectHostKey(confirmation.confirmationId)
    }
  }, [])

  const closeActiveConnection = useCallback(async (): Promise<void> => {
    const ownedConnection = activeConnection.current
    activeConnection.current = undefined
    if (ownedConnection !== undefined) {
      await lastBridge.current?.close(ownedConnection.connectionId)
    }
  }, [])

  const cancelNativeConnect = useCallback(async (): Promise<void> => {
    const nativeAttempt = nativeConnectAttempt.current
    if (nativeAttempt === undefined) return
    nativeConnectAttempt.current = undefined
    await lastBridge.current?.cancelConnect(nativeAttempt.attemptId)
  }, [])

  const clearNativeConnectAttempt = (generation: number): void => {
    if (nativeConnectAttempt.current?.generation === generation) {
      nativeConnectAttempt.current = undefined
    }
  }

  const invalidateOperations = useCallback((): void => {
    attempt.current++
    directoryRequest.current++
    connectOperation.current = undefined
    selectionInFlight.current = false
  }, [])

  const releaseOwnedResources = useCallback(async (): Promise<void> => {
    const ownedConnection = activeConnection.current
    const selectionOwnsConnection = ownedConnection !== undefined
      && pendingSelections.current.has(ownedConnection.connectionId)
    if (selectionOwnsConnection) {
      pendingSelections.current.set(ownedConnection.connectionId, true)
      activeConnection.current = undefined
    }
    await Promise.all([
      cancelNativeConnect().catch(() => {}),
      rejectPendingHostKey().catch(() => {}),
      ...(selectionOwnsConnection ? [] : [closeActiveConnection().catch(() => {})]),
    ])
  }, [cancelNativeConnect, closeActiveConnection, rejectPendingHostKey])

  useEffect(() => {
    if (!open) {
      invalidateOperations()
      void releaseOwnedResources()
      setStep('config')
      setSecret('')
      setHostKey(undefined)
      setConnection(undefined)
      setDirectory(undefined)
      setError(undefined)
      setConnecting(false)
      setDirectoryLoading(false)
      setSelectingDirectory(false)
      return
    }
  }, [invalidateOperations, open, releaseOwnedResources])

  useEffect(() => {
    if (!open || bridge === undefined) return
    return bridge.subscribeProgress((next) => {
      if (nativeConnectAttempt.current?.attemptId !== next.attemptId) return
      setProgress({ phase: next.phase, message: next.message })
      if (next.phase === 'failed' && next.message !== '') setError(next.message)
    })
  }, [bridge, open])

  useEffect(() => () => {
    invalidateOperations()
    void releaseOwnedResources()
  }, [invalidateOperations, releaseOwnedResources])

  const dismiss = (): void => {
    if (selectionInFlight.current) return
    invalidateOperations()
    void releaseOwnedResources()
    onClose()
  }

  const connect = (confirmation?: HostKeyConfirmation): void => {
    if (bridge === undefined || connectOperation.current !== undefined || selectionInFlight.current) return
    let input: RemoteSshConnectInput
    const nativeAttemptId = remoteAttemptId()
    try {
      input = validateRemoteSshConfig({
        attemptId: nativeAttemptId,
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        auth: { kind: authKind, secret },
        confirmationId: confirmation?.confirmationId,
        acceptHostKeyFingerprint: confirmation?.fingerprint,
      })
    } catch (reason) {
      setError(remoteErrorText(t, reason))
      return
    }
    const currentAttempt = ++attempt.current
    connectOperation.current = currentAttempt
    setError(undefined)
    setHostKey(undefined)
    setConnection(undefined)
    setDirectory(undefined)
    setProgress({ phase: 'authenticating', message: t('picker.remote.progress.authenticating') })
    setConnecting(true)
    setStep('progress')
    void (async () => {
      if (confirmation === undefined) {
        await Promise.all([
          rejectPendingHostKey().catch(() => {}),
          closeActiveConnection().catch(() => {}),
        ])
      } else {
        const pending = pendingHostKey.current
        if (pending?.confirmationId !== confirmation.confirmationId) return
        pendingHostKey.current = undefined
      }
      if (currentAttempt !== attempt.current) {
        if (confirmation !== undefined) {
          await bridge.rejectHostKey(confirmation.confirmationId).catch(() => {})
        }
        return
      }
      nativeConnectAttempt.current = { generation: currentAttempt, attemptId: nativeAttemptId }
      const result = await bridge.connect(input)
      clearNativeConnectAttempt(currentAttempt)
      if (currentAttempt !== attempt.current) {
        if (confirmation !== undefined) await bridge.rejectHostKey(confirmation.confirmationId).catch(() => {})
        if (result.kind === 'ready') await bridge.close(result.connectionId).catch(() => {})
        if (result.kind === 'host-key-confirmation') await bridge.rejectHostKey(result.confirmationId).catch(() => {})
        return
      }
      switch (result.kind) {
        case 'ready': {
          const ready = { connectionId: result.connectionId, homePath: result.homePath }
          activeConnection.current = ready
          setConnection(ready)
          setSecret('')
          setProgress({ phase: 'ready', message: t('picker.remote.progress.ready') })
          break
        }
        case 'host-key-confirmation':
          pendingHostKey.current = result
          setHostKey(result)
          break
        case 'error':
          if (confirmation !== undefined) await bridge.rejectHostKey(confirmation.confirmationId).catch(() => {})
          setProgress({ phase: 'failed', message: result.message })
          setError(result.message)
          break
      }
    })().catch((reason: unknown) => {
      clearNativeConnectAttempt(currentAttempt)
      if (confirmation !== undefined) void bridge.rejectHostKey(confirmation.confirmationId).catch(() => {})
      if (currentAttempt === attempt.current) {
        setProgress({ phase: 'failed', message: t('picker.remote.progress.failed') })
        setError(remoteErrorText(t, reason))
      }
    }).finally(() => {
      if (connectOperation.current === currentAttempt) connectOperation.current = undefined
      if (currentAttempt === attempt.current) setConnecting(false)
    })
  }

  const loadDirectory = (path: string): void => {
    if (bridge === undefined || activeConnection.current === undefined) return
    const currentRequest = ++directoryRequest.current
    setDirectoryLoading(true)
    setError(undefined)
    void bridge.listDirectories(activeConnection.current.connectionId, path).then((listing) => {
      if (currentRequest === directoryRequest.current) setDirectory(listing)
    }).catch((reason: unknown) => {
      if (currentRequest === directoryRequest.current) setError(remoteErrorText(t, reason))
    }).finally(() => {
      if (currentRequest === directoryRequest.current) setDirectoryLoading(false)
    })
  }

  const openDirectoryStep = (): void => {
    if (connection === undefined) return
    setStep('directory')
    setDirectory(undefined)
    loadDirectory(connection.homePath ?? '/')
  }

  const selectCurrentDirectory = (): void => {
    const ownedConnection = activeConnection.current
    if (
      bridge === undefined
      || connection === undefined
      || ownedConnection === undefined
      || ownedConnection.connectionId !== connection.connectionId
      || directory === undefined
      || selectionInFlight.current
    ) return
    const currentAttempt = attempt.current
    selectionInFlight.current = true
    pendingSelections.current.set(ownedConnection.connectionId, false)
    setSelectingDirectory(true)
    setError(undefined)
    void (async () => {
      let markerPublished = false
      try {
        const selection = await bridge.selectDirectory(ownedConnection.connectionId, directory.path)
        markerPublished = true
        // 选择已提交 marker；连接此时由 marker 持有，不能被向导关闭路径释放。
        if (activeConnection.current?.connectionId === ownedConnection.connectionId) {
          activeConnection.current = undefined
        }
        const workspace = await createWorkspace({ path: selection.markerPath })
        if (currentAttempt !== attempt.current) return
        onPick(workspace.workspaceId)
        onClose()
      } catch (reason: unknown) {
        if (currentAttempt !== attempt.current) return
        if (markerPublished) {
          setConnection(undefined)
          setDirectory(undefined)
          setStep('config')
        }
        setError(remoteErrorText(t, reason))
      } finally {
        const releaseOnFailure = pendingSelections.current.get(ownedConnection.connectionId) === true
        pendingSelections.current.delete(ownedConnection.connectionId)
        if (!markerPublished && releaseOnFailure) {
          await lastBridge.current?.close(ownedConnection.connectionId).catch(() => {})
        }
        if (currentAttempt === attempt.current) {
          selectionInFlight.current = false
          setSelectingDirectory(false)
        }
      }
    })()
  }

  const goBack = (): void => {
    if (directoryLoading || selectingDirectory) return
    setError(undefined)
    if (step === 'directory') {
      directoryRequest.current++
      setDirectoryLoading(false)
      setStep('progress')
      return
    }
    invalidateOperations()
    void releaseOwnedResources()
    setHostKey(undefined)
    setConnection(undefined)
    setDirectory(undefined)
    setStep('config')
  }

  const rejectHostKey = (): void => {
    if (connecting) return
    invalidateOperations()
    void releaseOwnedResources()
    setHostKey(undefined)
    setConnection(undefined)
    setStep('config')
  }

  const currentStepIndex = remoteSteps.findIndex(item => item.id === step)
  const progressIndex = remoteProgressPhases.indexOf(progress.phase)
  const completedStep = (item: WizardStep): boolean => {
    if (item === 'config') return currentStepIndex > 0
    if (item === 'progress') return connection !== undefined && currentStepIndex > 1
    return false
  }

  const { title, description } = remoteStepCopy(t, step)

  return (
    <Modal open={open} onClose={dismiss} title={t('picker.remote.title')} closeLabel={t('close')} headless className={remoteCss.dialog ?? ''}>
      <div className={remoteCss.shell}>
        <nav className={remoteCss.steps} aria-label={t('picker.remote.steps.aria')}>
          <ol className={remoteCss.stepList}>
            {remoteSteps.map((item, index) => (
              <li
                key={item.id}
                className={clsx(
                  remoteCss.step,
                  index === currentStepIndex && remoteCss.stepActive,
                  completedStep(item.id) && remoteCss.stepDone,
                )}
                {...index === currentStepIndex ? { 'aria-current': 'step' as const } : {}}
              >
                <span className={remoteCss.stepNumber}>
                  {completedStep(item.id) ? <IconCheckOutline16 size={14} /> : index + 1}
                </span>
                <span className={remoteCss.stepText}>
                  <span className={remoteCss.stepTitle}>{t(item.label)}</span>
                  <span className={remoteCss.stepHint}>{t(item.hint)}</span>
                </span>
              </li>
            ))}
          </ol>
        </nav>
        <section className={remoteCss.content}>
          <button type="button" className={remoteCss.close} aria-label={t('close')} disabled={selectingDirectory} onClick={dismiss}><IconCloseOutline16 size={14} /></button>
          <header className={remoteCss.header}>
            <h2 className={remoteCss.title}>{title}</h2>
            <p className={remoteCss.description}>{description}</p>
          </header>
          <div className={remoteCss.body}>
            {step === 'config' && (
              bridge === undefined ? (
                <div className={remoteCss.notice} role="status">{t('picker.remote.desktopOnly')}</div>
              ) : (
                <form className={remoteCss.form} onSubmit={(event) => { event.preventDefault(); connect() }}>
                  <div className={remoteCss.field}>
                    <label className={remoteCss.label} htmlFor="remote-ssh-host">{t('picker.remote.field.host')}</label>
                    <Input id="remote-ssh-host" className={remoteCss.input ?? ''} autoFocus autoComplete="off" value={host} placeholder={t('picker.remote.placeholder.host')} onChange={(event) => { setHost(event.target.value) }} />
                  </div>
                  <div className={remoteCss.field}>
                    <label className={remoteCss.label} htmlFor="remote-ssh-port">{t('picker.remote.field.port')}</label>
                    <Input id="remote-ssh-port" className={remoteCss.input ?? ''} inputMode="numeric" value={port} onChange={(event) => { setPort(event.target.value) }} />
                  </div>
                  <div className={remoteCss.field}>
                    <label className={remoteCss.label} htmlFor="remote-ssh-user">{t('picker.remote.field.username')}</label>
                    <Input id="remote-ssh-user" className={remoteCss.input ?? ''} autoComplete="username" value={username} placeholder={t('picker.remote.placeholder.username')} onChange={(event) => { setUsername(event.target.value) }} />
                  </div>
                  <fieldset className={remoteCss.field}>
                    <legend className={remoteCss.label}>{t('picker.remote.field.authentication')}</legend>
                    <div className={remoteCss.authModes}>
                      <Button className={clsx(remoteCss.authMode, authKind === 'password' && remoteCss.authModeActive)} aria-pressed={authKind === 'password'} onClick={() => { setAuthKind('password'); setSecret('') }}>{t('picker.remote.auth.password')}</Button>
                      <Button className={clsx(remoteCss.authMode, authKind === 'privateKey' && remoteCss.authModeActive)} aria-pressed={authKind === 'privateKey'} onClick={() => { setAuthKind('privateKey'); setSecret('') }}>{t('picker.remote.auth.privateKey')}</Button>
                    </div>
                  </fieldset>
                  <div className={remoteCss.field}>
                    <label className={remoteCss.label} htmlFor="remote-ssh-secret">{authKind === 'password' ? t('picker.remote.field.password') : t('picker.remote.field.privateKey')}</label>
                    {authKind === 'password' ? (
                      <Input id="remote-ssh-secret" className={remoteCss.input ?? ''} type="password" autoComplete="current-password" value={secret} onChange={(event) => { setSecret(event.target.value) }} />
                    ) : (
                      <textarea id="remote-ssh-secret" className={remoteCss.privateKey} value={secret} spellCheck={false} onChange={(event) => { setSecret(event.target.value) }} />
                    )}
                  </div>
                  {error !== undefined && <div className={remoteCss.error} role="alert">{error}</div>}
                </form>
              )
            )}
            {step === 'progress' && (
              hostKey !== undefined ? (
                <div className={remoteCss.warning}>
                  <div>{t('picker.remote.hostKey.description')}</div>
                  <div className={remoteCss.fingerprint}>{hostKey.algorithm}: {hostKey.fingerprint}</div>
                </div>
              ) : (
                <div className={remoteCss.progressList} aria-live="polite">
                  {remoteProgressPhases.slice(0, 4).map((phase, index) => (
                    <div
                      key={phase}
                      className={clsx(
                        remoteCss.progressRow,
                        progressIndex > index && remoteCss.progressDone,
                        progressIndex === index && remoteCss.progressCurrent,
                      )}
                    >
                      <span className={remoteCss.progressDot} />
                      <span>{remoteProgressLabel(t, phase)}</span>
                    </div>
                  ))}
                  {progress.message !== '' && <div className={remoteCss.notice}>{progress.message}</div>}
                </div>
              )
            )}
            {step === 'directory' && (
              <>
                <div className={remoteCss.secretRow}>
                  <div className={remoteCss.directoryPath} title={directory?.path}>{directory?.path ?? t('picker.remote.directory.loading')}</div>
                  <Button size="sm" variant="outline" disabled={directory === undefined || directoryLoading} onClick={() => { if (directory !== undefined) loadDirectory(remoteParentPath(directory.path)) }}>{t('picker.remote.directory.up')}</Button>
                </div>
                <div className={remoteCss.directoryList} aria-busy={directoryLoading}>
                  {directory?.entries.filter(entry => entry.directory).map(entry => (
                    <button key={entry.path} type="button" className={remoteCss.directoryRow} onClick={() => { loadDirectory(entry.path) }}>
                      <IconFolderOpenOutline16 size={16} />
                      <span>{entry.name}</span>
                    </button>
                  ))}
                  {directory !== undefined && !directoryLoading && directory.entries.every(entry => !entry.directory) && (
                    <div className={remoteCss.directoryEmpty}>{t('picker.remote.directory.empty')}</div>
                  )}
                </div>
                {error !== undefined && <div className={remoteCss.error} role="alert">{error}</div>}
              </>
            )}
          </div>
          <footer className={remoteCss.footer}>
            {step !== 'config' && <Button variant="ghost" className={remoteCss.back} disabled={directoryLoading || selectingDirectory} onClick={goBack}>{t('picker.remote.back')}</Button>}
            <div className={remoteCss.footerActions}>
              {step === 'config' && <Button variant="outline" onClick={dismiss}>{t('cancel')}</Button>}
              {step === 'config' && <Button variant="primary" disabled={bridge === undefined || connecting} onClick={() => { connect() }}>{t('picker.remote.connect')}</Button>}
              {step === 'progress' && hostKey !== undefined && <><Button variant="outline" disabled={connecting} onClick={rejectHostKey}>{t('picker.remote.hostKey.reject')}</Button><Button variant="primary" disabled={connecting} onClick={() => { connect(hostKey) }}>{t('picker.remote.hostKey.accept')}</Button></>}
              {step === 'progress' && hostKey === undefined && connection !== undefined && <Button variant="primary" onClick={openDirectoryStep}>{t('picker.remote.progress.continue')}</Button>}
              {step === 'directory' && <Button variant="primary" disabled={directory === undefined || directoryLoading || selectingDirectory} onClick={selectCurrentDirectory}>{t('picker.remote.directory.select')}</Button>}
            </div>
          </footer>
        </section>
      </div>
    </Modal>
  )
}
