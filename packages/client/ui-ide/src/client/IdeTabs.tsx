/** IDE 文件标签；关闭动作与标签切换分离，保留键盘方向键导航。 */
import type { KeyboardEvent } from 'react'
import { IconCloseOutline16, Icon } from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { IdeDocument } from './ide-store.ts'
import { NS } from './locales.ts'
import css from './IdeTabs.module.css'

interface IdeTabsProps {
  tabs: readonly IdeDocument[]
  activePath: string | null
  onActivate: (path: string) => void
  onClose: (path: string) => void
  t: PropsLocale<typeof NS>['t']
}

/** 标签栏只显示文件身份与未保存状态，不承载编辑操作。 */
export function IdeTabs({ tabs, activePath, onActivate, onClose, t }: IdeTabsProps) {
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
      onActivate(path)
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
    }
  }
  return <div className={css.tabs} role="tablist" aria-label={t('openFiles')} onKeyDown={onKeyDown}>
    {tabs.map(tab => <div key={tab.path} className={css.tab} data-active={tab.path === activePath ? '' : undefined}>
      <button id={`ide-tab-${encodeURIComponent(tab.path)}`} type="button" role="tab"
        aria-selected={tab.path === activePath} aria-controls="ide-editor-panel" tabIndex={tab.path === activePath ? 0 : -1}
        className={css.tabButton} title={tab.path} onClick={() => { onActivate(tab.path) }}>
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
