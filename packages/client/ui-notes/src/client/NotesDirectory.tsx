/** 笔记目录持有搜索与菜单，文件操作和当前文档由页面协调。 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MouseEvent, RefObject } from 'react'
import {
  Button, IconCloseOutline16, IconEditOutline16, IconPlusOutline16, IconProjectAddOutline16,
  IconSearchOutline16, IconTrashOutline16, Input, Menu, SidebarRoot, type MenuEntry, type SidebarRootItem,
} from 'coding-client-ui-primitives'
import { Icon } from 'coding-client-ui-icons'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { NS } from './locales.ts'
import { labelOf } from './notes-tree.ts'
import type { NotesTreeEntry } from './wire.ts'
import css from './NotesPage.module.css'

/** 弹窗辨别条目类型及定位目录所需的信息。 */
export type NoteActionTarget = Pick<NotesTreeEntry, 'kind' | 'name' | 'path'>
/** 新建子菜单与创建弹窗共用的操作类型。 */
export type NoteCreateKind = 'create' | 'folder' | 'presentation'
type NoteContextMenu = { target: NoteActionTarget; x: number; y: number; trigger: HTMLButtonElement }
type ImportPicker = { accept: string; onFile: (file: File | undefined) => void }

type NotesDirectoryProps = PropsLocale<typeof NS> & {
  tree: readonly NotesTreeEntry[]
  expanded: ReadonlySet<string>
  activePath: string | null
  collapsed: boolean
  width: number
  creating: boolean
  query: string
  onQueryChange: (query: string) => void
  launcherRef: RefObject<HTMLButtonElement>
  onToggleDir: (path: string) => void
  onSelectPath: (path: string) => void
  onCreate: (kind: NoteCreateKind, path: string, trigger: HTMLButtonElement | null) => void
  onEdit: (kind: 'rename' | 'delete', target: NoteActionTarget, trigger: HTMLButtonElement) => void
  textImport: ImportPicker
  slidesImport: ImportPicker
}

/**
 * 渲染目录与本地操作入口；新建和编辑回传触发器，供弹窗关闭后恢复焦点。
 * @param props - 页面提供的笔记树、选择状态、创建及导入动作。
 * @returns 笔记侧栏与菜单唤起的文件选择器。
 */
