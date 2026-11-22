import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Modal, Toast, type MenuEntry } from 'coding-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from 'coding-client-ui-slots'
import { NS, type NotesLocaleKey } from './locales.ts'
import { NoteDeleteDialog } from './NoteDeleteDialog.tsx'
import { NoteNameDialog } from './NoteNameDialog.tsx'
import { NotesDirectory, type NoteActionTarget, type NoteCreateKind } from './NotesDirectory.tsx'
import { NotesDocument } from './NotesDocument.tsx'
import { NotesTabs } from './NotesTabs.tsx'
import { noteImportPickers } from './notes-import.ts'
import { NOTE_MINDMAP_SUFFIX, addTreeDirectory, filePaths, findEntry, labelOf, latestWritten, noteFiles, noteKindOf, removeTreeEntry } from './notes-tree.ts'
import type { createNotesUiStore } from './notes-ui-store.ts'
import { useNoteDraft } from './useNoteDraft.ts'
import { usePublishNotesTabs } from './usePublishNotesTabs.ts'
import {
  notesCreate, notesCreateDirectory, notesCreateMindmap, notesCreateSlide, notesDelete, notesRename, notesTree,
  type NotesTreeEntry,
} from './wire.ts'
import { exportImage, exportMarkdown, exportPdf, exportWord, type NoteExportFormat } from './export/index.ts'
import css from './NotesPage.module.css'

export type NotesPageProps = PropsRuntime<'shell.page'> & PropsLocale<typeof NS>
  & PropsStore<ReturnType<typeof createNotesUiStore>>
  & PropsRenderSlots<'notes.document.ppt' | 'notes.document.mindmap'>

/** AI 助手改动检测的目录轮询间隔。 */
const TREE_POLL_MS = 4000

type DirectoryState = 'loading' | 'ready' | 'failed'
type DialogKind = NoteCreateKind | 'reload' | 'rename' | 'delete'

const createErrors = {
  create: 'createError', folder: 'createFolderError', presentation: 'createPresentationError', mindmap: 'createMindmapError',
} as const
const renameTitles = { dir: 'renameFolder', deck: 'renamePresentation', file: 'renameNote', mindmap: 'renameMindmap' } as const
const deleteDescriptions = {
  dir: 'deleteFolderConfirm', deck: 'deletePresentationConfirm', file: 'deleteConfirm', mindmap: 'deleteMindmapConfirm',
} as const

/**
 * 独立笔记页：持有目录、标签和 Markdown 草稿；结构化文档和助手由各自插槽提供。
 * @param props - 根布局提供的实际侧栏和助手状态、动作、上次浏览位置，以及本地化文案。
 * @returns 笔记目录与正文编辑区。
 */
