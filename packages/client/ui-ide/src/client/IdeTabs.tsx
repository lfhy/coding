/** IDE 文件标签：键盘导航、关闭与跨分组拖拽的拖起点。 */
import type { DragEvent, KeyboardEvent } from 'react'
import { IconCloseOutline16, Icon } from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { IdeDocument } from './ide-store.ts'
import { NS } from './locales.ts'
import css from './IdeTabs.module.css'

interface IdeTabsProps {
  /** 本分组已打开的文件，顺序即显示顺序。 */
  tabs: readonly IdeDocument[]
  activePath: string | null
  /** 本分组身份；拖拽与移动动作都要带上它。 */
  paneId: string
  onActivate: (paneId: string, path: string) => void
  onClose: (path: string) => void
  /** 拖拽开始；由工作区记录被拖动的标签，供落点判断。 */
  onDragStart: (paneId: string, path: string) => void
  onDragEnd: () => void
  t: PropsLocale<typeof NS>['t']
}

/** 标签栏只显示文件身份与未保存状态，不承载编辑操作。 */
export function IdeTabs({
  tabs, activePath, paneId, onActivate, onClose, onDragStart, onDragEnd, t,
}: IdeTabsProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const index = tabs.findIndex(tab => tab.path === activePath)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    const path = tabs[next]?.path
    if (path !== undefined) {
      onActivate(paneId, path)
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
    }
  }
  const startDrag = (event: DragEvent<HTMLDivElement>, path: string): void => {
    event.dataTransfer.effectAllowed = 'move'
    // 浏览器要求至少写入一项才会真正开始拖拽；落点判定用工作区状态，不依赖这里的内容。
    event.dataTransfer.setData('text/plain', path)
    onDragStart(paneId, path)
  }
  return <div className={css.tabs} role="tablist" aria-label={t('openFiles')} onKeyDown={onKeyDown}
    data-pane={paneId}>
    {tabs.map(tab => <div key={tab.path} className={css.tab} data-active={tab.path === activePath ? '' : undefined}
      draggable
      onDragStart={(event) => { startDrag(event, tab.path) }}
      onDragEnd={onDragEnd}>
      <button id={`ide-tab-${encodeURIComponent(tab.path)}`} type="button" role="tab"
        aria-selected={tab.path === activePath} aria-controls={`ide-editor-panel-${paneId}`} tabIndex={tab.path === activePath ? 0 : -1}
        className={css.tabButton} title={tab.path} onClick={() => { onActivate(paneId, tab.path) }}>
        <Icon name="file" size={14} />
        <span className={css.label}>{tab.name}</span>
        {tab.dirty && <span className={css.dirty} aria-label={t('unsaved')} />}
      </button>
      <button type="button" className={css.close} aria-label={t('closeFile', { name: tab.name })} title={t('close')}
        onClick={() => { onClose(tab.path) }}>
        <IconCloseOutline16 size={14} />
      </button>
    </div>)}
  </div>
}
