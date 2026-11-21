import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import {
  Button, IconCloseOutline16, IconEditOutline16,
  IconPlusOutline16, IconProjectAddOutline16, IconSearchOutline16, Input, Menu, Modal, SidebarRoot,
  Toast, IconTrashOutline16,
  type MenuEntry, type SidebarRootItem,
} from 'coding-client-ui-primitives'
import { Icon } from 'coding-client-ui-icons'
import type { PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from 'coding-client-ui-slots'
import { NS, type NotesLocaleKey } from './locales.ts'
import { NoteDeleteDialog } from './NoteDeleteDialog.tsx'
import { NoteNameDialog } from './NoteNameDialog.tsx'
import { NotesDocument } from './NotesDocument.tsx'
import { NotesTabs } from './NotesTabs.tsx'
import { addTreeDirectory, filePaths, findEntry, isDeckPath, labelOf, latestWritten, noteFiles, removeTreeEntry } from './notes-tree.ts'
import type { createNotesUiStore } from './notes-ui-store.ts'
import { useNoteDraft } from './useNoteDraft.ts'
import { usePublishNotesTabs } from './usePublishNotesTabs.ts'
import {
  notesCreate, notesCreateDirectory, notesCreateSlide, notesDelete, notesImportSlide, notesRename, notesTree,
  type NotesTreeEntry,
} from './wire.ts'
import { exportImage, exportMarkdown, exportPdf, exportWord, type NoteExportFormat } from './export/index.ts'
import css from './NotesPage.module.css'

export type NotesPageProps = PropsRuntime<'shell.page'> & PropsLocale<typeof NS>
  & PropsStore<ReturnType<typeof createNotesUiStore>>
  & PropsRenderSlots<'notes.document.ppt'>

/** AI 助手改动检测的目录轮询间隔。 */
const TREE_POLL_MS = 4000

/**
 * 「导入 → 文本」接受的扩展名：Markdown 与纯文本都存成 Markdown 笔记。
 * 新增导入类型时另开一类菜单项与文件选择器，不改动这里的判断。
 */
const TEXT_IMPORT_ACCEPT = '.md,.markdown,.txt'
const TEXT_IMPORT_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown', 'txt'])

/** 「导入 → 幻灯片」只接受 PPTX；工程目录由 PPT 宿主落盘。 */
const SLIDE_IMPORT_ACCEPT = '.pptx'
const SLIDE_IMPORT_EXTENSION = 'pptx'

/** 导入文本的字节上限；与文件库的单篇笔记上限一致。 */
const NOTE_IMPORT_MAX_BYTES = 1024 * 1024

/** 取小写扩展名（不含点）；没有扩展名时返回空字符串。 */
function extensionOf(name: string): string {
  return /\.([^.\\/]+)$/u.exec(name)?.[1]?.toLowerCase() ?? ''
}

/** 去掉最后一段扩展名，作为新条目的名称。 */
function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/u, '').trim()
}

/** 按 UTF-8 严格解码导入的文本；非法编码直接失败，不写半份乱码。 */
async function decodeText(file: File): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(await file.arrayBuffer()))
}
type DirectoryState = 'loading' | 'ready' | 'failed'
type NoteActionTarget = Pick<NotesTreeEntry, 'kind' | 'name' | 'path'>
type NoteContextMenu = { target: NoteActionTarget; x: number; y: number; trigger: HTMLButtonElement }
type DialogKind = 'create' | 'folder' | 'presentation' | 'reload' | 'rename' | 'delete'