export function NotesPage({
  closePage, t, sidebarCollapsed, sidebarWidth, assistantOpen, assistantPanelId, toggleAssistant,
  sessionId, useStore, actions, renderSlot,
}: NotesPageProps) {
  const titleId = useId()
  const tabId = useId()
  const panelId = useId()
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const createTrigger = useRef<HTMLButtonElement>(null)
  const dialogTrigger = useRef<HTMLButtonElement | null>(null)
  const creatingRequest = useRef<AbortController | null>(null)
  const treeRevision = useRef(0)
  /** 上一次目录轮询看到的笔记修改时间；用于识别助手写入并自动打开。 */
  const seenNotes = useRef(new Map<string, number>())
  /** 首次轮询只建立修改时间基线：没有记住的笔记时，进入页面不自动打开。 */
  const notesSynced = useRef(false)
  // 兼容只记 Markdown 路径的旧记录；显式没有活动标签时不再回退到旧草稿。
  const rememberedPath = useStore(state => state.path)
  const storedTabs = useStore(state => state.tabs)
  const openTabs = storedTabs ?? (rememberedPath === null ? [] : [rememberedPath])
  const activePath = useStore(state => state.activePath === undefined ? state.path : state.activePath)
  const kind = activePath === null ? 'note' : noteKindOf(activePath)
  const tabs = useRef({ openTabs, activePath })
  tabs.current = { openTabs, activePath }
  const rememberedExpanded = useStore(state => state.expanded)
  const [tree, setTree] = useState<NotesTreeEntry[]>([])
  const [treeState, setTreeState] = useState<DirectoryState>('loading')
  const [treeReady, setTreeReady] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(rememberedExpanded))
  const [creationDirectory, setCreationDirectory] = useState('')
  const [createFailed, setCreateFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [actionTarget, setActionTarget] = useState<NoteActionTarget | null>(null)
  const [deleteFailed, setDeleteFailed] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [creating, setCreating] = useState(false)
  const [toast, setToast] = useState<{ id: number; key: NotesLocaleKey } | null>(null)
  const toastId = useRef(0)

  const notify = useCallback((key: NotesLocaleKey) => {
    toastId.current += 1
    setToast({ id: toastId.current, key })
  }, [])

  const { draft, saveLabel, select, clear, edit, save, reload, refresh, getPath, flush, renamePath, removePath } = useNoteDraft(notify)
  usePublishNotesTabs(sessionId, openTabs, activePath ?? null, treeReady)

  const selectTab = useCallback(async (path: string) => {
    if (noteKindOf(path) === 'note') {
      if (await select(path)) actions.openNote(path)
    } else if (await clear()) {
      actions.openStructured(path)
    }
  }, [actions, clear, select])

  useEffect(() => { actions.rememberExpanded([...expanded]) }, [actions, expanded])

  // 离开页面时把未写入的改动交给自动保存链，切页后重新读取的是最新内容。
  useEffect(() => () => { void save() }, [save])

  useEffect(() => {
    /* v8 ignore next -- jsdom 中 activeElement 恒为元素；null 臂只防御焦点位于其他文档或窗口的浏览器。 */
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    titleRef.current?.focus({ preventScroll: true })
    return () => { previousFocus?.focus({ preventScroll: true }) }
  }, [])

  useEffect(() => {
    const lifetime = new AbortController()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      if ((event.key === 's' || event.key === 'S') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void save()
      } else if (event.key === 'Escape') {
        void flush(lifetime.signal).then((ok) => { if (ok && !lifetime.signal.aborted) closePage() })
      }
    }
    const onBlur = () => { void save() }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    return () => {
      lifetime.abort()
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [closePage, flush, save])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    let timer: number | undefined
    let status: DirectoryState = 'loading'
    const poll = async () => {
      const revision = treeRevision.current
      try {
        const fresh = await notesTree(signal)
        signal.throwIfAborted()
        // 本地增删完成后，丢弃仍在途的旧目录快照。
        if (revision !== treeRevision.current) return
        setTree(fresh)
        const notes = noteFiles(fresh)
        const initial = !notesSynced.current
        const written = initial ? undefined : latestWritten(notes, seenNotes.current)
        seenNotes.current = new Map(notes.map(note => [note.path, note.mtimeMs]))
        notesSynced.current = true
        const { activePath: active, openTabs: opened } = tabs.current
        const paths = initial ? filePaths(fresh) : undefined
        if (paths !== undefined) actions.restoreTabs(paths)
        setTreeReady(true)
        const path = getPath()
        if (path !== undefined) {
          await refresh(findEntry(fresh, path)?.mtimeMs, signal)
        } else if (paths !== undefined && creatingRequest.current === null && active !== null) {
          // 结构化文档由活动标签直接恢复；只有 Markdown 需要先读正文。
          const pending = paths.includes(active) ? active : opened.find(item => paths.includes(item))
          if (pending !== undefined && noteKindOf(pending) === 'note') await selectTab(pending)
        } else if (creatingRequest.current === null && written !== undefined && active === null) {
          // 只在欢迎页自动打开助手新写入的文件，不打断用户正在看的文档。
          setExpanded(new Set(written.parents))
          await selectTab(written.path)
        }
        status = 'ready'
        if (!signal.aborted) setTreeState('ready')
      } catch {
        if (status === 'loading' && !signal.aborted) {
          status = 'failed'
          setTreeState('failed')
          notify('treeError')
        }
      } finally {
        if (!signal.aborted) timer = window.setTimeout(() => { void poll() }, TREE_POLL_MS)
      }
    }
    void poll()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
      creatingRequest.current?.abort()
    }
  }, [actions, getPath, notify, refresh, selectTab])

  const closeTab = useCallback(async (path: string) => {
    if (activePath !== path) {
      // 关闭尚在读取的标签也必须撤销它的加载，避免迟到响应把已关闭的标签重新打开。
      if (getPath() === path) {
        if (!await clear()) return
      } else removePath(path)
      actions.closeTab(path)
      return
    }
    const index = openTabs.indexOf(path)
    const next = openTabs[index + 1] ?? openTabs[index - 1]
    if (next === undefined || noteKindOf(next) !== 'note') {
      if (!await clear()) return
    } else {
      if (!await select(next)) return
      actions.openNote(next)
    }
    actions.closeTab(path)
    if (next === undefined) titleRef.current?.focus({ preventScroll: true })
  }, [actions, activePath, clear, getPath, openTabs, removePath, select])

  const labelOfPath = (path: string) => labelOf(findEntry(tree, path)?.name ?? path.replace(/^.*\//u, ''))

  const toggleDir = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const refreshTree = useCallback(async () => {
    const fresh = await notesTree(new AbortController().signal)
    setTree(fresh)
    return fresh
  }, [])

  const openCreateDialog = useCallback((kind: NoteCreateKind, path: string, trigger: HTMLButtonElement | null) => {
    dialogTrigger.current = trigger
    setCreationDirectory(path)
    setDraftName('')
    setCreateFailed(false)
    setDialog(kind)
  }, [])

  const openTargetDialog = useCallback((kind: 'rename' | 'delete', target: NoteActionTarget, trigger: HTMLButtonElement) => {
    setActionTarget(target)
    dialogTrigger.current = trigger
    if (kind === 'rename') setDraftName(target.kind === 'dir' ? target.name : labelOf(target.name))
    else setDeleteFailed(false)
    setDialog(kind)
  }, [])

  useEffect(() => {
    const trigger = dialogTrigger.current
    if (dialog !== null || trigger === null) return
    const next = trigger.isConnected ? trigger : createTrigger.current
    next?.focus({ preventScroll: true })
    dialogTrigger.current = null
  }, [dialog])

  const closeDialog = () => {
    if (creatingRequest.current !== null) return
    setDialog(null)
  }

  const remapPath = (from: string, to: string, path: string): string | undefined => {
    if (path === from) return to
    if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`
    return undefined
  }

  const renameTarget = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const target = actionTarget
    const name = draftName.trim()
    if (target === null || name === '' || creatingRequest.current !== null) return
    const request = new AbortController()
    creatingRequest.current = request
    setCreating(true)
    try {
      const extension = target.kind === 'file' && /\.(md|markdown)$/iu.test(target.name)
        ? target.name.slice(target.name.lastIndexOf('.')) : ''
      const finalName = target.kind === 'file' ? `${name}${extension || '.md'}`
        : target.kind === 'mindmap' && !name.toLowerCase().endsWith(NOTE_MINDMAP_SUFFIX) ? `${name}${NOTE_MINDMAP_SUFFIX}` : name
      const { path } = await notesRename(target.path, finalName)
      treeRevision.current += 1
      const fresh = await refreshTree()
      request.signal.throwIfAborted()
      if (findEntry(fresh, path) === undefined) throw new Error('笔记目录刷新失败')
      renamePath(target.path, path)
      actions.moveTabs(target.path, path)
      if (target.kind === 'dir') setExpanded((previous) => {
        const next = new Set<string>()
        for (const item of previous) next.add(remapPath(target.path, path, item) ?? item)
        return next
      })
      setDialog(null)
      setActionTarget(null)
    } catch {
      if (!request.signal.aborted) notify('renameError')
    } finally {
      creatingRequest.current = null
      if (!request.signal.aborted) setCreating(false)
    }
  }

  const deleteTarget = async () => {
    const target = actionTarget
    if (target === null || creatingRequest.current !== null) return
    const request = new AbortController()
    creatingRequest.current = request
    setCreating(true)
    setDeleteFailed(false)
    try {
      await notesDelete(target.path)
      request.signal.throwIfAborted()
      const deleted = (path: string) => path === target.path || path.startsWith(`${target.path}/`)
      treeRevision.current += 1
      setTree(previous => removeTreeEntry(previous, target.path))
      for (const path of seenNotes.current.keys()) if (deleted(path)) seenNotes.current.delete(path)
      const activeRemoved = activePath !== null && deleted(activePath)
      const remaining = openTabs.filter(path => !deleted(path))
      removePath(target.path)
      actions.removeTabs(target.path)
      if (activeRemoved && remaining[0] !== undefined && noteKindOf(remaining[0]) === 'note') {
        if (await select(remaining[0])) actions.openNote(remaining[0])
      }
      setExpanded(previous => new Set([...previous].filter(path => !deleted(path))))
      setDialog(null)
      setActionTarget(null)
      notify('deleted')
    } catch {
      if (!request.signal.aborted) setDeleteFailed(true)
    } finally {
      creatingRequest.current = null
      if (!request.signal.aborted) setCreating(false)
    }
  }

  const createEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = draftName.trim()
    if (name === '' || creatingRequest.current !== null) return
    const request = new AbortController()
    creatingRequest.current = request
    setCreating(true)
    setCreateFailed(false)
    const folder = dialog === 'folder'
    const presentation = dialog === 'presentation'
    const mindmap = dialog === 'mindmap'
    try {
      const { path } = folder
        ? await notesCreateDirectory(name, creationDirectory)
        : presentation
          ? await notesCreateSlide(sessionId, name, creationDirectory)
          : mindmap ? await notesCreateMindmap(name, creationDirectory) : await notesCreate(name, creationDirectory)
      request.signal.throwIfAborted()
      treeRevision.current += 1
      setExpanded((previous) => {
        const next = new Set(previous)
        for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) next.add(path.slice(0, slash))
        if (folder) next.add(path)
        return next
      })
      setQuery('')
      const fresh = notesTree(request.signal).then((entries) => {
        if (!request.signal.aborted) setTree(entries)
        return true
      }, () => false)
      const [updated] = await Promise.all([fresh, folder ? undefined : selectTab(path)])
      request.signal.throwIfAborted()
      setDialog(null)
      notify(updated ? folder ? 'folderCreated' : presentation ? 'presentationCreated'
        : mindmap ? 'mindmapCreated' : 'noteCreated' : 'createdRefreshError')
    } catch {
      if (!request.signal.aborted) setCreateFailed(true)
    } finally {
      creatingRequest.current = null
      if (!request.signal.aborted) setCreating(false)
    }
  }

  /**
   * 执行一次导入：取回新条目路径后刷新目录并打开它。
   * 失败只提示一类文案；创建期间的并发请求被忽略，避免同一次点击落两份。
   * @param task - 返回新条目相对路径的导入动作。
   * @param done - 成功后的提示文案键。
   * @param failed - 失败时的提示文案键。
   */
  const runImport = async (task: () => Promise<string>, done: NotesLocaleKey, failed: NotesLocaleKey) => {
    if (creatingRequest.current !== null) return
    const request = new AbortController()
    creatingRequest.current = request
    setCreating(true)
    try {
      const path = await task()
      request.signal.throwIfAborted()
      treeRevision.current += 1
      const fresh = notesTree(request.signal).then((entries) => {
        if (!request.signal.aborted) setTree(entries)
        return true
      }, () => false)
      const [updated] = await Promise.all([fresh, selectTab(path)])
      request.signal.throwIfAborted()
      notify(updated ? done : 'createdRefreshError')
    } catch {
      if (!request.signal.aborted) notify(failed)
    } finally {
      creatingRequest.current = null
      if (!request.signal.aborted) setCreating(false)
    }
  }

  const createDestinationDirectory = async (name: string, parent: string): Promise<string | undefined> => {
    if (creatingRequest.current !== null) return undefined
    const request = new AbortController()
    creatingRequest.current = request
    setCreating(true)
    try {
      const { path } = await notesCreateDirectory(name, parent)
      request.signal.throwIfAborted()
      treeRevision.current += 1
      setCreationDirectory(path)
      setExpanded((previous) => {
        const next = new Set(previous)
        for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) next.add(path.slice(0, slash))
        next.add(path)
        return next
      })
      try {
        const fresh = await notesTree(request.signal)
        request.signal.throwIfAborted()
        setTree(fresh)
      } catch {
        request.signal.throwIfAborted()
        setTree(previous => addTreeDirectory(previous, path, Date.now()))
        notify('createdRefreshError')
      }
      return path
    } catch (error) {
      if (!request.signal.aborted) throw error
      return undefined
    } finally {
      creatingRequest.current = null
      if (!request.signal.aborted) setCreating(false)
    }
  }

  const selectedLabel = activePath === null ? t('title') : labelOfPath(activePath)

  const exportEntries: readonly MenuEntry[] = [
    { id: 'markdown', label: t('exportMarkdown') },
    { id: 'word', label: t('exportWord') },
    { id: 'pdf', label: t('exportPdf') },
    { id: 'image', label: t('exportImage') },
  ]

  /** 导出当前草稿；Word、PDF 与图片要等生成完成，失败时提示且不改动正文。 */
  const runExport = (format: NoteExportFormat) => {
    const current = draft
    if (current === null) return
    setExportMenuOpen(false)
    if (format === 'markdown') {
      try {
        exportMarkdown(selectedLabel, current.content)
      } catch {
        notify('exportError')
      }
      return
    }
    const task = format === 'word'
      ? exportWord(selectedLabel, current.content)
      : format === 'pdf'
        ? exportPdf(selectedLabel, current.content)
        : exportImage(selectedLabel, current.content)
    setExporting(true)
    void task.catch(() => { notify('exportError') }).finally(() => { setExporting(false) })
  }

  return (
    <main className={css.page} aria-labelledby={titleId}>
      <NotesDirectory t={t} tree={tree} expanded={expanded} activePath={activePath}
        collapsed={sidebarCollapsed} width={sidebarWidth} creating={creating} launcherRef={createTrigger}
        query={query} onQueryChange={setQuery} onToggleDir={toggleDir} onSelectPath={selectTab}
        onCreate={openCreateDialog} onEdit={openTargetDialog}
        {...noteImportPickers(sessionId, t, runImport, notify)} />
      <div className={css.document}>
        <NotesTabs paths={openTabs} activePath={activePath} panelId={panelId}
          idPrefix={tabId} labelOfPath={labelOfPath} onSelect={(path) => { void selectTab(path) }}
          onClose={(path) => { void closeTab(path) }} t={t} />
        <NotesDocument title={selectedLabel} titleId={titleId} titleRef={titleRef} panelId={panelId}
          tabId={activePath === null ? undefined : `${tabId}-${openTabs.indexOf(activePath)}`}
          kind={kind}
          content={draft?.path === activePath ? draft.content : undefined}
          saveLabel={draft?.path === activePath ? saveLabel : undefined}
          structuredContent={activePath === null || kind === 'note' || !treeReady
            ? undefined : renderSlot(kind === 'ppt' ? 'notes.document.ppt' : 'notes.document.mindmap', { shown: true, path: activePath })}
          treeState={treeState}
          exporting={exporting} exportMenuOpen={exportMenuOpen} exportEntries={exportEntries}
          assistantOpen={assistantOpen} assistantPanelId={assistantPanelId}
          onToggleAssistant={toggleAssistant} onToggleExport={() => { setExportMenuOpen(open => !open) }}
          onCloseExport={() => { setExportMenuOpen(false) }} onExport={(id) => { runExport(id as NoteExportFormat) }}
          onReload={(trigger) => { dialogTrigger.current = trigger; setDialog('reload') }}
          onRetry={() => { void save() }} onChange={edit} onBlur={() => { void save() }} t={t} />
      </div>
      {dialog !== null && dialog !== 'reload' && dialog !== 'delete' && <NoteNameDialog t={t}
        kind={dialog === 'rename' ? renameTitles[actionTarget?.kind ?? 'file'] : dialog}
        name={draftName} busy={creating} onClose={closeDialog} onNameChange={setDraftName}
        error={createFailed && dialog !== 'rename' ? t(createErrors[dialog]) : undefined}
        destination={dialog === 'rename' ? undefined : {
          tree, path: creationDirectory, onChange: setCreationDirectory, onCreateDirectory: createDestinationDirectory,
        }}
        onSubmit={(event) => { void (dialog === 'rename' ? renameTarget(event) : createEntry(event)) }} />}
      {dialog === 'delete' && actionTarget !== null && <NoteDeleteDialog t={t}
        description={t(deleteDescriptions[actionTarget.kind], {
          name: actionTarget.kind === 'dir' ? actionTarget.name : labelOf(actionTarget.name),
        })}
        deleting={creating} failed={deleteFailed} onClose={closeDialog} onConfirm={() => { void deleteTarget() }} />}
      <Modal open={dialog === 'reload'} onClose={closeDialog} title={t('reload')} closeLabel={t('close')}
        description={t('reloadConfirm')} trapFocus footer={<>
          <Button variant="outline" autoFocus onClick={closeDialog}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => {
            dialogTrigger.current = null
            closeDialog()
            titleRef.current?.focus({ preventScroll: true })
            void reload()
          }}>{t('discardDraft')}</Button>
        </>}>
      </Modal>
      {toast !== null && <Toast key={toast.id} text={t(toast.key)} onDone={() => { setToast(null) }} />}
    </main>
  )
}
