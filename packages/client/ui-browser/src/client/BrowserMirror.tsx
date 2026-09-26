/** 只呈现 Host 捕获画面，永不将目标网址嵌入 iframe 或 WebView。 */

import { useEffect, useRef } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-open-in-app/client'
import type { BrowserView } from './controller.ts'
import { NS } from './locales.ts'
import css from './BrowserMirror.module.css'

/** 组件私有的可订阅观测由 renderer 注入为 useBrowserMirror。 */
export interface BrowserMirrorInjected {
  hooks: { browserMirror: HostObservable<BrowserView> }
  start: (onRevision: () => void) => () => void
  retry: () => void
}

export type BrowserMirrorProps = PropsRuntime<'workbench.browser'>
  & PropsLocale<typeof NS>
  & InjectFace<BrowserMirrorInjected>

/**
 * 呈现会话独占的只读画面与鼠标位置。
 * @param props - 工作台 owner、词典和观测 hook。
 * @returns 可隐藏但持续挂载的预览区。
 */
export function BrowserMirror({ shown, openBrowser, closeBrowser, useBrowserMirror, start, retry, t }: BrowserMirrorProps) {
  const view = useBrowserMirror(state => state)
  const openRef = useRef(openBrowser)
  openRef.current = openBrowser
  useEffect(() => start(() => { openRef.current() }), [start])
  const state = view.state
  const cursor = state?.cursor
  const operation = cursor === null || cursor === undefined ? null : t(cursor.kind)
  const pulse = cursor !== null && cursor !== undefined && Date.now() - cursor.at < 1200
  return (
    <section className={css.root} hidden={!shown} aria-label={t('label')}>
      <header className={css.header}>
        <div className={css.identity}>
          <strong className={css.title}>{state?.title || t('label')}</strong>
          {state !== null && <span className={css.url} title={state.url}>{state.url}</span>}
        </div>
        <button type="button" className={css.close} onClick={closeBrowser} aria-label={t('close')} title={t('close')}>×</button>
      </header>
      {view.phase === 'loading' && <p role="status" className={css.message}>{t('loading')}</p>}
      {view.phase === 'empty' && <p role="status" className={css.message}>{t('empty')}</p>}
      {view.phase === 'error' && <div className={css.message} role="alert">
        <span>{t('error')}: {view.message}</span>
        <button type="button" className={css.retry} onClick={retry}>{t('retry')}</button>
      </div>}
      {view.phase === 'ready' && state !== null && <div className={css.content}>
        <div className={css.status} role="status">{operation ?? t('ready')}</div>
        <div className={css.canvas}>
          <div className={css.viewport} style={{ aspectRatio: `${state.viewport.width} / ${state.viewport.height}` }}>
            {view.frameUrl !== null
              ? <img className={css.frame} src={view.frameUrl} alt={t('frame')} draggable={false} />
              : <span className={css.noFrame}>{t('noFrame')}</span>}
            {view.frameUrl !== null && cursor !== null && cursor !== undefined && <span
              className={css.cursor} data-pulse={pulse ? 'true' : 'false'}
              style={{ left: `${cursor.x / state.viewport.width * 100}%`, top: `${cursor.y / state.viewport.height * 100}%` }}
              aria-label={operation ?? undefined} role="img"
            ><span className={css.pointer} /><span className={css.ripple} /></span>}
          </div>
        </div>
        <details className={css.details}><summary>{t('snapshot')}</summary><pre>{state.snapshot}</pre></details>
      </div>}
    </section>
  )
}
