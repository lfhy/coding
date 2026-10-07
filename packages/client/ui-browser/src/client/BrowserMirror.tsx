/** 桌面端让原生 guest 覆盖占位区；普通 Web 仍只展示 Host PNG。 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import {
  IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconGlobeOutline14, IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-icons'
import type { BrowserHumanCommand, BrowserHumanTarget } from '@deepseek-ai/dsh-browser/types'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-open-in-app/client'
import { desktopBrowserPresentation, type BrowserView } from './controller.ts'
import { fitBrowserViewport, type BrowserViewport } from './viewport.ts'
import { pointOnFrame } from './interaction.ts'
import { normalizeBrowserUrl, type BrowserState } from './wire.ts'
import { NS } from './locales.ts'
import css from './BrowserMirror.module.css'

/** 两个 slot 共用同一个会话控制器，但只让内容 slot 持有轮询。 */
export interface BrowserMirrorInjected {
  hooks: { browserMirror: HostObservable<BrowserView> }
  start: () => () => void
  ensureTab: () => Promise<void>
  command: (command: BrowserHumanCommand) => Promise<boolean>
  openUrl: (url: string) => Promise<BrowserState>
  registerLinkOpener: (sessionId: string, open: (url: string, pendingId: string, isCurrent: () => boolean,
    shouldReveal: () => boolean, click: { interactionEpoch: number; selectedTabId?: string }) => Promise<void>,
    begin: (id: string, url: string) => void,
    clear: () => void,
    clickState: () => { interactionEpoch: number; selectedTabId?: string }) => () => void
  retryLink: (url: string, pendingId: string) => Promise<void>
  retry: () => void
}
export type BrowserMirrorProps = PropsRuntime<'workbench.browser'> & PropsLocale<typeof NS> & InjectFace<BrowserMirrorInjected>
export type BrowserTabsProps = PropsRuntime<'workbench.browser.tabs'> & PropsLocale<typeof NS> & InjectFace<BrowserMirrorInjected>

function browserTabNames(state: BrowserState, t: BrowserMirrorProps['t']) {
  return state.tabs.map(tab => ({
    id: tab.id, name: tab.title || (tab.url === 'about:blank' ? t('newTab') : tab.url),
  }))
}

const STOPPED_NAVIGATION_DIAGNOSTIC = 'browser navigation timed out; loading stopped, take a new snapshot of the current page'

type NavigationRevealTarget = { tabId: string | null }

function navigationRevealTarget(call: ToolCallBlock, native: boolean): NavigationRevealTarget | null {
  if (!('kind' in call) || call.call?.name !== 'browser_navigate') return null
  const text = call.content.find(block => block.type === 'text')
  if (text?.type !== 'text') return null
  if (call.isError) {
    if (!native) return null
    const diagnostic = text.text.startsWith('Error: ') ? text.text.slice('Error: '.length) : text.text
    return diagnostic === STOPPED_NAVIGATION_DIAGNOSTIC ? { tabId: null } : null
  }
  try {
    const value: unknown = JSON.parse(text.text)
    if (typeof value !== 'object' || value === null || !('action' in value) || value.action !== 'navigate'
      || !('observation' in value) || typeof value.observation !== 'object' || value.observation === null
      || !('tabId' in value.observation) || typeof value.observation.tabId !== 'string'
      || value.observation.tabId.length === 0) return null
    return { tabId: value.observation.tabId }
  } catch { return null }
}

function AgentPointer() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path className={css.agentPointerFill} d="M2.75 1.5v12.7l3.48-3.3 2.2 4.1 2.22-1.14-2.2-4.08 4.64-.8L2.75 1.5Z"
      stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
}

function focusWorkbenchTab(row: Element | null): void {
  queueMicrotask(() => {
    if (!row?.isConnected) return
    const button = row.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]:not(:disabled)')
      ?? row.querySelector<HTMLButtonElement>('[role="tab"]:not(:disabled)')
      ?? row.querySelector<HTMLButtonElement>('button:not(:disabled)')
    button?.focus()
  })
}

