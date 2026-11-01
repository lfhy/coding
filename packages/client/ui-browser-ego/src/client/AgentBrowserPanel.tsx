/** 工作台会话面板只呈现经验证的页面与 JPEG；人工输入由 Host 再次授权。 */
import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type WheelEvent } from 'react'
import { IconBrowseOutline16, IconGlobeOutline14, IconRefreshOutline16 } from 'coding-client-ui-icons'
import { Button, Input, Toast } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, HostObservable } from 'coding-client-ui-slots'
import type {} from 'coding-client-ui-open-in-app/client'
import type { BrowserEgoController, BrowserEgoView } from './controller.ts'
import { pointOnFrame } from './geometry.ts'
import { NS } from './locales.ts'
import css from './AgentBrowserPanel.module.css'

/** 从会话级注入面取得状态 Hook 和命令，不在组件内寻找 Cordis 上下文。 */
export interface AgentBrowserInjected {
  hooks: { browserEgo: HostObservable<BrowserEgoView> }
  show: (visible: boolean) => void
  refresh: () => Promise<void>
  select: (targetId: string) => void
  send: BrowserEgoController['send']
}

export type AgentBrowserProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS>
  & InjectFace<AgentBrowserInjected>

type ClickTarget = { targetId: string; timestamp: number }

function pageName(page: { title: string; url: string }, fallback: string): string {
  if (page.title !== '') return page.title
  try {
    const url = new URL(page.url)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : fallback
  } catch { return fallback }
}

/**
 * Host 只发送所属 Session 的页面；手动查看后台页面时单独请求已授权画面。
 * @param props - 框架注入的会话 ID、标签显隐与业务操作。
 * @returns 页面标签和实时 JPEG 视图。
 */
export function AgentBrowserPanel({ sessionId, useTabInfo, useBrowserEgo, show, refresh, select, send, t }: AgentBrowserProps) {
  const { shown } = useTabInfo()
  const view = useBrowserEgo(snapshot => snapshot)
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const [clickTarget, setClickTarget] = useState<ClickTarget | null>(null)
  const [text, setText] = useState('')
  const [toast, setToast] = useState<number | null>(null)
  const image = useRef<HTMLImageElement>(null)

  useEffect(() => { show(shown) }, [shown, show])
  useEffect(() => () => { show(false) }, [show])
  const selected = view.pages.find(page => page.targetId === view.selectedId)
  const frame = view.frame?.targetId === selected?.targetId ? view.frame : null
  const imageReady = shown && !view.pending && view.phase === 'ready' && !view.relayOff
    && frame !== null && selected !== undefined && loadedSrc === frame.src && image.current?.complete === true
    && image.current.naturalWidth > 0 && image.current.naturalHeight > 0
    && (selected.viewportW === null || selected.viewportW === frame.width)
    && (selected.viewportH === null || selected.viewportH === frame.height)
  const textReady = imageReady && clickTarget?.targetId === selected.targetId
    && clickTarget.timestamp === frame.ts && text.length > 0 && text.length <= 2000
  const warn = () => { setToast(previous => (previous ?? 0) + 1) }
  const point = (event: MouseEvent<HTMLButtonElement> | WheelEvent<HTMLButtonElement>) => {
    const node = image.current
    if (!imageReady || node === null) return null
    const rect = node.getBoundingClientRect()
    return pointOnFrame(event.clientX, event.clientY, rect,
      { width: node.naturalWidth, height: node.naturalHeight },
      { width: frame.width, height: frame.height })
  }
  async function click(event: MouseEvent<HTMLButtonElement>): Promise<void> {
    const current = point(event)
    if (!current || frame === null) return
    const targetId = frame.targetId
    const down = await send(targetId, { type: 'mousePressed', ...current, button: 'left', buttons: 1, clickCount: 1 })
    // 页面切换时旧目标的释放可能被拒；只将成功的完整点击作为文字输入定位。
    const up = down && await send(targetId, { type: 'mouseReleased', ...current, button: 'left', buttons: 0, clickCount: 1 })
    if (!down || !up) { setClickTarget(null); warn(); return }
    setClickTarget({ targetId, timestamp: frame.ts })
  }
  async function wheel(event: WheelEvent<HTMLButtonElement>): Promise<void> {
    if (event.deltaY === 0) return
    const current = point(event)
    if (!current || frame === null) return
    event.preventDefault()
    const deltaY = Math.max(-2000, Math.min(2000, Math.round(event.deltaY)))
    if (!await send(frame.targetId, { type: 'mouseWheel', ...current, deltaX: 0, deltaY })) warn()
  }
  async function typeAtPoint(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!textReady) return
    if (await send(frame.targetId, { type: 'insertText', text })) setText('')
    else warn()
  }

  return <section className={css.root} hidden={!shown} aria-label={t('title')}>
    <header className={css.header}>
      <span className={css.heading}><IconBrowseOutline16 size={16} />{t('title')}</span>
      <Button size="sm" variant="toolbar" className={css.refresh} title={t('refresh')}
        aria-label={t('refresh')} icon={<IconRefreshOutline16 size={14} />}
        onClick={() => { void refresh() }} />
    </header>
    <nav className={css.tabs} aria-label={t('tabs')}>
      {view.pages.map(page => <Button key={page.targetId} size="sm" variant="toolbar"
        className={css.tab} aria-current={page.targetId === selected?.targetId ? 'page' : undefined}
        title={pageName(page, t('page'))} onClick={() => { select(page.targetId); setClickTarget(null) }}
        icon={<IconGlobeOutline14 size={14} />}>
        <span className={css.tabName}>{pageName(page, t('page'))}</span>
      </Button>)}
    </nav>
    <div className={css.stage}>
      {view.phase === 'loading' && <p role="status" className={css.center}>{t('loading')}</p>}
      {view.phase === 'error' && <div className={css.center} role="alert">
        <span>{t('unavailable')}</span>
        <Button size="sm" variant="outline" onClick={() => { void refresh() }}>{t('refresh')}</Button>
      </div>}
      {view.phase === 'ready' && view.pages.length === 0 && <p className={css.center}>{t('empty')}</p>}
      {view.phase === 'ready' && view.pages.length > 0 && (view.relayOff
        ? <p className={css.center}>{t('relayOff')}</p>
        : frame === null ? <p className={css.center}>{t('noFrame')}</p>
          : <button type="button" className={css.frameAction} disabled={view.pending}
            aria-label={t('preview')} title={t('preview')}
            onClick={(event) => { void click(event) }} onWheel={(event) => { void wheel(event) }}>
            <img ref={image} className={css.frame} src={frame.src} alt={t('preview')} draggable={false}
              onLoad={() => { setLoadedSrc(frame.src) }} onError={() => { setLoadedSrc(null) }} />
          </button>)}
    </div>
    <form className={css.typeBar} onSubmit={(event) => { void typeAtPoint(event) }}>
      <label htmlFor={`browser-ego-text-${sessionId}`} className={css.srOnly}>{t('typeLabel')}</label>
      <Input id={`browser-ego-text-${sessionId}`} value={text} maxLength={2000}
        disabled={!imageReady} placeholder={t('typePlaceholder')}
        onChange={(event) => { setText(event.target.value) }} />
      <Button type="submit" size="sm" variant="outline" disabled={!textReady}>{t('send')}</Button>
    </form>
    {toast !== null && <Toast key={toast} text={t('inputFailed')} onDone={() => { setToast(null) }} />}
  </section>
}
