/** 笔记目录持有搜索与菜单，文件操作和当前文档由页面协调。 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DragEvent, MouseEvent, RefObject } from 'react'
import {
  Button, IconCloseOutline16, IconEditOutline16, IconPlusOutline16, IconProjectAddOutline16,
  IconSearchOutline16, IconTrashOutline16, Input, Menu, SidebarRoot, type MenuEntry, type SidebarRootItem,
} from 'coding-client-ui-primitives'
import { Icon } from 'coding-client-ui-icons'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { NS } from './locales.ts'
import type { NoteImportKind, NoteImportPicker } from './notes-import.ts'
import { NOTE_ICONS, isOfficeKind, labelOf, noteKindOf, type OfficeKind } from './notes-tree.ts'
import type { NotesTreeEntry } from './wire.ts'
import css from './NotesPage.module.css'

/** 弹窗辨别条目类型及定位目录所需的信息。 */
export type NoteActionTarget = Pick<NotesTreeEntry, 'kind' | 'name' | 'path'>
/** 新建子菜单与创建弹窗共用的操作类型。 */
export type NoteCreateKind = 'create' | 'folder' | 'presentation' | 'mindmap' | OfficeKind
type NoteContextMenu = { target: NoteActionTarget; x: number; y: number; trigger: HTMLButtonElement }
type NotesDrag = { path: string; kind: NotesTreeEntry['kind'] }
type NotesDrop = { path: string; position: 'before' | 'after' | 'inside' }

const importTypes = [
  ['text', 'importText', 'notes'],
  ['slides', 'entryPresentation', 'file-slides'],
  ['mindmap', 'entryMindmap', 'file-mindmap'],
  ['word', 'entryWord', 'file-word'],
  ['excel', 'entryExcel', 'file-excel'],
] as const

/** 目录行中间承接拖入，上下边缘用于在其前后插入；文件行按上下半区插入。 */
function dropPositionFor(event: DragEvent<HTMLElement>, entry: NotesTreeEntry): 'before' | 'after' | 'inside' {
  const rect = event.currentTarget.getBoundingClientRect()
  if (entry.kind !== 'dir') return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  const ratio = (event.clientY - rect.top) / rect.height
  return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside'
}

