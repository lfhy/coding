/** 工作台会话面板只呈现经验证的页面与画面；人工输入由 Host 再次授权。 */
import { useEffect, useRef, useState, type ClipboardEvent, type CompositionEvent, type FormEvent, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react'
import {
  Icon, IconChevronLeftOutline14, IconChevronRightOutline14,
  IconRefreshOutline16, IconWarningOutline16,
} from 'coding-client-ui-icons'
import { Button, Input, Toast, Tooltip } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, HostObservable } from 'coding-client-ui-slots'
import type {} from 'coding-client-ui-open-in-app/client'
import type { BrowserEgoController, BrowserEgoView } from './controller.ts'
import { pointOnFrame } from './geometry.ts'
import { NS } from './locales.ts'
import type { EgoBrowserCapture } from './settings.ts'
import { createMsePlayer } from './video.ts'
import css from './AgentBrowserPanel.module.css'

/** 从会话级注入面取得状态 Hook 和命令，不在组件内寻找 Cordis 上下文。 */
export interface AgentBrowserInjected {
  hooks: {
    browserEgo: HostObservable<BrowserEgoView>
    /** 采集设置的投影；视频后端只在此处读取，不直接访问设置服务。 */
    browserEgoSettings: HostObservable<EgoBrowserCapture>
  }
  show: (visible: boolean, viewId: string) => void
  refresh: () => Promise<void>
  navigate: BrowserEgoController['navigate']
  /** 由用户触发：把浏览器换成可见窗口，用于登录与人机验证。 */
  raiseWindow: () => Promise<boolean>
  send: BrowserEgoController['send']
  hover: BrowserEgoController['hover']
  /** 把面板内容区尺寸同步给 Host，由采集会话按页面实际视口绘制。 */
  resize: BrowserEgoController['resize']
}

export type AgentBrowserProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS>
  & InjectFace<AgentBrowserInjected>

type Notice = { id: number; key: 'inputFailed' | 'navigateFailed' | 'raiseFailed' }

/** 页面给出的指针反馈；三项都来自 Host 的受限投影。 */
type HoverState = { cursor: string; title: string | null; href: string | null }

/** 悬停高亮只依赖这三项；相同内容的重绘没有意义。 */
function sameHover(left: HoverState | null, right: HoverState | null): boolean {
  return left === right || (left !== null && right !== null
    && left.cursor === right.cursor && left.title === right.title && left.href === right.href)
}

/** 人工画面只投递这些导航键；按键码不依赖浏览器已废弃的事件属性。 */
const NAVIGATION_KEYS: Readonly<Record<string, number>> = {
  Enter: 13, Backspace: 8, Delete: 46, Home: 36, End: 35,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
}

/** 人工地址栏只接受无凭据的 HTTP(S) 地址，不传递可执行或本地文件协议。 */
function addressFromDraft(draft: string): string | null {
  const value = draft.trim()
  if (!value || value.length > 2048 || /[\s\u007f]/u.test(value)) return null
  const candidate = /^https?:\/\//iu.test(value) ? value : /^[a-z][\w+.-]*:\/\//iu.test(value)
    ? value : `https://${value}`
  try {
    const url = new URL(candidate)
    if (url.username || url.password) return null
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '' ? url.href : null
  } catch { return null }
}

/**
 * Host 只发送所属 Session 的页面；手动查看后台页面时单独请求已授权画面。
 * @param props - 框架注入的会话 ID、标签显隐、采集设置与业务操作。
 * @returns 地址栏、网页导航与当前工作台标签对应的画面。
 */
