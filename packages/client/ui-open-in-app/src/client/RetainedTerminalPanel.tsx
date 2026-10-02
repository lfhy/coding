/** 终端第一次显示时才挂载；标签切换或底栏收起都不释放已有 PTY。 */

import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { TerminalPanel, type TerminalPanelProps } from './TerminalPanel.tsx'
import { NS } from './locales.ts'
import css from './TerminalPanel.module.css'

type RetainedTerminalProps = PropsRuntime<'workbench.bottom'> & PropsLocale<typeof NS> & InjectFace<{
  terminalUrl: (sessionId: SessionId) => string
  closeBottom: (sessionId: SessionId) => void
}>

type Tab = { readonly id: number }
type TabsState = {
  readonly tabs: readonly Tab[]
  readonly activeId: number | null
  readonly focusRequest: number | null
  readonly collapseRevision: number
}
type TabsAction =
  | { readonly type: 'add'; readonly id: number }
  | { readonly type: 'close'; readonly id: number }
  | { readonly type: 'select'; readonly id: number; readonly focus: boolean }
  | { readonly type: 'hidden' }

function reduceTabs(state: TabsState, action: TabsAction): TabsState {
  if (action.type === 'add') {
    return {
      ...state,
      tabs: [...state.tabs, { id: action.id }],
      activeId: action.id,
      focusRequest: (state.focusRequest ?? 0) + 1,
    }
  }
  if (action.type === 'close') {
    const index = state.tabs.findIndex(tab => tab.id === action.id)
    if (index < 0) return state
    const tabs = state.tabs.filter(tab => tab.id !== action.id)
    return {
      tabs,
      activeId: state.activeId === action.id
        ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null) : state.activeId,
      focusRequest: (state.focusRequest ?? 0) + 1,
      collapseRevision: state.collapseRevision + (tabs.length === 0 ? 1 : 0),
    }
  }
  if (action.type === 'select') {
    if (!state.tabs.some(tab => tab.id === action.id)) return state
    return {
      ...state,
      activeId: action.id,
      focusRequest: action.focus ? (state.focusRequest ?? 0) + 1 : null,
    }
  }
  return state.focusRequest === 0 ? state : { ...state, focusRequest: 0 }
}

function TerminalTabs(props: TerminalPanelProps): React.JSX.Element {
  const panelPrefix = useId()
  const nextId = useRef(2)
  const addButton = useRef<HTMLButtonElement>(null)
  const [state, dispatch] = useReducer(reduceTabs, {
    tabs: [{ id: 1 }], activeId: 1, focusRequest: 0, collapseRevision: 0,
  })
  const { tabs, activeId, focusRequest } = state
  const wasShown = useRef(props.shown)
  const handledCollapse = useRef(0)
  const { shown, t, closeBottom } = props

  useEffect(() => {
    if (!shown) dispatch({ type: 'hidden' })
    else if (!wasShown.current && tabs.length === 0) {
      dispatch({ type: 'add', id: nextId.current++ })
    }
    wasShown.current = shown
  }, [shown, tabs.length])

  useEffect(() => {
    if (handledCollapse.current === state.collapseRevision) return
    handledCollapse.current = state.collapseRevision
    if (tabs.length === 0) closeBottom()
  }, [state.collapseRevision, tabs.length, closeBottom])

  useLayoutEffect(() => {
    if (shown && tabs.length === 0) addButton.current?.focus()
  }, [shown, tabs.length])

  const addTab = () => {
    const id = nextId.current++
    dispatch({ type: 'add', id })
  }
  const closeTab = (id: number) => {
    dispatch({ type: 'close', id })
  }
  const selectWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
    const tab = tabs[next]
    if (tab === undefined) return
    event.preventDefault()
    dispatch({ type: 'select', id: tab.id, focus: false })
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
                    dispatch({ type: 'select', id: tab.id, focus: event.detail !== 0 })
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
          title={t('workbench.bottom.hide')} onClick={closeBottom}>×</button>
      </header>
      <div className={css.panels}>
        {tabs.map(tab => (
          <TerminalPanel key={tab.id} {...props} shown={shown && activeId === tab.id}
            focusRequest={focusRequest} onCompleted={() => { closeTab(tab.id) }}
            panelId={`${panelPrefix}-panel-${tab.id}`} tabId={`${panelPrefix}-tab-${tab.id}`} />
        ))}
      </div>
    </section>
  )
}

/**
 * 避免从未打开的底栏初始化 xterm，同时保留已激活终端的连接和滚屏。
 * @param props - 当前会话、会话列表与 Host 终端 URL 工厂。
 * @returns 已启用会话保持挂载的终端树。
 */
export function RetainedTerminalPanel(props: RetainedTerminalProps): ReactNode {
  const { sessionId, shown, useSessions, terminalUrl, closeBottom, ...rest } = props
  const sessionIds = useSessions(state => state.ids)
  const [activated, setActivated] = useState<readonly SessionId[]>(() =>
    shown && sessionId !== undefined ? [sessionId] : [])
  useEffect(() => {
    setActivated((current) => {
      const retained = current.filter(id => sessionIds.includes(id))
      if (!shown || sessionId === undefined || !sessionIds.includes(sessionId) || retained.includes(sessionId)) {
        return retained.length === current.length ? current : retained
      }
      return [...retained, sessionId]
    })
  }, [sessionIds, sessionId, shown])
  return activated.map(id => (
    <TerminalTabs key={id} {...rest} sessionId={id} shown={shown && sessionId === id}
      terminalUrl={terminalUrl(id)} closeBottom={() => { closeBottom(id) }} />
  ))
}
