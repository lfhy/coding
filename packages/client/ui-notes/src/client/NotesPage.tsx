import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import {
  Button, Icon, IconCheckOutline14, IconCloseOutline16, IconDownloadOutline16, IconEditOutline16,
  IconPlusOutline16, IconProjectAddOutline16, IconSearchOutline16, IconSparkle16, Input, Menu, Modal, SidebarRoot,
  Toast, IconTrashOutline16,
  type MenuEntry, type SidebarRootItem,
} from 'coding-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from 'coding-client-ui-slots'
import { NS, type NotesLocaleKey } from './locales.ts'
import { NoteDeleteDialog } from './NoteDeleteDialog.tsx'
import { NoteNameDialog } from './NoteNameDialog.tsx'
import { NotesEditor } from './NotesEditor.tsx'
import { NotesWelcome } from './NotesWelcome.tsx'
import type { createNotesUiStore } from './notes-ui-store.ts'
import { useNoteDraft } from './useNoteDraft.ts'
import { notesCreate, notesCreateDirectory, notesDelete, notesRename, notesTree, type NotesTreeEntry } from './wire.ts'
import { exportImage, exportMarkdown, exportPdf, exportWord, type NoteExportFormat } from './export/index.ts'
import css from './NotesPage.module.css'

export type NotesPageProps = PropsRuntime<'shell.page'> & PropsLocale<typeof NS>
  & PropsStore<ReturnType<typeof createNotesUiStore>>

/** AI 助手改动检测的目录轮询间隔。 */
const TREE_POLL_MS = 4000
type DirectoryState = 'loading' | 'ready' | 'failed'
type NoteActionTarget = Pick<NotesTreeEntry, 'kind' | 'name' | 'path'>
type NoteContextMenu = { target: NoteActionTarget; x: number; y: number; trigger: HTMLButtonElement }
type DialogKind = 'create' | 'folder' | 'reload' | 'rename' | 'delete'

/** 去掉 Markdown 扩展名的文件名，供目录树显示。 */
function labelOf(name: string): string {
  return name.replace(/\.(md|markdown)$/iu, '')
}

