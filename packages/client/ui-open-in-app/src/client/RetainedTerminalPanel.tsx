/** 终端第一次显示时才挂载；标签切换或底栏收起都不释放已有 PTY。 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '@deepseek-ai/dsh-client-ui-primitives'
import { TerminalPanel, type TerminalPanelProps } from './TerminalPanel.tsx'
import css from './TerminalPanel.module.css'

type Tab = { readonly id: number }

function TerminalTabs(props: TerminalPanelProps): React.JSX.Element {
  const panelPrefix = useId()
  const nextId = useRef(2)
  const addButton = useRef<HTMLButtonElement>(null)
  const [tabs, setTabs] = useState<readonly Tab[]>([{ id: 1 }])
  const [activeId, setActiveId] = useState<number | null>(1)
  const [focusRequest, setFocusRequest] = useState<number | null>(0)
  const { shown, t } = props

  useEffect(() => {
    if (!shown) setFocusRequest(0)
  }, [shown])

  useLayoutEffect(() => {
    if (shown && tabs.length === 0) addButton.current?.focus()
  }, [shown, tabs.length])

  const addTab = () => {
    const id = nextId.current++
    setTabs(current => [...current, { id }])
    setActiveId(id)
    setFocusRequest(current => (current ?? 0) + 1)
  }
  const closeTab = (id: number) => {
    const index = tabs.findIndex(tab => tab.id === id)
    const remaining = tabs.filter(tab => tab.id !== id)
    setTabs(remaining)
    setFocusRequest(current => (current ?? 0) + 1)
    if (activeId === id) {
      setActiveId(remaining[index]?.id ?? remaining[index - 1]?.id ?? null)
    }
  }
  const selectWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
    const tab = tabs[next]
    if (tab === undefined) return
    event.preventDefault()
    setFocusRequest(null)
    setActiveId(tab.id)
    event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <section className={css.root} hidden={!shown} aria-label={t('terminal.label')}>
      <header className={css.header}>
        <div className={css.tabs} role="tablist" aria-label={t('terminal.tabs')}>
          {tabs.map((tab, index) => {
            const name = t('terminal.tab', { number: String(tab.id) })
            return (
              <div className={css.tab} data-active={activeId === tab.id} key={tab.id}>
                <button type="button" className={css.tabSelect} role="tab" id={`${panelPrefix}-tab-${tab.id}`}
                  aria-controls={`${panelPrefix}-panel-${tab.id}`} aria-selected={activeId === tab.id}
                  tabIndex={activeId === tab.id ? 0 : -1} onClick={(event) => {
                    setActiveId(tab.id)
                    setFocusRequest(current => event.detail === 0 ? null : (current ?? 0) + 1)
                  }}
                  onKeyDown={(event) => { selectWithKeyboard(event, index) }}>
                  <Icon name="bottom-panel" size={14} />
                  <span>{name}</span>
                </button>
                <button type="button" className={css.tabClose} aria-label={t('terminal.closeTab', { name })}
                  title={t('terminal.closeTab', { name })} onClick={() => { closeTab(tab.id) }}>×</button>
              </div>
            )
          })}
        </div>
        <button ref={addButton} type="button" className={css.iconButton} aria-label={t('terminal.newTab')}
          title={t('terminal.newTab')} onClick={addTab}>+</button>
        <button type="button" className={css.iconButton} aria-label={t('workbench.bottom.hide')}
          title={t('workbench.bottom.hide')} onClick={props.closeBottom}>×</button>
      </header>
      <div className={css.panels}>
        {tabs.map(tab => (
          <TerminalPanel key={tab.id} {...props} shown={shown && activeId === tab.id}
            focusRequest={focusRequest}
            panelId={`${panelPrefix}-panel-${tab.id}`} tabId={`${panelPrefix}-tab-${tab.id}`} />
        ))}
      </div>
    </section>
  )
}

/**
 * 避免从未打开的底栏初始化 xterm，同时保留已激活终端的连接和滚屏。
 * @param props - 布局 owner 与 Host 终端 URL。
 * @returns 尚未启用时为空；启用后保持每个标签自己的终端组件。
 */
export function RetainedTerminalPanel(props: TerminalPanelProps): ReactNode {
  const [activated, setActivated] = useState(props.shown)
  useEffect(() => {
    if (props.shown) setActivated(true)
  }, [props.shown])
  return activated ? <TerminalTabs {...props} /> : null
}
