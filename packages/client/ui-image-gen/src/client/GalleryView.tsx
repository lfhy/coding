/** 会话画廊保留对话输入区；只在列表容器滚动，刷新不会抹去已显示的图片。 */
import { useEffect, useRef, useState } from 'react'
import { Button, Icon, IconRefreshOutline16, Toast } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { GalleryFace } from './gallery.ts'
import { NS } from './locales.ts'
import css from './GalleryView.module.css'

/** 独立画廊视图注册项的 props。 */
export type GalleryViewProps = PropsRuntime<'conversation.view'> & PropsLocale<typeof NS> & InjectFace<GalleryFace>

/**
 * 查看当前会话的历史图片，生成或编辑后由控制器重新读取权威目录。
 * @param props - 会话索引、可见状态和保存动作。
 * @returns 画廊和绘图表单。
 */
export function GalleryView({ useGallery, show, refresh, openCanvas, generate, place, url, t }: GalleryViewProps) {
  const state = useGallery(s => s)
  const [prompt, setPrompt] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const [limit, setLimit] = useState(24)
  const scroll = useRef<HTMLDivElement>(null)
  const announce = (text: string) => { setToast(previous => ({ id: (previous?.id ?? 0) + 1, text })) }
  useEffect(() => { show(true); return () => { show(false) } }, [show])
  useEffect(() => { if (state.items.length === 1 && scroll.current !== null) scroll.current.scrollTop = 0 }, [state.items.length])
  useEffect(() => { setLimit(24); if (scroll.current !== null) scroll.current.scrollTop = 0 }, [state.items.length === 0])
  const canGenerate = state.state?.available === true && state.phase === 'ready'
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const source = editing
    void generate(prompt, source ?? undefined).then((ok) => {
      if (ok) { setPrompt(''); setEditing(null) }
      else if (!state.generating) announce(t(source === null ? 'generateFailed' : 'editFailed'))
    })
  }
  return <section className={css.root} aria-label={t('gallery')}>
    <header className={css.toolbar}>
      <h2>{t('gallery')}</h2>
      <div className={css.toolbarActions}>
        <Button size="sm" icon={<Icon name="model-vision" size={16} />} onClick={() => {
          if (!openCanvas()) announce(t('canvasUnavailable'))
        }}>{t('openCanvas')}</Button>
        <button type="button" className={css.iconButton} aria-label={t('refresh')} title={t('refresh')}
          onClick={refresh}><IconRefreshOutline16 size={16} /></button>
      </div>
    </header>
    <p className={css.guidance}>{t('galleryHint')}</p>
    {state.state?.available === false && <p role="status" className={css.guidance}>{t('noService')}</p>}
    <form className={css.compose} onSubmit={submit}>
      <label htmlFor="image-gen-prompt">{t('prompt')}</label>
      <textarea id="image-gen-prompt" value={prompt} placeholder={t('promptPlaceholder')}
        disabled={!canGenerate || state.generating} onChange={(event) => { setPrompt(event.target.value) }} />
      <div className={css.composeActions}>
        {editing !== null && <Button size="sm" onClick={() => { setEditing(null) }}>{t('generate')}</Button>}
        <Button variant="primary" size="sm" type="submit" disabled={!canGenerate || state.generating || !prompt.trim()}>
          {t(state.generating ? 'generating' : editing === null ? 'generate' : 'edit')}
        </Button>
      </div>
    </form>
    <div className={css.list} ref={scroll} onScroll={(event) => {
      const target = event.currentTarget
      if (target.scrollTop + target.clientHeight >= target.scrollHeight - 240 && limit < state.items.length) {
        setLimit(Math.min(state.items.length, limit + 24))
      }
    }}>
      {state.phase === 'loading' && state.items.length === 0 && <p role="status" className={css.empty}>{t('galleryLoading')}</p>}
      {state.phase === 'error' && <div className={css.empty} role="alert">{t('galleryUnavailable')}
        <Button size="sm" onClick={refresh}>{t('retry')}</Button></div>}
      {state.phase === 'ready' && state.items.length === 0 && <div className={css.empty}>
        <Icon name="model-vision" size={24} /><p>{t('galleryEmpty')}</p>
      </div>}
      {state.items.length > 0 && <ul className={css.grid}>
        {state.items.slice(0, limit).map(item => <li key={item.id} className={css.item}>
          <img src={url(item.id)} alt={item.prompt || t('image')} loading="lazy"
            onError={(event) => { event.currentTarget.style.visibility = 'hidden' }} />
          <div className={css.caption} title={item.prompt || t('image')}>{item.prompt || t('image')}</div>
          <div className={css.itemActions}>
            <Button size="sm" disabled={!canGenerate} onClick={() => { setEditing(item.id); setPrompt(item.prompt) }}>{t('edit')}</Button>
            <Button size="sm" onClick={() => {
              void place(item.id).then((ok) => { announce(t(ok ? 'placed' : 'placeFailed')) })
            }}>{t('place')}</Button>
          </div>
        </li>)}
      </ul>}
    </div>
    {toast !== null && <Toast key={toast.id} text={toast.text} onDone={() => { setToast(null) }} />}
  </section>
}