export function NotesDirectory({
  t, tree, expanded, activePath, collapsed, width, creating, query, onQueryChange, launcherRef,
  onToggleDir, onSelectPath, onCreate, onEdit, textImport, slidesImport,
}: NotesDirectoryProps) {
  const searchId = useId()
  const searchTrigger = useRef<HTMLButtonElement>(null)
  const textInput = useRef<HTMLInputElement>(null)
  const slidesInput = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<NoteContextMenu | null>(null)

  const closeSearch = () => {
    setSearchOpen(false)
    onQueryChange('')
    searchTrigger.current?.focus({ preventScroll: true })
  }
  const createIn = useCallback((kind: NoteCreateKind, path: string, trigger: HTMLButtonElement | null) => {
    setLauncherOpen(false)
    setContextMenu(null)
    onCreate(kind, path, trigger)
  }, [onCreate])
  const editTarget = useCallback((kind: 'rename' | 'delete', target: NoteActionTarget, trigger: HTMLButtonElement) => {
    setContextMenu(null)
    onEdit(kind, target, trigger)
  }, [onEdit])
  const openContextMenu = useCallback((target: NoteActionTarget, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setLauncherOpen(false)
    setContextMenu({ target, x: event.clientX, y: event.clientY, trigger: event.currentTarget })
  }, [])

  useEffect(() => {
    if (contextMenu === null) return
    const close = () => { setContextMenu(null) }
    window.addEventListener('resize', close)
    return () => { window.removeEventListener('resize', close) }
  }, [contextMenu])

  const locale = t('dateLocale')
  const needle = searchOpen && !collapsed ? query.trim().toLocaleLowerCase(locale) : ''
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
                onClick={(event) => { createIn('create', entry.path, event.currentTarget) }} />
              <Button size="sm" className={css.rowAction} icon={<IconProjectAddOutline16 size={14} />}
                aria-label={t('newFolderIn', { name: label })} title={t('newFolder')} aria-haspopup="dialog"
                onClick={(event) => { createIn('folder', entry.path, event.currentTarget) }} />
            </>}
            <Button size="sm" className={css.rowAction} icon={<IconEditOutline16 size={14} />}
              aria-label={t('renameEntry', { name: label })} title={t('rename')} aria-haspopup="dialog"
              onClick={(event) => { editTarget('rename', entry, event.currentTarget) }} />
            <Button size="sm" className={css.rowAction} data-danger icon={<IconTrashOutline16 size={14} />}
              aria-label={t('deleteEntry', { name: label })} title={t('delete')} aria-haspopup="dialog"
              onClick={(event) => { editTarget('delete', entry, event.currentTarget) }} />
          </>,
          onSelect: () => {
            if (folder) onToggleDir(entry.path)
            else onSelectPath(entry.path)
          },
          onContextMenu: (event) => { openContextMenu(entry, event) },
        })
        if (open && entry.children !== undefined) flatten(entry.children, out, depth + 1)
      }
    }
    const items: SidebarRootItem[] = []
    flatten(tree, items, 0)
    return items
  }, [tree, expanded, activePath, locale, needle, onSelectPath, onToggleDir, createIn, editTarget, openContextMenu, t])

  const launcherEntries: readonly MenuEntry[] = [
    {
      id: 'new',
      label: t('newEntry'),
      icon: <IconPlusOutline16 />,
      submenu: [
        { id: 'folder', label: t('entryFolder'), icon: <Icon name="files" size={16} /> },
        { id: 'create', label: t('entryNote'), icon: <Icon name="notes" size={16} /> },
        { id: 'presentation', label: t('entryPresentation'), icon: <Icon name="file-slides" size={16} /> },
      ],
    },
    {
      id: 'import',
      label: t('importFile'),
      icon: <Icon name="file" size={16} />,
      submenu: [
        { id: 'import-text', label: t('importText'), icon: <Icon name="notes" size={16} /> },
        { id: 'import-slides', label: t('entryPresentation'), icon: <Icon name="file-slides" size={16} /> },
      ],
    },
  ]
  const noteCreateEntries: readonly MenuEntry[] = [
    { id: 'create', label: t('newNote'), icon: <IconPlusOutline16 /> },
    { id: 'folder', label: t('newFolder'), icon: <IconProjectAddOutline16 /> },
  ]

  return (
    <>
      <SidebarRoot label={t('space')} title={t('allNotes')} collapsed={collapsed} width={width} variant="summary"
        headerAction={<div className={css.directoryActions}>
          {!collapsed && (
            <Button ref={searchTrigger} size="sm" className={css.directoryButton} icon={<IconSearchOutline16 />}
              aria-label={t('search')} title={t('search')} aria-expanded={searchOpen}
              aria-controls={searchOpen ? searchId : undefined}
              onClick={() => { if (searchOpen) closeSearch(); else setSearchOpen(true) }} />
          )}
          <Menu open={launcherOpen} portal keyboardNavigation
            anchor={<Button ref={launcherRef} size="sm" className={css.newNote} icon={<IconPlusOutline16 />}
              aria-label={t('newEntry')} title={t('newEntry')} aria-haspopup="menu" aria-expanded={launcherOpen}
              disabled={creating} onClick={() => { setContextMenu(null); setLauncherOpen(open => !open) }} />}
            items={launcherEntries}
            onSelect={(id) => {
              if (id === 'import-text') textInput.current?.click()
              if (id === 'import-slides') slidesInput.current?.click()
              if (id === 'create' || id === 'folder' || id === 'presentation') createIn(id, '', launcherRef.current)
            }}
            onClose={() => { setLauncherOpen(false); launcherRef.current?.focus({ preventScroll: true }) }} />
          {contextMenu !== null && (
            <Menu open portal keyboardNavigation anchor={null}
              items={[
                ...(contextMenu.target.kind === 'dir' ? [...noteCreateEntries, { type: 'separator' as const, id: 'edit' }] : []),
                { id: 'rename', label: t('rename'), icon: <IconEditOutline16 size={16} /> },
                { id: 'delete', label: t('delete'), danger: true, icon: <IconTrashOutline16 size={16} /> },
              ]}
              onSelect={(id) => {
                const { target, trigger } = contextMenu
                if (id === 'create' || id === 'folder') createIn(id, target.path, trigger)
                if (id === 'rename' || id === 'delete') editTarget(id, target, trigger)
              }}
              onClose={() => { setContextMenu(null); contextMenu.trigger.focus({ preventScroll: true }) }}
              getAnchorRect={() => new DOMRect(contextMenu.x, contextMenu.y, 1, 1)} />
          )}
        </div>}
        {...(needle !== '' ? { empty: t('noMatches') } : {})}
        toolbar={searchOpen && <div id={searchId} className={css.searchRow}>
          <Input className={css.searchField} value={query} autoFocus aria-label={t('search')} placeholder={t('search')}
            onChange={(event) => { onQueryChange(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeSearch() } }} />
          <Button size="sm" className={css.directoryButton} aria-label={t('clearSearch')} title={t('clearSearch')}
            icon={<IconCloseOutline16 />} onClick={closeSearch} />
        </div>}
        items={collapsed ? [] : treeItems} />
      {/* 每种导入格式各有一个选择器，浏览器按该类型筛选本机文件。 */}
      <input ref={textInput} type="file" accept={textImport.accept} hidden aria-hidden="true" tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          textImport.onFile(file)
        }} />
      <input ref={slidesInput} type="file" accept={slidesImport.accept} hidden aria-hidden="true" tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          slidesImport.onFile(file)
        }} />
    </>
  )
}
