import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { MarkdownText, Modal, SidebarRoot, Toast, type SidebarRootItem } from 'coding-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import { NS } from './locales.ts'
import { NoteConflictError, notesCreate, notesRead, notesSave, notesTree, type NotesTreeEntry } from './wire.ts'
import css from './NotesPage.module.css'

export type NotesPageProps = PropsRuntime<'shell.page'> & PropsLocale<typeof NS>

/** 编辑器停顿后多久视为稳定并自动保存；与手动保存共用同一路径。 */
const AUTOSAVE_DELAY_MS = 900
/** AI 助手改动检测的目录轮询间隔。 */
const TREE_POLL_MS = 4000

type SaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'failed'

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

/** 笔记页：目录树侧栏、原始文本编辑与 Markdown 预览三分区；右半区的 AI 助手轨由根布局挂载。 */
export function NotesPage({ closePage, t, sidebarCollapsed, sidebarWidth }: NotesPageProps) {
  const titleId = useId()
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const [tree, setTree] = useState<NotesTreeEntry[]>([])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>())
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [baseMtimeMs, setBaseMtimeMs] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [createOpen, setCreateOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [creating, setCreating] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const toastId = useRef(0)

  const selectedRef = useRef(selected)
  const dirtyRef = useRef(dirty)
  const contentRef = useRef(content)
  const baseMtimeRef = useRef(baseMtimeMs)
  selectedRef.current = selected
  dirtyRef.current = dirty
  contentRef.current = content
  baseMtimeRef.current = baseMtimeMs

  const showToast = useCallback((text: string) => {
    toastId.current += 1
    setToast({ id: toastId.current, text })
  }, [])

  /** 把树里指定路径的条目刷新为最新修改时间，保存成功后避免轮询误判外部改动。 */
  const noteMtimes = useCallback((entries: readonly NotesTreeEntry[], path: string, mtimeMs: number): NotesTreeEntry[] =>
    entries.map((entry) => {
      if (entry.path === path) return { ...entry, mtimeMs }
      if (entry.kind === 'dir' && entry.children !== undefined) {
        return { ...entry, children: noteMtimes(entry.children, path, mtimeMs) }
      }
      return entry
    }), [])

  const save = useCallback(async (): Promise<boolean> => {
    const path = selectedRef.current
    if (path === null || !dirtyRef.current) return true
    setSaveState('saving')
    try {
      /* v8 ignore next -- 选中笔记必然已读取并持有基准修改时间，空基准只防御异常时序。 */
      const result = await notesSave(path, contentRef.current, baseMtimeRef.current ?? undefined)
      setBaseMtimeMs(result.mtimeMs)
      setDirty(false)
      setSaveState('saved')
      setTree(previous => noteMtimes(previous, result.path, result.mtimeMs))
      return true
    } catch (error) {
      if (error instanceof NoteConflictError) {
        setSaveState('conflict')
        return false
      }
      setSaveState('failed')
      return false
    }
  }, [noteMtimes])

  /** 重新加载被外部修改的笔记，丢弃编辑器缓冲并采用磁盘内容。 */
  const reload = useCallback(async () => {
    const path = selectedRef.current
    /* v8 ignore next -- 重新加载只在选中笔记且处于冲突状态时可点，空选择只防御弹窗残留。 */
    if (path === null) return
    try {
      const read = await notesRead(path, new AbortController().signal)
      setContent(read.content)
      setBaseMtimeMs(read.mtimeMs)
      setDirty(false)
      setSaveState('saved')
    } catch {
      setSaveState('conflict')
    }
  }, [])

  const selectNote = useCallback(async (path: string) => {
    if (path === selectedRef.current) return
    // 切换前先把未保存的改动落盘；冲突时保存失败，旧笔记保留外部版本并提示。
    if (dirtyRef.current && !(await save())) {
      showToast(t('conflict'))
    }
    try {
      const read = await notesRead(path, new AbortController().signal)
      setSelected(path)
      setContent(read.content)
      setBaseMtimeMs(read.mtimeMs)
      setDirty(false)
      setSaveState('idle')
    } catch {
      showToast(t('loadError'))
    }
  }, [save, showToast, t])

  useEffect(() => {
    /* v8 ignore next -- jsdom 中 activeElement 恒为元素；null 臂只防御焦点位于其他文档或窗口的浏览器。 */
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    titleRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key === 's' || event.key === 'S') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void save()
        return
      }
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"], [role="listbox"]')) return
      closePage()
    }
    document.addEventListener('keydown', onKeyDown)
    const controller = new AbortController()
    notesTree(controller.signal).then((entries) => {
      setTree(entries)
      const first = entries.find(entry => entry.kind === 'file')
      if (first !== undefined) void selectNote(first.path)
    }).catch(() => { showToast(t('treeError')) })
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocus.current?.focus()
    }
  }, [closePage, save, selectNote, showToast, t])

  // 停顿 900ms 的自动保存；切换笔记与手动保存走同一 save 路径。
  useEffect(() => {
    if (!dirty) return
    const timer = window.setTimeout(() => { void save() }, AUTOSAVE_DELAY_MS)
    return () => { window.clearTimeout(timer) }
  }, [content, dirty, save])

  // 目录轮询：AI 助手写入笔记后更新树；当前笔记被外部修改且编辑器无未保存改动时静默采用。
  useEffect(() => {
    const poll = window.setInterval(async () => {
      try {
        const fresh = await notesTree(new AbortController().signal)
        setTree(fresh)
        const path = selectedRef.current
        if (path === null || dirtyRef.current) return
        const entry = findEntry(fresh, path)
        if (entry !== undefined && entry.mtimeMs !== baseMtimeRef.current) {
          const read = await notesRead(path, new AbortController().signal)
          setContent(read.content)
          setBaseMtimeMs(read.mtimeMs)
        }
      } catch {
        /* 网络抖动保留现有树与内容，下一轮重试。 */
      }
    }, TREE_POLL_MS)
    return () => { window.clearInterval(poll) }
  }, [])

  const toggleDir = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const treeItems = useMemo(() => {
    const flatten = (entries: readonly NotesTreeEntry[], out: SidebarRootItem[], depth: number): void => {
      for (const entry of entries) {
        if (entry.kind === 'dir') {
          out.push({
            id: entry.path, label: entry.name, icon: 'files', folder: true, open: expanded.has(entry.path), depth,
            onSelect: () => { toggleDir(entry.path) },
          })
          if (expanded.has(entry.path) && entry.children !== undefined) flatten(entry.children, out, depth + 1)
        } else {
          out.push({
            id: entry.path, label: labelOf(entry.name), icon: 'notes', depth, active: selected === entry.path,
            onSelect: () => { void selectNote(entry.path) },
          })
        }
      }
    }
    const items: SidebarRootItem[] = []
    flatten(tree, items, 0)
    return items
  }, [tree, expanded, selected, selectNote, toggleDir])

  const createNote = useCallback(async () => {
    const name = draftName.trim()
    if (name === '') return
    setCreating(true)
    try {
      const { path } = await notesCreate(name)
      const fresh = await notesTree(new AbortController().signal)
      setTree(fresh)
      setExpanded((previous) => {
        const next = new Set(previous)
        const segments = path.split('/')
        for (let i = 1; i < segments.length; i++) {
          /* v8 ignore next -- 新建笔记只落在笔记根目录，父链展开只防御将来支持子目录创建。 */
          next.add(segments.slice(0, i).join('/'))
        }
        return next
      })
      setCreateOpen(false)
      setDraftName('')
      await selectNote(path)
    } catch {
      showToast(t('createError'))
    } finally {
      setCreating(false)
    }
  }, [draftName, selectNote, showToast, t])

  const selectedLabel = selected === null ? t('empty') : labelOf(findEntry(tree, selected)?.name ?? selected.replace(/^.*\//u, ''))
  const saveLabel = saveState === 'saving' ? t('saving')
    : saveState === 'saved' ? t('saved')
      : saveState === 'conflict' || saveState === 'failed' ? t(saveState === 'conflict' ? 'conflict' : 'saveError')
        : dirty ? t('unsaved') : ''

  return (
    <main className={css.page} aria-labelledby={titleId}
      style={{ '--page-sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
      <SidebarRoot
        label={t('space')} title={t('space')}
        collapsed={sidebarCollapsed} width={sidebarWidth}
        header={
          <button type="button" className={css.newNote} onClick={() => { setCreateOpen(true); setDraftName('') }}>
            {t('newNote')}
          </button>
        }
        items={treeItems}
        empty={t('empty')} />
      <section className={css.source} aria-label={t('source')}>
        <header className={css.paneHeader}>
          <h1 ref={titleRef} id={titleId} className={css.title} tabIndex={-1}>{selectedLabel}</h1>
          <span className={css.saveState} data-state={saveState} aria-live="polite">{saveLabel}</span>
        </header>
        {selected === null ? (
          <div className={css.paneBody}>
            <p className={css.emptyHint}>{t('emptyHint')}</p>
            <button type="button" className={css.primary} onClick={() => { setCreateOpen(true); setDraftName('') }}>
              {t('newNote')}
            </button>
          </div>
        ) : (
          <div className={css.paneBody}>
            <textarea
              className={css.editor}
              value={content}
              spellCheck={false}
              placeholder={t('placeholder')}
              aria-label={t('source')}
              onChange={(event) => { setContent(event.target.value); setDirty(true) }}
              onBlur={() => { void save() }} />
          </div>
        )}
      </section>
      <section className={css.preview} aria-label={t('preview')}>
        <header className={css.paneHeader}>
          <h2 className={css.title}>{t('preview')}</h2>
          {saveState === 'conflict' && (
            <button type="button" className={css.reload} onClick={() => { void reload() }}>{t('reload')}</button>
          )}
        </header>
        <div className={css.paneBody}>
          {selected === null
            ? <p className={css.emptyHint}>{t('empty')}</p>
            : <MarkdownText text={content} codeLabels={{ copyLabel: t('copy'), copiedLabel: t('copied') }}
              onOpenUrl={(href) => { window.open(href, '_blank', 'noopener,noreferrer') }} />}
        </div>
      </section>
      <Modal
        open={createOpen}
        onClose={() => { if (!creating) setCreateOpen(false) }}
        title={t('newNote')}
        closeLabel={t('cancel')}
        trapFocus>
        <label className={css.formLabel} htmlFor="notes-new-name">{t('noteName')}</label>
        <input id="notes-new-name" className={css.formInput} value={draftName}
          placeholder="想法.md" onChange={(event) => { setDraftName(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') { void createNote() } }} />
        <div className={css.modalFooter}>
          <button type="button" className={css.secondary} onClick={() => { setCreateOpen(false) }}>{t('cancel')}</button>
          <button type="button" className={css.primary} disabled={creating || draftName.trim() === ''}
            onClick={() => { void createNote() }}>
            {t('create')}
          </button>
        </div>
      </Modal>
      {toast !== null && <Toast key={toast.id} text={toast.text} onDone={() => { setToast(null) }} />}
    </main>
  )
}