/**
 * 独立笔记页：目录和编辑器由本页持有，助手显隐由同会话的根布局持有。
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
  const searchId = useId()
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const searchTrigger = useRef<HTMLButtonElement>(null)
  const createTrigger = useRef<HTMLButtonElement>(null)
  /** 导入文本与幻灯片各用一个本机文件选择器，接受扩展名互不影响。 */
  const textInput = useRef<HTMLInputElement>(null)
  const slidesInput = useRef<HTMLInputElement>(null)
  const dialogTrigger = useRef<HTMLButtonElement | null>(null)
  const creatingRequest = useRef<AbortController | null>(null)
  const treeRevision = useRef(0)
  /** 上一次目录轮询看到的笔记修改时间；用于识别助手写入并自动打开。 */
  const seenNotes = useRef(new Map<string, number>())
  /** 首次轮询只建立修改时间基线：没有记住的笔记时，进入页面不自动打开。 */
  const notesSynced = useRef(false)
  // 上次的浏览位置只在挂载时读取；之后由本页写回，不再反向驱动渲染。
  const rememberedPath = useStore(state => state.path)
  const storedTabs = useStore(state => state.tabs)
  const openTabs = storedTabs ?? (rememberedPath === null ? [] : [rememberedPath])
  const activePath = useStore(state => state.activePath ?? state.path)
  const pptPath = activePath !== null && isDeckPath(activePath) ? activePath : null
  const rememberedExpanded = useStore(state => state.expanded)
  const restored = useRef({ path: rememberedPath, activePath, expanded: rememberedExpanded })
  /** 待恢复的 Markdown 路径；第一次目录就绪时打开它，之后保持 null。 */
  const restorePending = useRef(restored.current.activePath !== null
    && isDeckPath(restored.current.activePath) ? null : restored.current.path)
  const [tree, setTree] = useState<NotesTreeEntry[]>([])
  const [treeState, setTreeState] = useState<DirectoryState>('loading')
  const [treeReady, setTreeReady] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(restored.current.expanded))
  const [creationDirectory, setCreationDirectory] = useState('')
  const [createFailed, setCreateFailed] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [actionTarget, setActionTarget] = useState<NoteActionTarget | null>(null)
  const [deleteFailed, setDeleteFailed] = useState(false)
  const [contextMenu, setContextMenu] = useState<NoteContextMenu | null>(null)
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

  // 当前正文路径写入会话级浏览位置：切走页面或关掉窗口后再回来仍打开同一篇。
  // 恢复尚未完成时保留记住的路径，避免挂载瞬间被清空。
  const draftPath = draft?.path
  useEffect(() => {
    if (draftPath === undefined && restorePending.current !== null) return
    if (draftPath !== undefined && draftPath !== rememberedPath) actions.rememberNote(draftPath)
  }, [actions, draftPath, rememberedPath])

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
        const written = notesSynced.current ? latestWritten(notes, seenNotes.current) : undefined
        seenNotes.current = new Map(notes.map(note => [note.path, note.mtimeMs]))
        notesSynced.current = true
        const path = getPath()
        const pending = restorePending.current
        restorePending.current = null
        if (status === 'loading') {
          actions.restoreTabs(filePaths(fresh))
        }
        setTreeReady(true)
        if (path !== undefined && !isDeckPath(path)) {
          await refresh(findEntry(fresh, path)?.mtimeMs, signal)
        } else if (creatingRequest.current === null && pending !== null) {
          // 切回页面时恢复上次打开的笔记；它已被删除则停在欢迎页。
          if (findEntry(fresh, pending)?.kind === 'file') {
            if (await select(pending)) actions.openNote(pending)
          } else {
            actions.rememberNote(null)
          }
        } else if (creatingRequest.current === null && written !== undefined && restored.current.activePath === null) {
          // 欢迎页只在助手刚写入 Markdown 后自动打开它；不盖掉已恢复的幻灯片标签。
          setExpanded(new Set(written.parents))
          if (await select(written.path)) actions.openNote(written.path)
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
  }, [actions, getPath, notify, refresh, select])

  const selectTab = useCallback(async (path: string) => {
    if (isDeckPath(path)) {
      if (await flush()) {
        actions.openPpt(path)
      }
    } else if (await select(path)) {
      actions.openNote(path)
    }
  }, [actions, flush, select])

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
    if (isDeckPath(path)) {
      if (next !== undefined && !isDeckPath(next)) {
        if (!await select(next)) return
      } else if (next === undefined) {
        if (!await clear()) return
      }
    } else if (next === undefined || isDeckPath(next)) {
      if (!await clear()) return
    } else if (!await select(next)) return
    if (next !== undefined && !isDeckPath(next)) actions.openNote(next)
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

  const openContextMenu = useCallback((target: NoteActionTarget, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setCreateMenuOpen(false)
    setContextMenu({ target, x: event.clientX, y: event.clientY, trigger: event.currentTarget })
  }, [])

  const openCreateDialog = useCallback((kind: 'create' | 'folder' | 'presentation', path: string, trigger: HTMLButtonElement | null) => {
    setCreateMenuOpen(false)
    setContextMenu(null)
    dialogTrigger.current = trigger
    setCreationDirectory(path)
    setDraftName('')
    setCreateFailed(false)
    setDialog(kind)
  }, [])

  const openTargetDialog = useCallback((kind: 'rename' | 'delete', target: NoteActionTarget, trigger: HTMLButtonElement) => {
    setContextMenu(null)
    setActionTarget(target)
    dialogTrigger.current = trigger
    if (kind === 'rename') setDraftName(target.kind === 'dir' ? target.name : labelOf(target.name))
    else setDeleteFailed(false)
    setDialog(kind)
  }, [])

  useEffect(() => {
    if (contextMenu === null) return
    const close = () => { setContextMenu(null) }
    window.addEventListener('resize', close)
    return () => { window.removeEventListener('resize', close) }
  }, [contextMenu])

  const locale = t('dateLocale')
  const needle = searchOpen && !sidebarCollapsed ? query.trim().toLocaleLowerCase(locale) : ''
  const treeItems = useMemo(() => {
    const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
    const flatten = (entries: readonly NotesTreeEntry[], out: SidebarRootItem[], depth: number): void => {
      for (const entry of entries) {
        const folder = entry.kind === 'dir'
        const deck = entry.kind === 'deck'
        if (folder && needle !== '') {
          if (entry.children !== undefined) flatten(entry.children, out, 0)
          continue
        }
        const label = folder ? entry.name : labelOf(entry.name)
        if (needle !== '' && !label.toLocaleLowerCase(locale).includes(needle)) continue
        const open = folder && expanded.has(entry.path)
        out.push({
          id: entry.path, label, icon: deck ? 'file-slides' : folder ? 'files' : 'notes', depth,
          ...(folder ? { folder, open } : { iconTone: 'blue', active: activePath === entry.path }),
          meta: date.format(entry.mtimeMs),
          actions: <>
            {folder && <>
              <Button size="sm" className={css.rowAction} icon={<IconPlusOutline16 size={14} />}
                aria-label={t('newNoteIn', { name: label })} title={t('newNote')} aria-haspopup="dialog"
                onClick={(event) => { openCreateDialog('create', entry.path, event.currentTarget) }} />
              <Button size="sm" className={css.rowAction} icon={<IconProjectAddOutline16 size={14} />}
                aria-label={t('newFolderIn', { name: label })} title={t('newFolder')} aria-haspopup="dialog"
                onClick={(event) => { openCreateDialog('folder', entry.path, event.currentTarget) }} />
            </>}
            <Button size="sm" className={css.rowAction} icon={<IconEditOutline16 size={14} />}
              aria-label={t('renameEntry', { name: label })} title={t('rename')} aria-haspopup="dialog"
              onClick={(event) => { openTargetDialog('rename', entry, event.currentTarget) }} />
            <Button size="sm" className={css.rowAction} data-danger icon={<IconTrashOutline16 size={14} />}
              aria-label={t('deleteEntry', { name: label })} title={t('delete')} aria-haspopup="dialog"
              onClick={(event) => { openTargetDialog('delete', entry, event.currentTarget) }} />
          </>,
          onSelect: () => {
            if (folder) toggleDir(entry.path)
            else void selectTab(entry.path)
          },
          onContextMenu: (event) => { openContextMenu(entry, event) },
        })
        if (open && entry.children !== undefined) flatten(entry.children, out, depth + 1)
      }
    }
    const items: SidebarRootItem[] = []
    flatten(tree, items, 0)
    return items
  }, [tree, expanded, activePath, locale, needle, selectTab, toggleDir, openContextMenu, openCreateDialog, openTargetDialog, t])

  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
    searchTrigger.current?.focus({ preventScroll: true })
  }

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
      const { path } = await notesRename(target.path, target.kind === 'file' ? `${name}${extension || '.md'}` : name)
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
      if (activeRemoved && remaining[0] !== undefined && !isDeckPath(remaining[0])) {
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
    try {
      const { path } = folder
        ? await notesCreateDirectory(name, creationDirectory)
        : presentation
          ? await notesCreateSlide(sessionId, name, creationDirectory)
          : await notesCreate(name, creationDirectory)
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
      notify(updated ? folder ? 'folderCreated' : presentation ? 'presentationCreated' : 'noteCreated' : 'createdRefreshError')
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

  /**
   * 「导入 → 文本」：Markdown 与 TXT 都以 UTF-8 解码后写成带原文的笔记。
   * 名称取所选文件名；不支持的扩展名只提示，不发请求。
   * @param file - 文件选择器给出的文件；取消选择时为 undefined。
   */
  const importText = (file: File | undefined) => {
    if (file === undefined) return
    if (!TEXT_IMPORT_EXTENSIONS.has(extensionOf(file.name))) {
      notify('importTextError')
      return
    }
    void runImport(async () => {
      if (file.size > NOTE_IMPORT_MAX_BYTES) throw new Error('note too large')
      const name = stripExtension(file.name) || t('newNote')
      return (await notesCreate(name, '', await decodeText(file))).path
    }, 'noteImported', 'importTextError')
  }

  /**
   * 「导入 → 幻灯片」：把 `.pptx` 解析成笔记目录里的幻灯片工程目录。
   * 名称取所选文件名；非 `.pptx` 只提示，不发请求。
   * @param file - 文件选择器给出的文件；取消选择时为 undefined。
   */
  const importSlides = (file: File | undefined) => {
    if (file === undefined) return
    if (extensionOf(file.name) !== SLIDE_IMPORT_EXTENSION) {
      notify('importSlideError')
      return
    }
    void runImport(async () => {
      const name = stripExtension(file.name) || t('newPresentation')
      return (await notesImportSlide(sessionId, name, '', file)).path
    }, 'presentationImported', 'importSlideError')
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

  const noteCreateEntries: readonly MenuEntry[] = [
    { id: 'create', label: t('newNote'), icon: <IconPlusOutline16 /> },
    { id: 'folder', label: t('newFolder'), icon: <IconProjectAddOutline16 /> },
  ]
  const launcherEntries: readonly MenuEntry[] = [
    ...noteCreateEntries,
    { type: 'separator', id: 'new-presentation-separator' },
    { id: 'presentation', label: t('newPresentation'), icon: <Icon name="file-slides" size={16} /> },
    {
      id: 'import',
      label: t('importFile'),
      icon: <Icon name="file" size={16} />,
      submenu: [
        { id: 'import-text', label: t('importText'), icon: <Icon name="notes" size={16} /> },
        { id: 'import-slides', label: t('importSlides'), icon: <Icon name="file-slides" size={16} /> },
      ],
    },
  ]

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
      <SidebarRoot
        label={t('space')} title={t('allNotes')}
        collapsed={sidebarCollapsed} width={sidebarWidth} variant="summary"
        headerAction={<div className={css.directoryActions}>
          {!sidebarCollapsed && (
            <Button ref={searchTrigger} size="sm" className={css.directoryButton} icon={<IconSearchOutline16 />}
              aria-label={t('search')} title={t('search')} aria-expanded={searchOpen}
              aria-controls={searchOpen ? searchId : undefined}
              onClick={() => { if (searchOpen) closeSearch(); else setSearchOpen(true) }} />
          )}
          <Menu
            open={createMenuOpen}
            anchor={<Button ref={createTrigger} size="sm" className={css.newNote} icon={<IconPlusOutline16 />}
              aria-label={t('newNote')} title={t('newNote')} aria-haspopup="menu" aria-expanded={createMenuOpen}
              disabled={creating} onClick={() => { setContextMenu(null); setCreateMenuOpen(open => !open) }} />}
            items={launcherEntries}
            onSelect={(id) => {
              if (id === 'import-text') textInput.current?.click()
              if (id === 'import-slides') slidesInput.current?.click()
              if (id === 'create' || id === 'folder' || id === 'presentation') openCreateDialog(id, '', createTrigger.current)
            }}
            onClose={() => { setCreateMenuOpen(false); createTrigger.current?.focus({ preventScroll: true }) }}
            portal keyboardNavigation
          />
          {contextMenu !== null && (
            <Menu
              open
              anchor={null}
              items={[
                ...(contextMenu.target.kind === 'dir' ? [...noteCreateEntries, { type: 'separator' as const, id: 'edit' }] : []),
                { id: 'rename', label: t('rename'), icon: <IconEditOutline16 size={16} /> },
                { id: 'delete', label: t('delete'), danger: true, icon: <IconTrashOutline16 size={16} /> },
              ]}
              onSelect={(id) => {
                const { target, trigger } = contextMenu
                if (id === 'create' || id === 'folder') openCreateDialog(id, target.path, trigger)
                if (id === 'rename' || id === 'delete') openTargetDialog(id, target, trigger)
              }}
              onClose={() => { setContextMenu(null); contextMenu.trigger.focus({ preventScroll: true }) }}
              portal
              keyboardNavigation
              getAnchorRect={() => new DOMRect(contextMenu.x, contextMenu.y, 1, 1)}
            />
          )}
        </div>}
        {...(needle !== '' ? { empty: t('noMatches') } : {})}
        toolbar={searchOpen && <div id={searchId} className={css.searchRow}>
          <Input className={css.searchField} value={query} autoFocus aria-label={t('search')} placeholder={t('search')}
            onChange={(event) => { setQuery(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeSearch() } }} />
          <Button size="sm" className={css.directoryButton} aria-label={t('clearSearch')} title={t('clearSearch')}
            icon={<IconCloseOutline16 />} onClick={closeSearch} />
        </div>}
        items={sidebarCollapsed ? [] : treeItems} />
      <div className={css.document}>
        <NotesTabs paths={openTabs} activePath={activePath} panelId={panelId}
          idPrefix={tabId} labelOfPath={labelOfPath} onSelect={(path) => { void selectTab(path) }}
          onClose={(path) => { void closeTab(path) }} t={t} />
        <NotesDocument title={selectedLabel} titleId={titleId} titleRef={titleRef} panelId={panelId}
          tabId={activePath === null ? undefined : `${tabId}-${openTabs.indexOf(activePath)}`}
          content={pptPath === null ? draft?.content : undefined} saveLabel={pptPath === null ? saveLabel : undefined}
          pptContent={pptPath === null ? undefined : renderSlot('notes.document.ppt', { shown: true, path: pptPath })}
          treeState={treeState}
          exporting={exporting} exportMenuOpen={exportMenuOpen} exportEntries={exportEntries}
          assistantOpen={assistantOpen} assistantPanelId={assistantPanelId}
          onToggleAssistant={toggleAssistant} onToggleExport={() => { setExportMenuOpen(open => !open) }}
          onCloseExport={() => { setExportMenuOpen(false) }} onExport={(id) => { runExport(id as NoteExportFormat) }}
          onReload={(trigger) => { dialogTrigger.current = trigger; setDialog('reload') }}
          onRetry={() => { void save() }} onChange={edit} onBlur={() => { void save() }} t={t} />
      </div>
      {(dialog === 'create' || dialog === 'folder' || dialog === 'presentation' || dialog === 'rename') && <NoteNameDialog t={t}
        kind={dialog === 'rename'
          ? actionTarget?.kind === 'dir' ? 'renameFolder' : actionTarget?.kind === 'deck' ? 'renamePresentation' : 'renameNote'
          : dialog}
        name={draftName} busy={creating} onClose={closeDialog} onNameChange={setDraftName}
        error={createFailed && dialog !== 'rename' ? t(dialog === 'folder' ? 'createFolderError' : dialog === 'presentation' ? 'createPresentationError' : 'createError') : undefined}
        destination={dialog === 'rename' ? undefined : {
          tree, path: creationDirectory, onChange: setCreationDirectory, onCreateDirectory: createDestinationDirectory,
        }}
        onSubmit={(event) => { void (dialog === 'rename' ? renameTarget(event) : createEntry(event)) }} />}
      {dialog === 'delete' && actionTarget !== null && <NoteDeleteDialog t={t}
        description={actionTarget.kind === 'dir'
          ? t('deleteFolderConfirm', { name: actionTarget.name })
          : actionTarget.kind === 'deck'
            ? t('deletePresentationConfirm', { name: labelOf(actionTarget.name) })
            : t('deleteConfirm', { name: labelOf(actionTarget.name) })}
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
      {/* 导入子菜单各带一个文件选择器，留在页面 DOM 里由对应菜单项唤起。 */}
      <input ref={textInput} type="file" accept={TEXT_IMPORT_ACCEPT} hidden aria-hidden="true" tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          importText(file)
        }} />
      <input ref={slidesInput} type="file" accept={SLIDE_IMPORT_ACCEPT} hidden aria-hidden="true" tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          importSlides(file)
        }} />
    </main>
  )
}
