import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import {
  Button, Icon, IconCheckOutline14, IconCloseOutline16, IconPlusOutline16, IconSearchOutline16, IconSparkle16,
  Input, Modal, SidebarRoot, Toast, type SidebarRootItem,
} from 'coding-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import { NS, type NotesLocaleKey } from './locales.ts'
import { NotesEditor } from './NotesEditor.tsx'
import { useNoteDraft } from './useNoteDraft.ts'
import { notesCreate, notesTree, type NotesTreeEntry } from './wire.ts'
import css from './NotesPage.module.css'

export type NotesPageProps = PropsRuntime<'shell.page'> & PropsLocale<typeof NS>

/** AI 助手改动检测的目录轮询间隔。 */
const TREE_POLL_MS = 4000
type DirectoryState = 'loading' | 'ready' | 'failed'

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

function firstNote(
  entries: readonly NotesTreeEntry[], parents: readonly string[] = [],
): { path: string; parents: readonly string[] } | undefined {
  const first = entries.find(entry => entry.kind === 'file')
  if (first !== undefined) return { path: first.path, parents }
  for (const entry of entries) {
    if (entry.children === undefined) continue
    const nested = firstNote(entry.children, [...parents, entry.path])
    if (nested !== undefined) return nested
  }
  return undefined
}

/**
 * 独立笔记页：目录和编辑器由本页持有，助手显隐由同会话的根布局持有。
 * @param props - 根布局提供的实际侧栏和助手状态、动作，以及本地化文案。
 * @returns 笔记目录与正文编辑区。
 */