/** 在树中查找指定相对路径的条目。 */
function findEntry(entries: readonly NotesTreeEntry[], path: string): NotesTreeEntry | undefined {
  for (const entry of entries) {
    if (entry.path === path) return entry
    if (entry.kind === 'dir' && entry.children !== undefined) {
      const found = findEntry(entry.children, path)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function removeTreeEntry(entries: readonly NotesTreeEntry[], path: string): NotesTreeEntry[] {
  return entries.filter(entry => entry.path !== path).map(entry =>
    entry.children !== undefined && path.startsWith(`${entry.path}/`)
      ? { ...entry, children: removeTreeEntry(entry.children, path) } : entry)
}

/** 目录树中的一篇笔记；`parents` 是展开该行所需的各级目录。 */
interface NoteFile {
  path: string
  mtimeMs: number
  parents: readonly string[]
}

/** 按目录树显示顺序扁平化所有笔记文件。 */
function noteFiles(entries: readonly NotesTreeEntry[], parents: readonly string[] = []): NoteFile[] {
  const notes: NoteFile[] = []
  for (const entry of entries) {
    if (entry.kind === 'file') {
      notes.push({ path: entry.path, mtimeMs: entry.mtimeMs, parents })
    } else if (entry.children !== undefined) {
      notes.push(...noteFiles(entry.children, [...parents, entry.path]))
    }
  }
  return notes
}

/**
 * 找出本次轮询新增或修改过的一篇笔记。
 * @param notes - 本次目录树中的全部笔记。
 * @param seen - 上一次轮询记录的修改时间。
 * @returns 修改时间最新的变化项；没有变化时返回 undefined。
 */
function latestWritten(notes: readonly NoteFile[], seen: ReadonlyMap<string, number>): NoteFile | undefined {
  let latest: NoteFile | undefined
  for (const note of notes) {
    if (seen.get(note.path) === note.mtimeMs) continue
    if (latest === undefined || note.mtimeMs > latest.mtimeMs) latest = note
  }
  return latest
}

/**
 * 独立笔记页：目录和编辑器由本页持有，助手显隐由同会话的根布局持有。
 * @param props - 根布局提供的实际侧栏和助手状态、动作、上次浏览位置，以及本地化文案。
 * @returns 笔记目录与正文编辑区。
 */
export function NotesPage({
  closePage, t, sidebarCollapsed, sidebarWidth, assistantOpen, assistantPanelId, toggleAssistant,
  useStore, actions,
}: NotesPageProps) {
  const titleId = useId()
  const searchId = useId()
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const searchTrigger = useRef<HTMLButtonElement>(null)
  const createTrigger = useRef<HTMLButtonElement>(null)
  const dialogTrigger = useRef<HTMLButtonElement | null>(null)
  const creatingRequest = useRef<AbortController | null>(null)
  const treeRevision = useRef(0)
  /** 上一次目录轮询看到的笔记修改时间；用于识别助手写入并自动打开。 */
  const seenNotes = useRef(new Map<string, number>())
  /** 首次轮询只建立修改时间基线：没有记住的笔记时，进入页面不自动打开。 */
  const notesSynced = useRef(false)
  // 上次的浏览位置只在挂载时读取；之后由本页写回，不再反向驱动渲染。
  const rememberedPath = useStore(state => state.path)
  const rememberedExpanded = useStore(state => state.expanded)
  const restored = useRef({ path: rememberedPath, expanded: rememberedExpanded })
  /** 待恢复的笔记路径；第一次目录就绪时打开它，之后保持 null。 */
  const restorePending = useRef(restored.current.path)
  const [tree, setTree] = useState<NotesTreeEntry[]>([])
  const [treeState, setTreeState] = useState<DirectoryState>('loading')
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

  const { draft, saveLabel, select, edit, save, reload, refresh, getPath, flush, renamePath, removePath } = useNoteDraft(notify)

  // 当前正文路径写入会话级浏览位置：切走页面或关掉窗口后再回来仍打开同一篇。
  // 恢复尚未完成时保留记住的路径，避免挂载瞬间被清空。
  const draftPath = draft?.path
  useEffect(() => {
    if (draftPath === undefined && restorePending.current !== null) return
    actions.rememberNote(draftPath ?? null)
  }, [actions, draftPath])

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
        if (path !== undefined) {
          await refresh(findEntry(fresh, path)?.mtimeMs, signal)
        } else if (creatingRequest.current === null && pending !== null) {
          // 切回页面时恢复上次打开的笔记；它已被删除则停在欢迎页。
          if (findEntry(fresh, pending)?.kind === 'file') {
            await select(pending)
          } else {
            actions.rememberNote(null)
          }
        } else if (creatingRequest.current === null && written !== undefined) {
          // 进入页面时保持欢迎页；只在助手刚写入后自动打开那一篇，显示更新后的内容。
          setExpanded(new Set(written.parents))
          await select(written.path)
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

  const openCreateDialog = useCallback((kind: 'create' | 'folder', path: string, trigger: HTMLButtonElement | null) => {
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
    if (kind === 'rename') setDraftName(target.kind === 'file' ? labelOf(target.name) : target.name)
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
        if (folder && needle !== '') {
          if (entry.children !== undefined) flatten(entry.children, out, 0)
          continue
        }
        const label = folder ? entry.name : labelOf(entry.name)
        if (needle !== '' && !label.toLocaleLowerCase(locale).includes(needle)) continue
        const open = folder && expanded.has(entry.path)
        out.push({
          id: entry.path, label, icon: folder ? 'files' : 'notes', depth,
          ...(folder ? { folder, open } : { iconTone: 'blue', active: draft?.path === entry.path }),
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
            else void select(entry.path)
          },
          onContextMenu: (event) => { openContextMenu(entry, event) },
        })
        if (open && entry.children !== undefined) flatten(entry.children, out, depth + 1)
      }
    }
    const items: SidebarRootItem[] = []
    flatten(tree, items, 0)
    return items
  }, [tree, expanded, draft?.path, locale, needle, select, toggleDir, openContextMenu, openCreateDialog, openTargetDialog, t])

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
      renamePath(target.path, path)
      if (target.kind === 'dir') setExpanded((previous) => {
        const next = new Set<string>()
        for (const item of previous) next.add(remapPath(target.path, path, item) ?? item)
        return next
      })
      if (findEntry(fresh, path) === undefined) throw new Error('笔记目录刷新失败')
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
      removePath(target.path)
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
    try {
      const { path } = folder
        ? await notesCreateDirectory(name, creationDirectory)
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
      const [updated] = await Promise.all([fresh, folder ? undefined : select(path)])
      request.signal.throwIfAborted()
      setDialog(null)
      notify(updated ? folder ? 'folderCreated' : 'noteCreated' : 'createdRefreshError')
    } catch {
      if (!request.signal.aborted) setCreateFailed(true)
    } finally {
      creatingRequest.current = null
      if (!request.signal.aborted) setCreating(false)
    }
  }

  const createEntries: readonly MenuEntry[] = [
    { id: 'create', label: t('newNote'), icon: <IconPlusOutline16 /> },
    { id: 'folder', label: t('newFolder'), icon: <IconProjectAddOutline16 /> },
  ]

  const selectedLabel = draft === null ? t('title') : labelOf(findEntry(tree, draft.path)?.name ?? draft.path.replace(/^.*\//u, ''))

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
            items={createEntries}
            onSelect={(id) => {
              if (id === 'create' || id === 'folder') openCreateDialog(id, '', createTrigger.current)
            }}
            onClose={() => { setCreateMenuOpen(false); createTrigger.current?.focus({ preventScroll: true }) }}
            portal keyboardNavigation
          />
          {contextMenu !== null && (
            <Menu
              open
              anchor={null}
              items={[
                ...(contextMenu.target.kind === 'dir' ? [...createEntries, { type: 'separator' as const, id: 'edit' }] : []),
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
        items={treeItems} />
      <div className={css.document}>
        <header className={css.documentHeader}>
          <div className={css.heading}>
            <span className={css.documentIcon} aria-hidden="true"><Icon name="notes" size={18} /></span>
            <h1 ref={titleRef} id={titleId} className={css.title} title={selectedLabel} tabIndex={-1}>{selectedLabel}</h1>
            {saveLabel !== undefined && (
              <span className={css.saveState} data-state={saveLabel} role="status">
                {saveLabel === 'saved' && <IconCheckOutline14 />}{t(saveLabel)}
              </span>
            )}
          </div>
          <div className={css.documentActions}>
            <Menu
              open={exportMenuOpen}
              anchor={<Button size="sm" className={css.exportButton} icon={<IconDownloadOutline16 />}
                aria-label={t('export')} title={t('export')} aria-haspopup="menu"
                disabled={draft === null || exporting}
                onClick={() => { setExportMenuOpen(open => !open) }} />}
              items={exportEntries}
              onSelect={(id) => { runExport(id as NoteExportFormat) }}
              onClose={() => { setExportMenuOpen(false) }}
              side="bottom"
              portal
            />
            <Button size="sm" className={css.assistant} icon={<IconSparkle16 />}
              aria-label={t('assistant')} title={t('assistant')} aria-expanded={assistantOpen}
              aria-controls={assistantPanelId} onClick={toggleAssistant}>
              <span className={css.assistantLabel}>{t('assistant')}</span>
            </Button>
          </div>
        </header>
        {(saveLabel === 'conflict' || saveLabel === 'saveError') && (
          <div className={css.recovery}>
            <p>{t('draftKept')}</p>
            {saveLabel === 'conflict'
              ? <Button size="sm" variant="outline" aria-haspopup="dialog"
                onClick={(event) => { dialogTrigger.current = event.currentTarget; setDialog('reload') }}>{t('reload')}</Button>
              : <Button size="sm" variant="outline" onClick={() => { void save() }}>{t('retry')}</Button>}
          </div>
        )}
        {draft !== null
          ? <NotesEditor content={draft.content} onChange={edit} onBlur={() => { void save() }} t={t} />
          : treeState === 'ready' ? <NotesWelcome t={t} />
            : <div className={css.documentStatus} role="status">
              {t(treeState === 'loading' ? 'loading' : 'treeError')}
            </div>}
      </div>
      {(dialog === 'create' || dialog === 'folder' || dialog === 'rename') && <NoteNameDialog t={t}
        kind={dialog === 'rename' ? actionTarget?.kind === 'dir' ? 'renameFolder' : 'renameNote' : dialog}
        name={draftName} busy={creating} onClose={closeDialog} onNameChange={setDraftName}
        error={createFailed && dialog !== 'rename' ? t(dialog === 'folder' ? 'createFolderError' : 'createError') : undefined}
        destination={dialog === 'rename' ? undefined : { tree, path: creationDirectory, onChange: setCreationDirectory }}
        onSubmit={(event) => { void (dialog === 'rename' ? renameTarget(event) : createEntry(event)) }} />}
      {dialog === 'delete' && actionTarget !== null && <NoteDeleteDialog t={t}
        description={actionTarget.kind === 'dir'
          ? t('deleteFolderConfirm', { name: actionTarget.name }) : t('deleteConfirm', { name: labelOf(actionTarget.name) })}
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