export function AgentBrowserPanel({
  sessionId, useTabInfo, useBrowserEgo, useBrowserEgoSettings,
  show, refresh, navigate, raiseWindow, send, hover, resize, t,
}: AgentBrowserProps) {
  const { shown, tab } = useTabInfo()
  const targetId = tab.params !== null && typeof tab.params === 'object' && !Array.isArray(tab.params)
    && 'targetId' in tab.params && typeof tab.params.targetId === 'string' ? tab.params.targetId : null
  const viewId = targetId ?? 'default'
  const view = useBrowserEgo(snapshot => snapshot)
  const settings = useBrowserEgoSettings(snapshot => snapshot)
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [addressEditing, setAddressEditing] = useState(false)
  const [addressError, setAddressError] = useState(false)
  const lastPage = useRef<{ targetId: string | null; url: string } | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [videoFailed, setVideoFailed] = useState(false)
  const [hovered, setHovered] = useState<HoverState | null>(null)
  const hoverVersion = useRef(0)
  /** 悬停查询的在途标记与最新待查位置：同一时刻最多一条请求，避免按事件率排队。 */
  const hoverBusy = useRef(false)
  const hoverQueue = useRef<{ targetId: string; x: number; y: number } | null>(null)
  const image = useRef<HTMLImageElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const stage = useRef<HTMLDivElement>(null)

  useEffect(() => { show(shown, viewId) }, [shown, viewId, show])
  useEffect(() => () => { show(false, viewId) }, [show, viewId])
  const selected = view.pages.find(page => page.targetId === targetId)
  const frame = view.frame?.targetId === selected?.targetId ? view.frame : null
  const pageUrl = selected?.url === 'about:blank' ? '' : selected?.url ?? ''
  useEffect(() => {
    const previous = lastPage.current
    if (previous?.targetId === targetId && previous.url === pageUrl) return
    lastPage.current = { targetId, url: pageUrl }
    // 失焦不覆盖草稿；切换目标时即使网址相同也要清除上一页的输入。
    if (previous?.targetId !== targetId || !addressEditing) setAddress(pageUrl)
  }, [addressEditing, pageUrl, targetId])
  const imageReady = shown && !view.pending && view.phase === 'ready' && !view.relayOff
    && frame !== null && selected !== undefined && loadedSrc === frame.src && image.current?.complete === true
    && image.current.naturalWidth > 0 && image.current.naturalHeight > 0
    && (selected.viewportW === null || selected.viewportW === frame.width)
    && (selected.viewportH === null || selected.viewportH === frame.height)
  const videoMime = view.video.available ? view.video.mime : null
  useEffect(() => {
    hoverVersion.current++
    hoverQueue.current = null
    setHovered(null)
  }, [shown, targetId, pageUrl, view.pending])

  // 内容区决定页面视口；不拉伸截图，以免画面与人工输入坐标错位。
  useEffect(() => {
    const node = stage.current
    const page = selected?.targetId
    if (!shown || node === null || page === undefined) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    let disposed = false
    const report = (): void => {
      const width = Math.round(node.clientWidth)
      const height = Math.round(node.clientHeight)
      if (width < 320 || height < 200) return
      void resize(page, width, height).then((accepted) => {
        // worker 尚未就绪时有界重试；隐藏或卸载后的迟到结果不可继续调尺寸。
        if (disposed || accepted || retry !== null || attempts >= 2) return
        attempts++
        retry = setTimeout(() => { retry = null; report() }, 1200)
      })
    }
    report()
    const dispose = (): void => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      if (retry !== null) clearTimeout(retry)
    }
    // 老浏览器与测试环境没有 ResizeObserver：只同步首帧尺寸，不跟随后续拖动。
    if (typeof ResizeObserver === 'undefined') return dispose
    const observer = new ResizeObserver(() => {
      if (timer !== null) clearTimeout(timer)
      if (retry !== null) clearTimeout(retry)
      retry = null
      timer = setTimeout(() => { timer = null; attempts = 0; report() }, 250)
    })
    observer.observe(node)
    // 换到像素比不同的显示器时布局尺寸不变，ResizeObserver 不会触发；单独重新上报一次。
    const media = (globalThis as { matchMedia?: (query: string) => MediaQueryList }).matchMedia
    const ratio = (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1
    const resolution = typeof media === 'function' ? media.call(globalThis, `(resolution: ${ratio}dppx)`) : null
    const onResolution = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      attempts = 0
      report()
    }
    resolution?.addEventListener('change', onResolution)
    return () => {
      dispose()
      observer.disconnect()
      resolution?.removeEventListener('change', onResolution)
    }
  }, [shown, selected?.targetId, pageUrl, selected?.viewportW, selected?.viewportH, resize])
  const videoTarget = selected?.targetId ?? null
  // 只有用户选择视频后端、Host 报告 fMP4 就绪且上一次播放没有失败时才用 MSE。
  const videoMode = shown && settings.backend === 'ffmpeg' && videoMime !== null && !videoFailed
    && view.phase === 'ready' && !view.relayOff && videoTarget !== null && selected?.active === true
  const notify = (key: Notice['key']) => {
    setNotice(previous => ({ id: (previous?.id ?? 0) + 1, key }))
  }
  // 只有这个按钮会让浏览器出现在前台；其余动作都留在面板里。
  async function openWindow(): Promise<void> {
    if (!await raiseWindow()) notify('raiseFailed')
  }

  const videoOffered = settings.backend === 'ffmpeg' && videoMime !== null
  // 类型、页面或后端变化时允许重新尝试一次；失败状态不因每秒时间刷新而复原。
  useEffect(() => { setVideoFailed(false) }, [videoMime, videoTarget, shown, settings.backend])
  useEffect(() => {
    const node = video.current
    if (!videoMode || node === null) return
    const stop = createMsePlayer({
      video: node, mime: videoMime,
      onFailure: () => { setVideoFailed(true) },
    })
    // 隐藏、切换页面或离开视频后端时同时中止请求、丢弃队列并解除媒体源。
    return () => { stop() }
  }, [videoMode, videoMime, videoTarget])

  const warn = () => { notify('inputFailed') }
  const point = (event: MouseEvent<HTMLButtonElement> | WheelEvent<HTMLButtonElement>) => {
    const node = videoMode ? video.current : image.current
    const viewportW = frame?.width ?? selected?.viewportW ?? null
    const viewportH = frame?.height ?? selected?.viewportH ?? null
    if (node === null || viewportW === null || viewportH === null) return null
    const natural = videoMode
      ? { width: (node as HTMLVideoElement).videoWidth, height: (node as HTMLVideoElement).videoHeight }
      : { width: (node as HTMLImageElement).naturalWidth, height: (node as HTMLImageElement).naturalHeight }
    if (natural.width <= 0 || natural.height <= 0) return null
    if (!videoMode && !imageReady) return null
    return pointOnFrame(event.clientX, event.clientY, node.getBoundingClientRect(),
      natural, { width: viewportW, height: viewportH })
  }
  function movePointer(event: MouseEvent<HTMLButtonElement>): void {
    const current = point(event)
    const currentTarget = selected?.targetId
    hoverVersion.current++
    // 指针移动只保留最新位置：事件率远高于一次查询的往返时间，逐条发送会把请求排成一队。
    if (current === null || currentTarget === undefined) { hoverQueue.current = null; setHovered(null); return }
    hoverQueue.current = { targetId: currentTarget, x: current.x, y: current.y }
    void flushHover()
  }
  /** 同一时刻只保留一条在途悬停查询；它返回后立即用最新位置再查一次。 */
  async function flushHover(): Promise<void> {
    if (hoverBusy.current) return
    hoverBusy.current = true
    try {
      while (hoverQueue.current !== null) {
        const next = hoverQueue.current
        hoverQueue.current = null
        const request = hoverVersion.current
        const value = await hover(next.targetId, next.x, next.y)
        // 指针在页面内匀速移动时结果通常不变；内容相同就不重绘面板。
        if (hoverVersion.current === request) setHovered(previous => sameHover(previous, value) ? previous : value)
      }
    } finally { hoverBusy.current = false }
  }
  async function click(event: MouseEvent<HTMLButtonElement>): Promise<void> {
    const current = point(event)
    const targetId = selected?.targetId
    if (!current || targetId === undefined) return
    const down = await send(targetId, { type: 'mousePressed', ...current, button: 'left', buttons: 1, clickCount: 1 })
    if (!down) { warn(); return }
    if (!await send(targetId, { type: 'mouseReleased', ...current, button: 'left', buttons: 0, clickCount: 1 })) warn()
  }
  async function wheel(event: WheelEvent<HTMLButtonElement>): Promise<void> {
    if (event.deltaY === 0) return
    const current = point(event)
    if (!current || selected === undefined) return
    event.preventDefault()
    const deltaY = Math.max(-2000, Math.min(2000, Math.round(event.deltaY)))
    if (!await send(selected.targetId, { type: 'mouseWheel', ...current, deltaX: 0, deltaY })) warn()
  }
  async function key(event: KeyboardEvent<HTMLButtonElement>): Promise<void> {
    if ((!imageReady && !videoMode) || event.metaKey || event.ctrlKey
      || event.altKey || event.nativeEvent.isComposing) return
    if (event.key === 'Tab' || event.key === 'Escape') return
    if (event.key.length === 1) {
      event.preventDefault()
      if (!await send(selected.targetId, { type: 'insertText', text: event.key })) warn()
    } else {
      const windowsVirtualKeyCode = NAVIGATION_KEYS[event.key]
      if (windowsVirtualKeyCode === undefined) return
      event.preventDefault()
      const fields = { key: event.key, code: event.key, windowsVirtualKeyCode }
      const down = await send(selected.targetId, { type: 'keyDown', ...fields })
      const up = down && await send(selected.targetId, { type: 'keyUp', ...fields })
      if (!down || !up) warn()
    }
  }
  /** 画面获得焦点后，粘贴和中文输入与普通按键走相同的会话授权路径。 */
  async function insert(text: string): Promise<void> {
    if ((!imageReady && !videoMode) || text.length === 0 || text.length > 2000) return
    if (!await send(selected.targetId, { type: 'insertText', text })) warn()
  }
  function paste(event: ClipboardEvent<HTMLButtonElement>): void {
    event.preventDefault()
    void insert(event.clipboardData.getData('text/plain'))
  }
  function composed(event: CompositionEvent<HTMLButtonElement>): void {
    void insert(event.data)
  }
  async function submitAddress(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem(`ego-address-${sessionId}-${tab.id}`)
    const url = addressFromDraft(input instanceof HTMLInputElement ? input.value : address)
    if (url === null) { setAddressError(true); return }
    setAddressError(false)
    if (!await navigate(selected?.targetId, 'navigate', url)) notify('navigateFailed')
    else setAddress(url)
  }
  async function move(action: 'back' | 'forward' | 'reload'): Promise<void> {
    if (selected && !await navigate(selected.targetId, action)) notify('navigateFailed')
  }
  return <section className={css.root} hidden={!shown} aria-label={t('title')}>
    <div className={css.toolbar}>
      <Tooltip label={t('back')} side="bottom"><button type="button" className={css.iconButton}
        aria-label={t('back')} disabled={selected === undefined || view.pending}
        onClick={() => { void move('back') }}><IconChevronLeftOutline14 /></button></Tooltip>
      <Tooltip label={t('forward')} side="bottom"><button type="button" className={css.iconButton}
        aria-label={t('forward')} disabled={selected === undefined || view.pending}
        onClick={() => { void move('forward') }}><IconChevronRightOutline14 /></button></Tooltip>
      <Tooltip label={t('reload')} side="bottom"><button type="button" className={css.iconButton}
        aria-label={t('reload')} disabled={selected === undefined || view.pending}
        onClick={() => { void move('reload') }}><IconRefreshOutline16 size={14} /></button></Tooltip>
      <form className={css.address} onSubmit={(event) => { void submitAddress(event) }}>
        <label htmlFor={`ego-address-${sessionId}-${tab.id}`} className={css.srOnly}>{t('address')}</label>
        <Input id={`ego-address-${sessionId}-${tab.id}`} type="text" inputMode="url" spellCheck={false}
          autoComplete="url" value={address} disabled={view.phase !== 'ready' || view.pending}
          placeholder={t('addressPlaceholder')} aria-invalid={addressError}
          onFocus={() => { setAddressEditing(true) }} onBlur={() => { setAddressEditing(false) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          onChange={(event) => { setAddress(event.target.value); setAddressError(false) }} />
        <Tooltip label={t('openAddress')} side="bottom"><button type="submit" className={css.iconButton}
          aria-label={t('openAddress')} disabled={view.phase !== 'ready' || view.pending}>
          <IconChevronRightOutline14 size={14} /></button></Tooltip>
      </form>
      <Tooltip label={t('openWindow')} side="bottom"><button type="button" className={css.iconButton}
        aria-label={t('openWindow')} onClick={() => { void openWindow() }}>
        <Icon name="open-window" size={16} /></button></Tooltip>
    </div>
    {addressError && <p className={css.addressError} role="alert">{t('invalidAddress')}</p>}
    <div className={css.stage} ref={stage}>
      {shown && hovered?.href && <p className={css.hoverAddress} role="status">{hovered.href}</p>}
      {shown && hovered?.title && <p className={css.hoverTitle} role="status">{hovered.title}</p>}
      {view.phase === 'loading' && <p role="status" className={css.center}>{t('loading')}</p>}
      {view.phase === 'error' && <div className={css.center} role="alert">
        <span>{t('unavailable')}</span>
        <Button size="sm" variant="outline" onClick={() => { void refresh() }}>{t('refresh')}</Button>
      </div>}
      {view.phase === 'ready' && view.pages.length === 0 && <p className={css.center}>{t('empty')}</p>}
      {view.phase === 'ready' && selected?.humanCheck === true && <p className={css.notice} role="status">
        <IconWarningOutline16 size={14} /><span>{t('humanCheck')}</span>
      </p>}
      {view.phase === 'ready' && view.pages.length > 0 && selected === undefined
        && <p className={css.center}>{t('pageUnavailable')}</p>}
      {view.phase === 'ready' && selected !== undefined && (view.relayOff
        ? <p className={css.center}>{t('relayOff')}</p>
        : videoMode
          ? <button type="button" className={css.frameAction} disabled={view.pending}
            aria-label={t('videoPreview')} style={{ cursor: hovered?.cursor ?? 'default' }}
            onMouseMove={movePointer} onMouseLeave={() => { hoverVersion.current++; hoverQueue.current = null; setHovered(null) }}
            onClick={(event) => { void click(event) }} onWheel={(event) => { void wheel(event) }}
            onKeyDown={(event) => { void key(event) }} onPaste={paste} onCompositionEnd={composed}>
            <video ref={video} className={css.video} muted autoPlay playsInline
              aria-label={t('videoPreview')} />
          </button>
          : frame === null ? <p className={css.center}>{t('noFrame')}</p>
            : <button type="button" className={css.frameAction} disabled={view.pending}
              aria-label={t('preview')} style={{ cursor: hovered?.cursor ?? 'default' }}
              onMouseMove={movePointer} onMouseLeave={() => { hoverVersion.current++; hoverQueue.current = null; setHovered(null) }}
              onClick={(event) => { void click(event) }} onWheel={(event) => { void wheel(event) }}
              onKeyDown={(event) => { void key(event) }} onPaste={paste} onCompositionEnd={composed}>
              <img ref={image} className={css.frame} src={frame.src} alt={t('preview')} draggable={false}
                onLoad={() => { setLoadedSrc(frame.src) }} onError={() => { setLoadedSrc(null) }} />
            </button>)}
      {videoFailed && videoOffered && <p className={css.videoNotice} role="status">
        {t('videoFallback')}
      </p>}
    </div>
    {notice !== null && <Toast key={notice.id} text={t(notice.key)} onDone={() => { setNotice(null) }} />}
  </section>
}