function frameMatchesViewport(frame: HTMLImageElement | null, viewport: BrowserViewport): boolean {
  if (frame === null) return false
  return frame.naturalWidth === viewport.width && frame.naturalHeight === viewport.height
    || frame.naturalWidth === viewport.width * 2 && frame.naturalHeight === viewport.height * 2
}

/**
 * 向工作台统一标签行贡献一个浏览器页面；新增功能由工作台统一入口负责。
 * @param props - 共享会话状态、所属页面与标签操作。
 * @returns 页面标签；没有页面 id 时不渲染。
 */
export function BrowserTabs({ shown, browserShown = shown, tabId, tabName, tabDomId, panelDomId,
  pendingBrowserLink, openBrowser, selectPendingBrowserLink, closePendingBrowserLink,
  focusPendingBrowserTab, useBrowserMirror, command, t }: BrowserTabsProps) {
  const { state, pending, phase } = useBrowserMirror(view => view)
  const hostTab = state?.tabs.find(tab => tab.id === tabId)
  const tab = hostTab ?? (state === null
    ? { id: tabId, title: tabName ?? t('newTab'), url: 'about:blank' } : undefined)
  const disabled = pending || phase === 'busy' || state?.operationActive === true
    || state === null
  const selected = browserShown
  useEffect(() => {
    if (shown && !disabled && tabId !== undefined) focusPendingBrowserTab(tabId)
  }, [shown, disabled, tabId, focusPendingBrowserTab])
  if (pendingBrowserLink !== undefined) return <div className={css.tabs} hidden={!shown}>
    <div className={css.tab} data-active={browserShown}>
      <button type="button" className={css.tabSelect} role="tab" aria-selected={browserShown}
        data-browser-pending-id={pendingBrowserLink.id} id={tabDomId} aria-controls={panelDomId}
        tabIndex={browserShown ? 0 : -1} title={pendingBrowserLink.url}
        onClick={() => { selectPendingBrowserLink(pendingBrowserLink.id) }}>
        <span className={css.tabGlyph} aria-hidden="true"><IconGlobeOutline14 /></span>
        <span className={css.tabName}>{pendingBrowserLink.url}</span>
      </button>
      <button type="button" className={css.tabClose} disabled={pendingBrowserLink.error === undefined}
        aria-label={pendingBrowserLink.error === undefined ? t('linkClosingUnavailable')
          : t('closeTab', { name: pendingBrowserLink.url })}
        title={pendingBrowserLink.error === undefined ? t('linkClosingUnavailable')
          : t('closeTab', { name: pendingBrowserLink.url })}
        onClick={() => { closePendingBrowserLink(pendingBrowserLink.id) }}><IconCloseOutline16 size={12} /></button>
    </div>
  </div>
  if (tabId === undefined) return null
  return <div className={css.tabs} hidden={!shown}>
    {tab !== undefined && <div className={css.tab} data-active={selected}>
      <button type="button" className={css.tabSelect} role="tab" aria-selected={selected}
        data-browser-tab-id={tab.id} id={tabDomId} aria-controls={panelDomId}
        tabIndex={selected ? 0 : -1}
        disabled={disabled} title={disabled ? t('agentBusy') : tab.title || tab.url}
        onClick={() => {
          if (hostTab === undefined) return
          openBrowser(hostTab.id)
          if (hostTab.id !== state?.activeTabId) void command({ kind: 'select-tab', tabId: hostTab.id })
        }}>
        <span className={css.tabGlyph} aria-hidden="true">
          {selected && state?.observation?.cursor ? <AgentPointer /> : <IconGlobeOutline14 />}
        </span>
        <span className={css.tabName}>{tab.title || (tab.url === 'about:blank' ? t('newTab') : tab.url)}</span>
      </button>
      <button type="button" className={css.tabClose} disabled={disabled}
        aria-label={t('closeTab', { name: tab.title || t('newTab') })}
        title={t('closeTab', { name: tab.title || t('newTab') })}
        onClick={(event) => {
          if (hostTab === undefined) return
          const row = event.currentTarget.closest('[role="tablist"]')
          void command({ kind: 'close-tab', tabId: hostTab.id }).then((success) => {
            if (success) focusWorkbenchTab(row)
          })
        }}><IconCloseOutline16 size={12} /></button>
    </div>}
  </div>
}