/** 判断路径是否位于目录自身或其后代中，用于阻止目录递归移入自身。 */
function isWithin(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`)
}

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
  onMove: (path: string, directory: string, before: string | null) => void
  onCreate: (kind: NoteCreateKind, path: string, trigger: HTMLButtonElement | null) => void
  onEdit: (kind: 'rename' | 'delete', target: NoteActionTarget, trigger: HTMLButtonElement) => void
  imports: Record<NoteImportKind, NoteImportPicker>
}

/**
 * 渲染目录与本地操作入口；新建和编辑回传触发器，供弹窗关闭后恢复焦点。
 * @param props - 页面提供的笔记树、选择状态、创建及导入动作。
 * @returns 笔记侧栏与菜单唤起的文件选择器。
 */
export function NotesDirectory({
  t, tree, expanded, activePath, collapsed, width, creating, query, onQueryChange, launcherRef,
  onToggleDir, onSelectPath, onMove, onCreate, onEdit, imports,
}: NotesDirectoryProps) {
  const searchId = useId()
  const searchTrigger = useRef<HTMLButtonElement>(null)
  const importInputs = useRef<Partial<Record<NoteImportKind, HTMLInputElement | null>>>({})
  const [searchOpen, setSearchOpen] = useState(false)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<NoteContextMenu | null>(null)
  const [drag, setDrag] = useState<NotesDrag | null>(null)
  const [drop, setDrop] = useState<NotesDrop | null>(null)
  /** 原生 dragstart 后立即读取拖拽源，不能等 React 提交状态后才处理 dragover/drop。 */
  const dragRef = useRef<NotesDrag | null>(null)

  const structure = useMemo(() => {
    const parents = new Map<string, string>()
    const siblings = new Map<string, string[]>()
    const walk = (nodes: readonly NotesTreeEntry[], parent: string): void => {
      const paths: string[] = []
      for (const entry of nodes) {
        parents.set(entry.path, parent)
        paths.push(entry.path)
        if (entry.children !== undefined) walk(entry.children, entry.path)
      }
      siblings.set(parent, paths)
    }
    walk(tree, '')
    return { parents, siblings }
  }, [tree])

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
  const dragEnabled = !collapsed && !creating && needle === ''

  const startDrag = useCallback((entry: NotesTreeEntry, event: DragEvent<HTMLButtonElement>) => {
    if (!dragEnabled) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', entry.path)
    const next = { path: entry.path, kind: entry.kind }
    dragRef.current = next
    setDrag(next)
    setDrop(null)
  }, [dragEnabled])

  const endDrag = useCallback(() => {
    dragRef.current = null
    setDrag(null)
    setDrop(null)
  }, [])

  const canDrop = useCallback((entry: NotesTreeEntry, position: NotesDrop['position']): boolean => {
    const current = dragRef.current
    if (current === null || !dragEnabled || entry.path === current.path) return false
    if (position === 'inside') {
      return entry.kind === 'dir' && (current.kind !== 'dir' || !isWithin(entry.path, current.path))
    }
    const parent = structure.parents.get(entry.path) ?? ''
    return current.kind !== 'dir' || !isWithin(parent, current.path)
  }, [dragEnabled, structure.parents])

  const dragOver = useCallback((entry: NotesTreeEntry, event: DragEvent<HTMLElement>) => {
    if (dragRef.current === null) return
    const position = dropPositionFor(event, entry)
    if (!canDrop(entry, position)) {
      setDrop(previous => previous?.path === entry.path ? null : previous)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDrop(previous => previous?.path === entry.path && previous.position === position ? previous : { path: entry.path, position })
  }, [canDrop])

  const dragLeave = useCallback((entry: NotesTreeEntry, event: DragEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setDrop(previous => previous?.path === entry.path ? null : previous)
  }, [])

  const dropOn = useCallback((entry: NotesTreeEntry, event: DragEvent<HTMLElement>) => {
    const current = dragRef.current
    if (current === null) return
    const position = drop?.path === entry.path ? drop.position : dropPositionFor(event, entry)
    if (!canDrop(entry, position)) return
    event.preventDefault()
    event.stopPropagation()
    const parent = position === 'inside' ? entry.path : structure.parents.get(entry.path) ?? ''
    const siblings = structure.siblings.get(parent) ?? []
    const index = siblings.indexOf(entry.path)
    const before = position === 'before' ? entry.path
      : position === 'after' ? siblings[index + 1] ?? null : null
    onMove(current.path, parent, before)
    endDrag()
  }, [drop, canDrop, structure.parents, structure.siblings, onMove, endDrag])

  useEffect(() => {
    if (drag === null) return
    // 拖出列表时仍由本页接纳原生事件，避免 Electron 把条目当成外部文件打开。
    const acceptDrag = (event: globalThis.DragEvent): void => {
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
    }
    const acceptDrop = (event: globalThis.DragEvent): void => { event.preventDefault() }
    document.addEventListener('dragover', acceptDrag)
    document.addEventListener('drop', acceptDrop)
    return () => {
      document.removeEventListener('dragover', acceptDrag)
      document.removeEventListener('drop', acceptDrop)
    }
  }, [drag])

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
          id: entry.path, label, icon: folder ? 'files' : NOTE_ICONS[noteKindOf(entry.path)], depth,
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
          draggable: dragEnabled,
          onDragStart: (event) => { startDrag(entry, event) },
          onDragEnd: endDrag,
          ...(drop?.path === entry.path ? { dropPosition: drop.position } : {}),
          onDragOver: (event) => { dragOver(entry, event) },
          onDragLeave: (event) => { dragLeave(entry, event) },
          onDrop: (event) => { dropOn(entry, event) },
          onContextMenu: (event) => { openContextMenu(entry, event) },
        })
        if (open && entry.children !== undefined) flatten(entry.children, out, depth + 1)
      }
    }
    const items: SidebarRootItem[] = []
    flatten(tree, items, 0)
    return items
  }, [tree, expanded, activePath, locale, needle, dragEnabled, startDrag, endDrag, drop, dragOver, dragLeave, dropOn,
    onSelectPath, onToggleDir, createIn, editTarget, openContextMenu, t])

  const launcherEntries: readonly MenuEntry[] = [
    {
      id: 'new',
      label: t('newEntry'),
      icon: <IconPlusOutline16 />,
      submenu: [
        { id: 'folder', label: t('entryFolder'), icon: <Icon name="files" size={16} /> },
        { id: 'create', label: t('entryNote'), icon: <Icon name="notes" size={16} /> },
        { id: 'presentation', label: t('entryPresentation'), icon: <Icon name="file-slides" size={16} /> },
        { id: 'mindmap', label: t('entryMindmap'), icon: <Icon name="file-mindmap" size={16} /> },
        { id: 'word', label: t('entryWord'), icon: <Icon name="file-word" size={16} /> },
        { id: 'excel', label: t('entryExcel'), icon: <Icon name="file-excel" size={16} /> },
      ],
    },
    {
      id: 'import',
      label: t('importFile'),
      icon: <Icon name="file" size={16} />,
      submenu: importTypes.map(([kind, label, icon]) => ({
        id: `import-${kind}`, label: t(label), icon: <Icon name={icon} size={16} />,
      })),
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
              const importKind = importTypes.find(([kind]) => id === `import-${kind}`)?.[0]
              if (importKind !== undefined) {
                setLauncherOpen(false)
                launcherRef.current?.focus({ preventScroll: true })
                importInputs.current[importKind]?.click()
              } else if (id === 'create' || id === 'folder' || id === 'presentation' || id === 'mindmap' || isOfficeKind(id)) {
                createIn(id, '', launcherRef.current)
              }
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
      {importTypes.map(([kind]) => (
        <input key={kind} ref={(node) => { importInputs.current[kind] = node }}
          type="file" accept={imports[kind].accept} hidden aria-hidden="true" tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            imports[kind].onFile(file)
          }} />
      ))}
    </>
  )
}
