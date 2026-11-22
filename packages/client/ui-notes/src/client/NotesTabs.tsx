import { useEffect, useRef } from 'react'
import { Button, Icon, IconCloseOutline16 } from 'coding-client-ui-primitives'
import type { NotesLocaleKey } from './locales.ts'
import { NOTE_ICONS, noteKindOf } from './notes-tree.ts'
import css from './NotesTabs.module.css'

interface NotesTabsProps {
  paths: readonly string[]
  activePath: string | null | undefined
  panelId: string
  idPrefix: string
  labelOfPath: (path: string) => string
  onSelect: (path: string) => void
  onClose: (path: string) => void
  t: (key: NotesLocaleKey) => string
}

/**
 * 笔记页顶栏的文档标签：目录负责打开，标签负责切换和关闭；滚动只发生在标签行内。
 * @param props - 已打开路径、活动路径、正文面板和由页面持有的切换动作。
 * @returns 与正文面板关联的可键盘操作标签栏。
 */
export function NotesTabs({ paths, activePath, panelId, idPrefix, labelOfPath, onSelect, onClose, t }: NotesTabsProps) {
  const row = useRef<HTMLDivElement>(null)
  const closing = useRef<string | null>(null)
  useEffect(() => {
    const selected = row.current?.querySelector('[role="tab"][aria-selected="true"]')
    if (selected?.scrollIntoView) selected.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activePath])

  useEffect(() => {
    if (closing.current === null) return
    if (!paths.includes(closing.current)) {
      closing.current = null
      row.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true })
    }
  }, [activePath, paths])

  return <div className={css.bar} data-window-drag-region>
    <div ref={row} className={css.tabs} role="tablist" aria-label={t('openTabs')}
      onKeyDown={(event) => {
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        const index = tabs.indexOf(event.target as HTMLButtonElement)
        if (index < 0) return
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
        if (next < 0) return
        event.preventDefault()
        tabs[next]?.focus()
        tabs[next]?.click()
      }}>
      {paths.map((path, index) => {
        const name = labelOfPath(path)
        const selected = path === activePath
        return <div key={path} className={css.tab} data-active={selected} role="presentation">
          <Button className={css.select} role="tab" id={`${idPrefix}-${index}`} aria-controls={panelId}
            aria-selected={selected} tabIndex={selected || activePath == null && index === 0 ? 0 : -1} title={name}
            icon={<Icon name={NOTE_ICONS[noteKindOf(path)]} size={14} />} onClick={() => { onSelect(path) }}>
            <span className={css.name}>{name}</span>
          </Button>
          <Button className={css.close} icon={<IconCloseOutline16 size={12} />}
            aria-label={t('closeTab').replace('{name}', name)} title={t('closeTab').replace('{name}', name)}
            onClick={() => { closing.current = path; onClose(path) }} />
        </div>
      })}
    </div>
  </div>
}