/**
 * 地址栏、空标签与截图画布。
 * @param props - 工作台 owner、词典和状态 hook。
 * @returns 浏览器内容区域。
 */
export function BrowserMirror({ sessionId, shown, selectedTabId, newTabRequest, handledTabRequest,
  markTabRequestHandled, syncBrowserTabs, focusBrowserTab, openBrowser, useSession,
  pendingBrowserLink, beginBrowserLink, completeBrowserLink, failBrowserLink, clearBrowserLinks,
  interactionEpoch, browserAutoRevealed, requestAutoReveal, autoRevealBrowser,
  useBrowserMirror, start, ensureTab, command, openUrl, registerLinkOpener, retryLink, retry, t }: BrowserMirrorProps) {
  const nodes = useSession(snapshot => snapshot.nodes)
  const runningCalls = useSession(snapshot => snapshot.runningCalls)
  const openState = useSession(snapshot => snapshot.openState)
  const nativePresenter = desktopBrowserPresentation()
  const native = nativePresenter !== null
  const view = useBrowserMirror(value => value)
  const viewRef = useRef(view)
  viewRef.current = view
  const phaseRef = useRef(view.phase)
  phaseRef.current = view.phase
  useEffect(() => start(), [start])
  const linkOwner = useRef({ syncBrowserTabs, openBrowser, t, openUrl, beginBrowserLink, clearBrowserLinks,
    completeBrowserLink, failBrowserLink, interactionEpoch, selectedTabId })
  linkOwner.current = { syncBrowserTabs, openBrowser, t, openUrl, beginBrowserLink, clearBrowserLinks,
    completeBrowserLink, failBrowserLink, interactionEpoch, selectedTabId }
  const linkOpening = useRef(false)
  const linkRevealTab = useRef<string | null>(null)
  const manualLinkChoice = useRef<{ tabId: string; epoch: number } | null>(null)
  const supersededLinkChoice = useRef<{ tabId: string; epoch: number } | null>(null)
  const activeLinkIntent = useRef<{ click: { interactionEpoch: number; selectedTabId?: string }
    shouldReveal: () => boolean } | null>(null)
  const [linkSettlement, setLinkSettlement] = useState(0)
  useEffect(() => registerLinkOpener(sessionId, async (url, pendingId, isCurrent, shouldReveal, click) => {
    activeLinkIntent.current = { click, shouldReveal }
    linkOpening.current = true
    try {
      const state = await linkOwner.current.openUrl(url)
      if (!isCurrent()) throw new Error('会话已切换，请在当前会话重试')
      const activeId = state.activeTabId
      if (activeId === null) throw new Error('浏览器未返回活动页面，请刷新后重试')
      const owner = linkOwner.current
      const changed = owner.interactionEpoch !== click.interactionEpoch
      const latest = shouldReveal()
      const selected = changed ? owner.selectedTabId : click.selectedTabId
      const preservedTabId = (changed || !latest) && selected !== undefined
        && state.tabs.some(tab => tab.id === selected) ? selected : null
      if (changed && preservedTabId !== null) {
        manualLinkChoice.current = { tabId: preservedTabId, epoch: owner.interactionEpoch }
      } else if (latest) {
        manualLinkChoice.current = null
      }
      if (!changed && !latest && preservedTabId !== null) {
        supersededLinkChoice.current = { tabId: preservedTabId, epoch: owner.interactionEpoch }
      } else if (latest) supersededLinkChoice.current = null
      if (!changed && latest) linkRevealTab.current = activeId
      owner.syncBrowserTabs(browserTabNames(state, owner.t), preservedTabId ?? activeId)
      owner.completeBrowserLink(pendingId, activeId)
    } catch (error) {
      if (isCurrent()) linkOwner.current.failBrowserLink(pendingId, error instanceof Error ? error.message : String(error))
      if (shouldReveal() && supersededLinkChoice.current?.epoch === linkOwner.current.interactionEpoch) {
        manualLinkChoice.current = supersededLinkChoice.current
        supersededLinkChoice.current = null
      }
      throw error
    } finally {
      linkOpening.current = false
      activeLinkIntent.current = null
      if (manualLinkChoice.current !== null && isCurrent()) setLinkSettlement(previous => previous + 1)
    }
  }, (id, url) => { linkOwner.current.beginBrowserLink(id, url) },
  () => { linkOwner.current.clearBrowserLinks() },
  () => ({ interactionEpoch: linkOwner.current.interactionEpoch,
    ...linkOwner.current.selectedTabId === undefined ? {} : { selectedTabId: linkOwner.current.selectedTabId } })),
  [sessionId, registerLinkOpener])
  const observed = useRef<{ ready: boolean; seq: number; pending: (NavigationRevealTarget & { epoch: number }) | null }>({
    ready: false, seq: 0, pending: null,
  })
  useEffect(() => {
    if (openState !== 'open') return
    const tracked = observed.current
    const cutoff = tracked.ready ? tracked.seq : 0
    const found = { latestSeq: cutoff, seq: cutoff, target: null as NavigationRevealTarget | null }
    const visit = (call: ToolCallBlock): void => {
      for (const child of call.subCalls) visit(child)
      if (!('kind' in call)) return
      found.latestSeq = Math.max(found.latestSeq, call.seq)
      if (call.seq <= cutoff) return
      const target = navigationRevealTarget(call, native)
      if (target !== null && call.seq > found.seq) {
        found.seq = call.seq
        found.target = target
      }
    }
    // 历史首次建立水位；后续只读新追加的尾部及仍在执行的调用树。
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index]
      if (node === undefined) break
      if (tracked.ready && node.seq <= cutoff) break
      if (node.kind === 'tool-result') visit(node)
    }
    for (const call of runningCalls) visit(call)
    if (!tracked.ready) {
      tracked.ready = true
      tracked.seq = found.latestSeq
      return
    }
    tracked.seq = found.latestSeq
    if (found.target !== null) {
      tracked.pending = { ...found.target, epoch: interactionEpoch }
    }
  }, [nodes, runningCalls, openState, interactionEpoch, native])
  useEffect(() => {
    if (linkOpening.current) return
    if (view.state !== null) {
      const choice = manualLinkChoice.current
      if (choice !== null && choice.epoch !== interactionEpoch) manualLinkChoice.current = null
      const superseded = supersededLinkChoice.current
      if (superseded !== null && superseded.epoch !== interactionEpoch) supersededLinkChoice.current = null
      const intent = activeLinkIntent.current
      const intentTabId = intent === null ? undefined
        : intent.click.interactionEpoch !== interactionEpoch ? linkOwner.current.selectedTabId
          : !intent.shouldReveal() ? intent.click.selectedTabId : undefined
      const preferred = choice?.epoch === interactionEpoch ? choice.tabId
        : superseded?.epoch === interactionEpoch ? superseded.tabId : intentTabId ?? null
      const selected = preferred !== null && view.state.tabs.some(tab => tab.id === preferred)
        ? preferred : view.state.activeTabId
      syncBrowserTabs(browserTabNames(view.state, t), selected)
      if (view.state.activeTabId === choice?.tabId) manualLinkChoice.current = null
    } else if (view.phase === 'empty') syncBrowserTabs([], null)
  }, [view.state, view.phase, syncBrowserTabs, t, interactionEpoch])
  useEffect(() => {
    const pending = observed.current.pending
    if (pending === null) return
    if (pending.epoch !== interactionEpoch) { observed.current.pending = null; return }
    const targetTabId = pending.tabId ?? view.state?.activeTabId
    if (targetTabId === null || targetTabId === undefined || view.state?.activeTabId !== targetTabId
      || !view.state.tabs.some(tab => tab.id === targetTabId)) return
    observed.current.pending = null
    if (!requestAutoReveal(pending.epoch)) return
    autoRevealBrowser(targetTabId, pending.epoch)
  }, [view, nodes, runningCalls, interactionEpoch, requestAutoReveal, autoRevealBrowser])
  // 只响应工作台选中页变化；Host 新画面交给同步投影，避免旧选择反抢模型刚打开的页。
  const manualHostTabId = manualLinkChoice.current === null ? undefined : view.state?.activeTabId
  const manualHostPending = manualLinkChoice.current === null ? undefined : view.pending
  const manualHostPhase = manualLinkChoice.current === null ? undefined : view.phase
  const manualHostBusy = manualLinkChoice.current === null ? undefined : view.state?.operationActive
  useEffect(() => {
    const current = viewRef.current
    if (linkRevealTab.current === selectedTabId) linkRevealTab.current = null
    if (linkOpening.current || linkRevealTab.current !== null) return
    const manual = manualLinkChoice.current
    if (manual !== null && manual.epoch === interactionEpoch && manual.tabId === selectedTabId) {
      if (current.phase === 'ready' && !current.pending && !current.state.operationActive
        && current.state.activeTabId !== manual.tabId) {
        const target = current.state.tabs.find(tab => tab.id === manual.tabId)
        if (target !== undefined) void command({ kind: 'select-tab', tabId: target.id })
      }
      return
    }
    if (!shown || browserAutoRevealed || selectedTabId === undefined || current.phase !== 'ready' || current.pending
      || current.state.operationActive || current.state.activeTabId === selectedTabId) return
    const target = current.state.tabs.find(tab => tab.id === selectedTabId)
    if (target !== undefined) void command({ kind: 'select-tab', tabId: target.id })
  }, [shown, selectedTabId, browserAutoRevealed, command, linkSettlement, interactionEpoch,
    manualHostTabId, manualHostPending, manualHostPhase, manualHostBusy])
  // 每次由菜单进入仅等待一次明确基线；已有标签会消耗机会，关闭后的 empty 不会重建。
  const entry = useRef({ shown: false, awaitingState: false })
  const issuedTabRequest = useRef(handledTabRequest)
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
    if (newTabRequest > issuedTabRequest.current) {
      entry.current.awaitingState = false
      return
    }
    if (pendingBrowserLink !== undefined || view.state !== null) {
      entry.current.awaitingState = false
    } else if (view.phase === 'empty') {
      entry.current.awaitingState = false
      void ensureTab()
    }
  }, [shown, view.phase, view.state, ensureTab, newTabRequest, pendingBrowserLink])
  useEffect(() => {
    if (!shown || newTabRequest <= issuedTabRequest.current || view.phase === 'loading'
      || view.phase === 'busy' || view.pending || view.state?.operationActive) return
    issuedTabRequest.current += 1
    markTabRequestHandled(issuedTabRequest.current)
    void command({ kind: 'new-tab' }).then((success) => {
      const activeTabId = viewRef.current.state?.activeTabId
      if (success && activeTabId !== null && activeTabId !== undefined) focusBrowserTab(activeTabId)
    })
  }, [shown, newTabRequest, view.phase, view.pending, view.state?.operationActive,
    command, focusBrowserTab, markTabRequestHandled])
  const active = view.state?.tabs.find(tab => tab.id === view.state?.activeTabId)
  const awaitingSelectedTab = shown && view.phase === 'ready' && selectedTabId !== undefined
    && active?.id !== selectedTabId
  const agentBusy = view.phase === 'busy' || view.state?.operationActive === true
  const controlsDisabled = view.pending || agentBusy || awaitingSelectedTab || pendingBrowserLink !== undefined
  const tabId = active?.id ?? null
  const browserGeneration = view.state?.browserGeneration ?? null
  const canvasRef = useRef<HTMLDivElement>(null)
  const [inputError, setInputError] = useState<string | null>(null)
  const nativeNotice = native && pendingBrowserLink === undefined && (inputError !== null || view.pending && !awaitingSelectedTab
    || agentBusy && view.phase !== 'busy')
  useLayoutEffect(() => {
    if (nativePresenter === null || tabId === null || !shown || view.phase !== 'ready'
      || awaitingSelectedTab || pendingBrowserLink !== undefined) return
    const canvas = canvasRef.current
    if (canvas === null) return
    let previous = ''
    const send = (visible: boolean, bounds = { x: 0, y: 0, width: 0, height: 0 }) => {
      const key = `${String(visible)}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
      if (key === previous) return
      previous = key
      // IPC 的完成顺序不决定呈现顺序；旧响应不能再提交先前的尺寸。
      try { void nativePresenter.present({ sessionId, tabId, bounds, visible }).catch(() => {}) }
      catch { /* 页面卸载期间的同步拒绝不重新显示旧 guest。 */ }
    }
    const measure = () => {
      const rect = canvas.getBoundingClientRect()
      const left = Math.max(0, Math.floor(rect.left))
      const top = Math.max(0, Math.floor(rect.top))
      const right = Math.min(window.innerWidth, Math.ceil(rect.right))
      const bottom = Math.min(window.innerHeight, Math.ceil(rect.bottom))
      const width = right - left
      const height = bottom - top
      const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
        .some(dialog => dialog.closest('[hidden], [aria-hidden="true"]') === null)
      if (document.visibilityState === 'hidden' || modal || canvas.closest('[inert]') || !canvas.isConnected
        || !Number.isFinite(width) || !Number.isFinite(height)
        || width < 200 || height < 240) { send(false); return }
      send(true, { x: left, y: top, width, height })
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(canvas)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    document.addEventListener('visibilitychange', measure)
    // 共享 Modal 作为 body portal 挂载；原生子视图必须在遮罩出现时先退让。
    const modalSelector = '[role="dialog"][aria-modal="true"]'
    const modalObserver = new MutationObserver((records) => {
      if (records.some(record => record.type === 'attributes' ||
        [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element &&
          (node.matches(modalSelector) || node.querySelector(modalSelector) !== null)))) measure()
    })
    modalObserver.observe(document.body, { childList: true, subtree: true,
      attributes: true, attributeFilter: ['role', 'aria-modal', 'aria-hidden', 'hidden', 'inert'] })
    measure()
    return () => {
      observer?.disconnect()
      modalObserver.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      document.removeEventListener('visibilitychange', measure)
      send(false)
    }
  }, [nativePresenter, sessionId, tabId, shown, view.phase, nativeNotice, awaitingSelectedTab, pendingBrowserLink])
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
    if (native || !shown || pendingBrowserLink !== undefined || awaitingSelectedTab || tabId === null
      || browserGeneration === null || canvasRef.current === null
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
  }, [native, shown, pendingBrowserLink, awaitingSelectedTab, tabId, browserGeneration])
  const currentViewport = view.state?.viewport
  const stateRevision = view.state?.stateRevision
  useEffect(() => {
    if (native || !shown || pendingBrowserLink !== undefined || awaitingSelectedTab || tabId === null
      || browserGeneration === null || desiredViewport === null
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
  }, [native, shown, pendingBrowserLink, awaitingSelectedTab, tabId, browserGeneration, desiredViewport,
    view.pending, view.phase, agentBusy,
    currentViewport?.width, currentViewport?.height, stateRevision, command, retry, viewportRetryRevision])
  const addressTab = awaitingSelectedTab ? view.state.tabs.find(tab => tab.id === selectedTabId) : active
  const address = pendingBrowserLink?.url ?? (addressTab?.url === 'about:blank' ? '' : addressTab?.url ?? '')
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
  const frameReady = !awaitingSelectedTab && view.phase === 'ready' && view.state.hasFrame
    && view.frameUrl !== null && loadedFrame === view.frameUrl
    && frameRef.current?.complete === true && observation !== null && observation !== undefined
    && frameMatchesViewport(frameRef.current, observation.viewport)
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
  return <section className={css.root} hidden={!shown} data-native-notice={nativeNotice} aria-label={t('label')}>
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
      {!native && <button type="button" className={css.typeMode} data-active={typeMode}
        disabled={!frameReady || controlsDisabled} aria-pressed={typeMode}
        title={agentBusy ? t('agentBusy') : t('typeModeHint')}
        onClick={() => { setTypeMode(previous => !previous); setTypeTarget(null) }}>{t('typeMode')}</button>}
    </div>
    {nativeNotice && <div className={css.nativeNotice}>
      {inputError && <p id="browser-address-error" className={css.nativeError} role="alert">{inputError}</p>}
      {view.pending && !awaitingSelectedTab && <p role="status">{t('pending')}</p>}
      {agentBusy && view.phase !== 'busy' && <p role="status">{t('agentBusy')}</p>}
    </div>}
    <div className={css.body} ref={canvasRef} data-testid="browser-canvas">
      {pendingBrowserLink !== undefined && <div className={css.linkStatus}
        {...pendingBrowserLink.error === undefined ? { role: 'status' } : { role: 'alert' }}>
        {pendingBrowserLink.error === undefined && <span className={css.linkSpinner}
          data-testid="browser-link-loading" aria-hidden="true" />}
        <span>{pendingBrowserLink.error === undefined ? t('pending') : t('linkError')}</span>
        <strong className={css.linkUrl}>{pendingBrowserLink.url}</strong>
        {pendingBrowserLink.error !== undefined && <>
          <span>{pendingBrowserLink.error}</span>
          <button type="button" onClick={() => {
            void retryLink(pendingBrowserLink.url, pendingBrowserLink.id).catch((error: unknown) => {
              failBrowserLink(pendingBrowserLink.id, error instanceof Error ? error.message : String(error))
            })
          }}>
            {t('retry')}
          </button>
        </>}
      </div>}
      {pendingBrowserLink === undefined && !native && inputError && <p id="browser-address-error" className={css.inputError} role="alert">{inputError}</p>}
      {pendingBrowserLink === undefined && !native && view.pending && !awaitingSelectedTab
        && <p role="status" className={css.pending}>{t('pending')}</p>}
      {pendingBrowserLink === undefined && !native && agentBusy && view.phase !== 'busy' && <p role="status" className={css.busyNotice}>{t('agentBusy')}</p>}
      {pendingBrowserLink === undefined && view.phase === 'loading' && <p role="status" className={css.message}>{t('loading')}</p>}
      {pendingBrowserLink === undefined && awaitingSelectedTab && <p role="status" className={css.message}>{t('loading')}</p>}
      {pendingBrowserLink === undefined && view.phase === 'busy' && <p className={css.message} role="status">{t('agentBusy')}</p>}
      {pendingBrowserLink === undefined && (view.phase === 'empty' || view.phase === 'ready' && !awaitingSelectedTab
        && (!active || !native && active.url === 'about:blank')) && <div className={css.blank}>
        <span className={css.blankGlobe} aria-hidden="true"><IconGlobeOutline14 size={40} /></span>
        <h2>{t('startBrowsing')}</h2><p>{t('emptyHint')}</p>
      </div>}
      {pendingBrowserLink === undefined && view.phase === 'error' && <div className={css.message} role="alert">
        <span>{t('error')}: {view.message}</span><button type="button" onClick={() => {
          clearViewportRetry()
          viewportRetryCount.current = 0
          lastViewportAttempt.current = null
          retry()
          setViewportRetryRevision(previous => previous + 1)
        }}>{t('retry')}</button>
      </div>}
      {pendingBrowserLink === undefined && view.phase === 'ready' && !awaitingSelectedTab && active && native
        && <div className={css.nativeCanvas} aria-label={t('nativePage')} />}
      {pendingBrowserLink === undefined && view.phase === 'ready' && !awaitingSelectedTab && active && !native && active.url !== 'about:blank' && <div className={css.canvas}>
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