export function NotesPage({
  closePage, t, sidebarCollapsed, sidebarWidth, assistantOpen, assistantPanelId, toggleAssistant,
}: NotesPageProps) {
  const titleId = useId()
  const searchId = useId()
  const formId = useId()
  const nameId = useId()
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const searchTrigger = useRef<HTMLButtonElement>(null)
  const dialogTrigger = useRef<HTMLButtonElement | null>(null)
  const creatingRequest = useRef<AbortController | null>(null)
  const [tree, setTree] = useState<NotesTreeEntry[]>([])
  const [treeState, setTreeState] = useState<DirectoryState>('loading')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<'create' | 'reload' | null>(null)
  const [draftName, setDraftName] = useState('')
  const [creating, setCreating] = useState(false)
  const [toast, setToast] = useState<{ id: number; key: NotesLocaleKey } | null>(null)
  const toastId = useRef(0)

  const notify = useCallback((key: NotesLocaleKey) => {
    toastId.current += 1
    setToast({ id: toastId.current, key })
  }, [])

  const { draft, saveLabel, select, edit, save, reload, refresh, getPath, flush } = useNoteDraft(notify)

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
      try {
        const fresh = await notesTree(signal)
        signal.throwIfAborted()
        setTree(fresh)
        const path = getPath()
        if (path !== undefined) {
          await refresh(findEntry(fresh, path)?.mtimeMs, signal)
        } else if (status !== 'ready' && creatingRequest.current === null) {
          const first = firstNote(fresh)
          if (first !== undefined) {
            setExpanded(new Set(first.parents))
            await select(first.path)
          }
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
  }, [getPath, notify, refresh, select])

  const toggleDir = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const locale = t('dateLocale')
  const typeLabel = t('noteType')
  const needle = searchOpen && !sidebarCollapsed ? query.trim().toLocaleLowerCase(locale) : ''
  const treeItems = useMemo(() => {
    const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
    const flatten = (entries: readonly NotesTreeEntry[], out: SidebarRootItem[], depth: number): void => {
      for (const entry of entries) {
        if (entry.kind === 'dir') {
          if (needle !== '') {
            if (entry.children !== undefined) flatten(entry.children, out, 0)
            continue
          }
          out.push({
            id: entry.path, label: entry.name, icon: 'files', folder: true, open: expanded.has(entry.path), depth,
            onSelect: () => { toggleDir(entry.path) },
          })
          if (expanded.has(entry.path) && entry.children !== undefined) flatten(entry.children, out, depth + 1)
        } else {
          const label = labelOf(entry.name)
          if (needle !== '' && !label.toLocaleLowerCase(locale).includes(needle)) continue
          out.push({
            id: entry.path, label, icon: 'notes', iconTone: 'blue', depth, active: draft?.path === entry.path,
            description: entry.path.split('/').at(-2) ?? typeLabel,
            meta: date.format(entry.mtimeMs),
            onSelect: () => { void select(entry.path) },
          })
        }
      }
    }
    const items: SidebarRootItem[] = []
    flatten(tree, items, 0)
    return items
  }, [tree, expanded, draft?.path, locale, needle, typeLabel, select, toggleDir])

  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
    searchTrigger.current?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (dialog !== null || dialogTrigger.current === null) return
    dialogTrigger.current.focus({ preventScroll: true })
    dialogTrigger.current = null
  }, [dialog])

  const closeDialog = () => {
    if (creatingRequest.current !== null) return
    setDialog(null)
  }

  const openDialog = (kind: 'create' | 'reload', event: MouseEvent<HTMLButtonElement>) => {
    dialogTrigger.current = event.currentTarget
    if (kind === 'create') setDraftName('')
    setDialog(kind)
  }

  const createNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = draftName.trim()
    if (name === '' || creatingRequest.current !== null) return
    const request = new AbortController()
    creatingRequest.current = request
    setCreating(true)
    try {
      const { path } = await notesCreate(name)
      request.signal.throwIfAborted()
      const fresh = notesTree(request.signal).then((entries) => {
        if (!request.signal.aborted) setTree(entries)
      }, () => {
        if (!request.signal.aborted) notify('treeError')
      })
      await Promise.all([fresh, select(path)])
      if (!request.signal.aborted) setDialog(null)
    } catch {
      if (!request.signal.aborted) notify('createError')
    } finally {
      creatingRequest.current = null
      if (!request.signal.aborted) setCreating(false)
    }
  }

  const selectedLabel = draft === null ? t('title') : labelOf(findEntry(tree, draft.path)?.name ?? draft.path.replace(/^.*\//u, ''))

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
          <Button size="sm" className={css.newNote} icon={<IconPlusOutline16 />}
            aria-label={t('newNote')} title={t('newNote')} aria-haspopup="dialog" disabled={creating}
            onClick={(event) => { openDialog('create', event) }} />
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
          <Button size="sm" className={css.assistant} icon={<IconSparkle16 />}
            aria-label={t('assistant')} title={t('assistant')} aria-expanded={assistantOpen}
            aria-controls={assistantPanelId} onClick={toggleAssistant}>
            <span className={css.assistantLabel}>{t('assistant')}</span>
          </Button>
        </header>
        {(saveLabel === 'conflict' || saveLabel === 'saveError') && (
          <div className={css.recovery}>
            <p>{t('draftKept')}</p>
            {saveLabel === 'conflict'
              ? <Button size="sm" variant="outline" aria-haspopup="dialog"
                onClick={(event) => { openDialog('reload', event) }}>{t('reload')}</Button>
              : <Button size="sm" variant="outline" onClick={() => { void save() }}>{t('retry')}</Button>}
          </div>
        )}
        {draft !== null
          ? <NotesEditor content={draft.content} onChange={edit} onBlur={() => { void save() }} t={t} />
          : <div className={css.empty} role="status">
            {treeState === 'loading' ? <p>{t('loading')}</p>
              : treeState === 'failed' ? <p>{t('treeError')}</p>
                : <><strong>{t(tree.length === 0 ? 'empty' : 'chooseNote')}</strong>
                  {tree.length === 0 && <p>{t('emptyHint')}</p>}</>}
          </div>}
      </div>
      <Modal open={dialog === 'create'} onClose={closeDialog} title={t('newNote')} closeLabel={t('close')} trapFocus
        footer={<>
          <Button variant="outline" disabled={creating} onClick={closeDialog}>{t('cancel')}</Button>
          <Button variant="primary" type="submit" form={formId} disabled={creating || draftName.trim() === ''}>
            {t(creating ? 'creating' : 'create')}
          </Button>
        </>}>
        <form id={formId} className={css.form} onSubmit={(event) => { void createNote(event) }}>
          <label htmlFor={nameId}>{t('noteName')}</label>
          <Input id={nameId} value={draftName} autoFocus readOnly={creating}
            onChange={(event) => { setDraftName(event.target.value) }} />
        </form>
      </Modal>
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
