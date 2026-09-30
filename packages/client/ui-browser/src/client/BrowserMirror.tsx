/** Host 画面只作为 PNG 展示，不把目标页面嵌入 Client DOM。 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import {
  IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconGlobeOutline14, IconPlusOutline16, IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-icons'
import type { BrowserHumanCommand, BrowserHumanTarget } from '@deepseek-ai/dsh-browser/types'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-open-in-app/client'
import type { BrowserView } from './controller.ts'
import { fitBrowserViewport, type BrowserViewport } from './viewport.ts'
import { pointOnFrame } from './interaction.ts'
import { normalizeBrowserUrl } from './wire.ts'
import { NS } from './locales.ts'
import css from './BrowserMirror.module.css'

/** 两个 slot 共用同一个会话控制器，但只让内容 slot 持有轮询。 */
export interface BrowserMirrorInjected {
  hooks: { browserMirror: HostObservable<BrowserView> }
  start: (onRevision: () => void) => () => void
  ensureTab: () => Promise<void>
  command: (command: BrowserHumanCommand) => Promise<boolean>
  retry: () => void
}
export type BrowserMirrorProps = PropsRuntime<'workbench.browser'> & PropsLocale<typeof NS> & InjectFace<BrowserMirrorInjected>
export type BrowserTabsProps = PropsRuntime<'workbench.browser.tabs'> & PropsLocale<typeof NS> & InjectFace<BrowserMirrorInjected>

function AgentPointer() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path className={css.agentPointerFill} d="M2.75 1.5v12.7l3.48-3.3 2.2 4.1 2.22-1.14-2.2-4.08 4.64-.8L2.75 1.5Z"
      stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
}

/**
 * 工作台顶部标签列；外层工作台继续拥有窗口尺寸和文件视图切换。
 * @param props - 共享会话状态与标签操作。
 * @returns 标签栏。
 */
export function BrowserTabs({ shown, closeBrowser, useBrowserMirror, command, t }: BrowserTabsProps) {
  const { state, pending, phase } = useBrowserMirror(view => view)
  const disabled = pending || phase === 'busy' || state?.operationActive === true
  const focusAfterAction = useRef<string | null>(null)
  const tabButtons = useRef(new Map<string, HTMLButtonElement>())
  const addButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (focusAfterAction.current === null || pending) return
    if (phase === 'error') { focusAfterAction.current = null; return }
    const requested = focusAfterAction.current
    if (requested === 'new' && state?.activeTabId) {
      tabButtons.current.get(state.activeTabId)?.focus()
    } else if (requested === 'active' && state?.activeTabId) {
      tabButtons.current.get(state.activeTabId)?.focus()
    } else if (requested !== 'new' && requested !== 'active') {
      ;(tabButtons.current.get(requested) ?? addButton.current)?.focus()
    } else addButton.current?.focus()
    focusAfterAction.current = null
  }, [state, pending, phase])
  return <div className={css.tabs} hidden={!shown} role="tablist" aria-label={t('tabs')}>
    {state?.tabs.map((tab, index) => {
      const selected = tab.id === state.activeTabId
      return <div className={css.tab} data-active={selected} key={tab.id}>
        <button type="button" className={css.tabSelect} role="tab" aria-selected={selected}
          ref={(node) => { if (node) tabButtons.current.set(tab.id, node); else tabButtons.current.delete(tab.id) }}
          disabled={disabled} title={disabled ? t('agentBusy') : tab.title || tab.url}
          onClick={() => { if (!selected) void command({ kind: 'select-tab', tabId: tab.id }) }}>
          <span className={css.tabGlyph} aria-hidden="true">
            {selected && state.observation?.cursor ? <AgentPointer /> : <IconGlobeOutline14 />}
          </span>
          <span className={css.tabName}>{tab.title || (tab.url === 'about:blank' ? t('newTab') : tab.url)}</span>
        </button>
        <button type="button" className={css.tabClose} disabled={disabled}
          aria-label={t('closeTab', { name: tab.title || t('newTab') })}
          title={t('closeTab', { name: tab.title || t('newTab') })}
          onClick={() => {
            focusAfterAction.current = state.tabs[index + 1]?.id ?? state.tabs[index - 1]?.id ?? 'active'
            void command({ kind: 'close-tab', tabId: tab.id }).then((success) => {
              if (!success) { focusAfterAction.current = null; return }
              if (state.tabs.length === 1) { focusAfterAction.current = null; closeBrowser() }
            })
          }}><IconCloseOutline16 size={12} /></button>
      </div>
    })}
    <button type="button" ref={addButton} className={css.addTab} disabled={disabled} aria-label={t('addTab')}
      title={disabled ? t('agentBusy') : t('addTab')} onClick={() => {
        focusAfterAction.current = 'new'
        void command({ kind: 'new-tab' }).then((success) => { if (!success) focusAfterAction.current = null })
      }}><IconPlusOutline16 size={14} /></button>
  </div>
}

/**
 * 地址栏、空标签与截图画布。
 * @param props - 工作台 owner、词典和状态 hook。
 * @returns 浏览器内容区域。
 */
export function BrowserMirror({ shown, openBrowser, useBrowserMirror, start, ensureTab, command, retry, t }: BrowserMirrorProps) {
  const view = useBrowserMirror(value => value)
  const phaseRef = useRef(view.phase)
  phaseRef.current = view.phase
  const openRef = useRef(openBrowser)
  openRef.current = openBrowser
  useEffect(() => start(() => { openRef.current() }), [start])
  // 每次由菜单进入仅等待一次明确基线；已有标签会消耗机会，关闭后的 empty 不会重建。
  const entry = useRef({ shown: false, awaitingState: false })
  useEffect(() => {
    if (!shown) {
      entry.current.shown = false
      entry.current.awaitingState = false
      return
    }
    if (!entry.current.shown) {
      entry.current.shown = true
      entry.current.awaitingState = true
    }
    if (!entry.current.awaitingState) return
    if (view.state !== null) {
      entry.current.awaitingState = false
    } else if (view.phase === 'empty') {
      entry.current.awaitingState = false
      void ensureTab()
    }
  }, [shown, view.phase, view.state, ensureTab])
  const active = view.state?.tabs.find(tab => tab.id === view.state?.activeTabId)
  const agentBusy = view.phase === 'busy' || view.state?.operationActive === true
  const controlsDisabled = view.pending || agentBusy
  const tabId = active?.id ?? null
  const browserGeneration = view.state?.browserGeneration ?? null
  const canvasRef = useRef<HTMLDivElement>(null)
  const observerEpoch = useRef(0)
  const lastViewportAttempt = useRef<string | null>(null)
  const viewportRetryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const viewportRetryCount = useRef(0)
  const viewportTarget = useRef<string | null>(null)
  const [viewportRetryRevision, setViewportRetryRevision] = useState(0)
  const [desiredViewport, setDesiredViewport] = useState<(BrowserViewport & { epoch: number }) | null>(null)
  function clearViewportRetry(): void {
    if (viewportRetryTimer.current !== undefined) clearTimeout(viewportRetryTimer.current)
    viewportRetryTimer.current = undefined
  }
  useEffect(() => {
    const epoch = ++observerEpoch.current
    if (!shown || tabId === null || browserGeneration === null || canvasRef.current === null
      || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const next = fitBrowserViewport(entry.contentRect.width, entry.contentRect.height)
      if (next === null) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        if (observerEpoch.current !== epoch) return
        setDesiredViewport(previous => previous?.epoch === epoch
          && previous.width === next.width && previous.height === next.height
          ? previous : { ...next, epoch })
      }, 200)
    })
    observer.observe(canvasRef.current)
    return () => {
      ++observerEpoch.current
      observer.disconnect()
      if (timer !== undefined) clearTimeout(timer)
      clearViewportRetry()
      lastViewportAttempt.current = null
      viewportRetryCount.current = 0
      viewportTarget.current = null
    }
  }, [shown, tabId, browserGeneration])
  const currentViewport = view.state?.viewport
  const stateRevision = view.state?.stateRevision
  useEffect(() => {
    if (!shown || tabId === null || browserGeneration === null || desiredViewport === null
      || desiredViewport.epoch !== observerEpoch.current || view.pending || view.phase !== 'ready'
      || currentViewport === undefined) return
    if (agentBusy) {
      clearViewportRetry()
      viewportRetryCount.current = 0
      lastViewportAttempt.current = null
      return
    }
    const target = `${String(desiredViewport.epoch)}:${String(desiredViewport.width)}x${String(desiredViewport.height)}`
    if (viewportTarget.current !== target) {
      clearViewportRetry()
      viewportTarget.current = target
      viewportRetryCount.current = 0
      lastViewportAttempt.current = null
    }
    if (currentViewport.width === desiredViewport.width && currentViewport.height === desiredViewport.height) {
      clearViewportRetry()
      viewportRetryCount.current = 0
      return
    }
    if (viewportRetryTimer.current !== undefined || viewportRetryCount.current >= 4) return
    const attempt = `${String(desiredViewport.epoch)}:${String(stateRevision)}:${String(desiredViewport.width)}x${String(desiredViewport.height)}`
    if (lastViewportAttempt.current === attempt) return
    lastViewportAttempt.current = attempt
    viewportRetryCount.current++
    const failed = () => {
      if (observerEpoch.current !== desiredViewport.epoch || lastViewportAttempt.current !== attempt) return
      lastViewportAttempt.current = null
      // 同目标最多三次自动补发；显式重试或新尺寸重新取得完整预算。
      if (viewportRetryCount.current >= 4) return
      const delay = 800 * 2 ** (viewportRetryCount.current - 1)
      viewportRetryTimer.current = setTimeout(() => {
        viewportRetryTimer.current = undefined
        if (observerEpoch.current !== desiredViewport.epoch) return
        if (phaseRef.current === 'error') retry()
        setViewportRetryRevision(previous => previous + 1)
      }, delay)
    }
    void command({ kind: 'set-viewport', width: desiredViewport.width, height: desiredViewport.height })
      .then((success) => { if (success) viewportRetryCount.current = 0; else failed() }, failed)
  }, [shown, tabId, browserGeneration, desiredViewport, view.pending, view.phase, agentBusy,
    currentViewport?.width, currentViewport?.height, stateRevision, command, retry, viewportRetryRevision])
  const address = active?.url === 'about:blank' ? '' : active?.url ?? ''
  const addressRef = useRef<HTMLInputElement>(null)
  const [addressFocused, setAddressFocused] = useState(false)
  const [draft, setDraft] = useState<{
    value: string
    dirty: boolean
    submitted: string | null
    tabId: string | null
  }>({
    value: '', dirty: false, submitted: null, tabId: null,
  })
  const [inputError, setInputError] = useState<string | null>(null)
  const ownDraft = draft.tabId === tabId ? draft : null
  useEffect(() => {
    if (addressFocused && addressRef.current !== document.activeElement) setAddressFocused(false)
  }, [view.pending, tabId, address])
  useEffect(() => {
    if (ownDraft?.submitted !== address) return
    // disabled 会在部分浏览器移走焦点却不派发 blur；Host 对账后以真实焦点为准。
    if (addressRef.current !== document.activeElement) setAddressFocused(false)
    setDraft(previous => previous.tabId === tabId && previous.submitted === address
      ? { ...previous, dirty: false, submitted: null } : previous)
  }, [ownDraft?.submitted, address, tabId])
  const compactAddress = address !== '' && !addressFocused && !ownDraft?.dirty && inputError === null
  const inputValue = ownDraft?.dirty
    ? ownDraft.value : compactAddress ? new URL(address).hostname : address
  useLayoutEffect(() => {
    const input = addressRef.current
    if (input === null || addressFocused && input === document.activeElement && !view.pending) return
    if (input.value !== inputValue) input.value = inputValue
  }, [inputValue, addressFocused, view.pending])
  const cursor = view.state?.observation?.cursor
  const observation = view.state?.observation
  const frameRef = useRef<HTMLImageElement>(null)
  const frameActionRef = useRef<HTMLButtonElement>(null)
  const [loadedFrame, setLoadedFrame] = useState<string | null>(null)
  const frameReady = view.phase === 'ready' && view.state.hasFrame && view.frameUrl !== null && loadedFrame === view.frameUrl
    && frameRef.current?.complete === true && frameRef.current.naturalWidth === observation?.viewport.width
    && frameRef.current.naturalHeight === observation.viewport.height
    && view.state.viewport.width === observation.viewport.width
    && view.state.viewport.height === observation.viewport.height
    && view.state.activeTabId === observation.tabId
    && active?.generation === observation.generation
  const [typeMode, setTypeMode] = useState(false)
  const [typeTarget, setTypeTarget] = useState<{ target: BrowserHumanTarget; x: number; y: number } | null>(null)
  const [typeText, setTypeText] = useState('')
  const typeInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (typeTarget) typeInputRef.current?.focus() }, [typeTarget])
  useEffect(() => { setTypeTarget(null); setTypeText('') }, [view.state?.stateRevision, view.frameUrl])
  function targetAt(event: MouseEvent<HTMLButtonElement> | WheelEvent) {
    if (!frameReady || controlsDisabled) return null
    const img = frameRef.current
    const rect = img.getBoundingClientRect()
    const keyboardClick = event.type === 'click' && event.detail === 0
    const clientX = keyboardClick ? rect.left + rect.width / 2 : event.clientX
    const clientY = keyboardClick ? rect.top + rect.height / 2 : event.clientY
    const point = pointOnFrame(clientX, clientY, rect, observation.viewport)
    if (!point) return null
    const target: BrowserHumanTarget = { browserGeneration: view.state.browserGeneration,
      stateRevision: view.state.stateRevision, tabId: observation.tabId,
      generation: observation.generation, revision: observation.revision,
      viewport: observation.viewport }
    return { ...point, target }
  }
  function clickFrame(event: MouseEvent<HTMLButtonElement>) {
    const point = targetAt(event)
    if (!point) return
    if (typeMode) { setTypeTarget(point); setTypeMode(false); return }
    void command({ kind: 'click', ...point })
  }
  function scrollFrame(event: WheelEvent) {
    const point = targetAt(event)
    if (!point || event.deltaY === 0) return
    void command({ kind: 'scroll', ...point,
      direction: event.deltaY < 0 ? 'up' : 'down', pixels: Math.min(2000, Math.max(1, Math.round(Math.abs(event.deltaY)))) })
  }
  useEffect(() => {
    const button = frameActionRef.current
    if (button === null) return
    const onWheel = (event: WheelEvent) => {
      const img = frameRef.current
      if (img === null) return
      const rect = img.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX >= rect.right
        || event.clientY < rect.top || event.clientY >= rect.bottom) return
      event.preventDefault()
      scrollFrame(event)
    }
    button.addEventListener('wheel', onWheel, { passive: false })
    return () => { button.removeEventListener('wheel', onWheel) }
  })
  function typeAtPoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!typeTarget || !typeText || controlsDisabled) return
    void command({ kind: 'type', ...typeTarget, text: typeText })
    setTypeTarget(null)
    setTypeText('')
  }
  const operation = cursor === null || cursor === undefined ? null : t(cursor.kind)
  const pulse = cursor !== null && cursor !== undefined && Date.now() - cursor.at < 1200
  function navigate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (controlsDisabled) return
    try {
      const url = normalizeBrowserUrl(addressRef.current?.value ?? '')
      setInputError(null)
      setDraft({ value: url, dirty: true, submitted: url, tabId })
      void command({ kind: 'navigate', url })
    } catch {
      setInputError(t('invalidUrl'))
    }
  }
  return <section className={css.root} hidden={!shown} aria-label={t('label')}>
    <div className={css.toolbar}>
      <div className={css.history}>
        <button type="button" aria-label={t('back')} title={agentBusy ? t('agentBusy') : t('back')} disabled={!active?.canGoBack || controlsDisabled}
          onClick={() => { void command({ kind: 'back' }) }}><IconChevronLeftOutline14 /></button>
        <button type="button" aria-label={t('forward')} title={agentBusy ? t('agentBusy') : t('forward')} disabled={!active?.canGoForward || controlsDisabled}
          onClick={() => { void command({ kind: 'forward' }) }}><IconChevronRightOutline14 /></button>
        <button type="button" aria-label={t('reload')} title={agentBusy ? t('agentBusy') : t('reload')} disabled={!active || active.url === 'about:blank' || controlsDisabled}
          onClick={() => { void command({ kind: 'reload' }) }}><IconRefreshOutline16 size={14} /></button>
      </div>
      <form className={css.address} data-compact={compactAddress} onSubmit={navigate}>
        <label className={css.srOnly} htmlFor="browser-address">{t('address')}</label>
        <input id="browser-address" ref={addressRef} type="text" inputMode="url" autoComplete="url" spellCheck={false}
          placeholder={t('addressPlaceholder')} disabled={controlsDisabled}
          onFocus={(event) => {
            // 先同步换成完整 URL，随后 fill/全选只操作原生 input；React 不争写正在输入的值。
            if (!ownDraft?.dirty) {
              event.currentTarget.value = address
              event.currentTarget.select()
            }
            setAddressFocused(true)
          }}
          onChange={(event) => {
            setDraft({ value: event.target.value, dirty: true, submitted: null, tabId })
            setInputError(null)
          }}
          onBlur={() => { setAddressFocused(false) }}
          aria-invalid={inputError !== null} aria-describedby={inputError ? 'browser-address-error' : undefined} />
        <button type="submit" disabled={controlsDisabled} aria-label={t('go')} title={agentBusy ? t('agentBusy') : t('go')}>
          <IconChevronRightOutline14 />
        </button>
      </form>
      <button type="button" className={css.typeMode} data-active={typeMode}
        disabled={!frameReady || controlsDisabled} aria-pressed={typeMode}
        title={agentBusy ? t('agentBusy') : t('typeModeHint')}
        onClick={() => { setTypeMode(previous => !previous); setTypeTarget(null) }}>{t('typeMode')}</button>
    </div>
    <div className={css.body} ref={canvasRef} data-testid="browser-canvas">
      {inputError && <p id="browser-address-error" className={css.inputError} role="alert">{inputError}</p>}
      {view.pending && <p role="status" className={css.pending}>{t('pending')}</p>}
      {agentBusy && view.phase !== 'busy' && <p role="status" className={css.busyNotice}>{t('agentBusy')}</p>}
      {view.phase === 'loading' && <p role="status" className={css.message}>{t('loading')}</p>}
      {view.phase === 'busy' && <p className={css.message} role="status">{t('agentBusy')}</p>}
      {(view.phase === 'empty' || view.phase === 'ready' && (!active || active.url === 'about:blank')) && <div className={css.blank}>
        <span className={css.blankGlobe} aria-hidden="true"><IconGlobeOutline14 size={40} /></span>
        <h2>{t('startBrowsing')}</h2><p>{t('emptyHint')}</p>
      </div>}
      {view.phase === 'error' && <div className={css.message} role="alert">
        <span>{t('error')}: {view.message}</span><button type="button" onClick={() => {
          clearViewportRetry()
          viewportRetryCount.current = 0
          lastViewportAttempt.current = null
          retry()
          setViewportRetryRevision(previous => previous + 1)
        }}>{t('retry')}</button>
      </div>}
      {view.phase === 'ready' && active && active.url !== 'about:blank' && <div className={css.canvas}>
        {view.frameUrl !== null && observation && <div className={css.viewport}
          style={{ width: observation.viewport.width,
            aspectRatio: `${observation.viewport.width} / ${observation.viewport.height}` }}>
          <button ref={frameActionRef} type="button" className={css.frameAction} disabled={!frameReady || controlsDisabled}
            aria-label={typeMode ? t('selectTypeTarget') : t('clickPage')}
            title={agentBusy ? t('agentBusy') : typeMode ? t('selectTypeTarget') : t('clickPage')}
            onClick={clickFrame}>
            <img ref={frameRef} className={css.frame} src={view.frameUrl} alt={t('frame')} draggable={false}
              onLoad={() => { setLoadedFrame(view.frameUrl) }} onError={() => { setLoadedFrame(null) }} />
          </button>
          {cursor && <span className={css.cursor} data-pulse={pulse ? 'true' : 'false'}
            style={{ left: `${cursor.x / observation.viewport.width * 100}%`,
              top: `${cursor.y / observation.viewport.height * 100}%` }}
            aria-label={operation ?? undefined} role="img"><span className={css.pointer} /><span className={css.ripple} /></span>}
        </div>}
        {typeTarget && <form className={css.typeOverlay} onSubmit={typeAtPoint}>
          <label htmlFor="browser-page-text">{t('typeAtPoint')}</label>
          <input ref={typeInputRef} id="browser-page-text" value={typeText} maxLength={2000}
            disabled={controlsDisabled} onChange={(event) => { setTypeText(event.target.value) }} />
          <button type="submit" disabled={!typeText || controlsDisabled}>{t('insertText')}</button>
          <button type="button" onClick={() => { setTypeTarget(null) }}>{t('cancel')}</button>
        </form>}
        {view.frameUrl === null && <p className={css.message}>{t('noFrame')}</p>}
      </div>}
    </div>
  </section>
}
