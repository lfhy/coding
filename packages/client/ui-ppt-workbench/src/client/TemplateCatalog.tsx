/** 设置和工作台复用的只读整稿模板目录。 */
import { useEffect, useRef, useState } from 'react'
import { Button } from 'coding-client-ui-primitives'
import type { SnapshotStore } from 'coding-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type {} from 'coding-client-ui-settings/client'
import { NS } from './locales.ts'
import { SlideSurface } from './SlideSurface.tsx'
import type { PptTemplateId, TemplateCatalogState } from './template-catalog.ts'
import type { TemplateHandoffId } from './template-navigation.ts'
import css from './TemplateCatalog.module.css'

/** 注入的是裸快照源与交接动作；组件不访问 ctx。 */
export interface TemplateCatalogInjected {
  hooks: { templateCatalog: SnapshotStore<TemplateCatalogState> }
  loadTemplates: () => Promise<void>
  detailTemplate: (id: PptTemplateId) => Promise<void>
  templateMediaUrl: (id: PptTemplateId, path: string) => string
  handoffPrompt: (text: string, id: TemplateHandoffId) => Promise<void>
  cancelHandoff: (id: TemplateHandoffId) => void
  focusPrompt: (id: TemplateHandoffId) => void
}

export type TemplateCatalogProps = PropsLocale<typeof NS> & InjectFace<TemplateCatalogInjected> & {
  onHandoff?: () => void
  showTitle?: boolean
}

const BUILTIN_LAYOUTS = [
  'templateTitle', 'templateSection', 'templateBullets', 'templateTwoColumn',
  'templateData', 'templateChart', 'templateQuote',
] as const

/** 选择模板只预览；唯一写意图交给对话草稿，不调用模板写接口。 */
export function TemplateCatalog({
  t, useTemplateCatalog, loadTemplates, detailTemplate, templateMediaUrl,
  handoffPrompt, cancelHandoff, focusPrompt, onHandoff, showTitle = true,
}: TemplateCatalogProps) {
  const state = useTemplateCatalog(snapshot => snapshot)
  const [selectedId, setSelectedId] = useState<PptTemplateId | null>(null)
  const [handoffError, setHandoffError] = useState<string | null>(null)
  const [handoffBusy, setHandoffBusy] = useState(false)
  const mounted = useRef(true)
  const pending = useRef<TemplateHandoffId | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const [previewWidth, setPreviewWidth] = useState(0)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const id = pending.current
      pending.current = null
      if (id !== null) cancelHandoff(id)
    }
  }, [cancelHandoff])
  useEffect(() => { void loadTemplates() }, [loadTemplates])
  const activeId = state.phase === 'error' ? null
    : selectedId !== null && state.templates.some(item => item.id === selectedId)
      ? selectedId : state.templates[0]?.id ?? null
  useEffect(() => { if (activeId !== null) void detailTemplate(activeId) }, [activeId, detailTemplate])
  const selected = state.templates.find(item => item.id === activeId)
  const detail = activeId === null ? undefined : state.details[activeId]
  const preview = detail?.deck.pages[0]
  useEffect(() => {
    const node = previewRef.current
    if (node === null) return undefined
    const observer = new ResizeObserver(([entry]) => {
      setPreviewWidth(Math.max(0, Math.floor(Math.min(280, entry?.contentRect.width ?? 0))))
    })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [selected?.id])
  const handoff = async (text: string): Promise<void> => {
    if (pending.current !== null) return
    const id = crypto.randomUUID() as TemplateHandoffId
    pending.current = id
    setHandoffBusy(true)
    setHandoffError(null)
    try {
      await handoffPrompt(text, id)
      if (!mounted.current || pending.current !== id) return
      pending.current = null
      setHandoffBusy(false)
      onHandoff?.()
      focusPrompt(id)
    }
    catch (error) {
      if (mounted.current && pending.current === id) setHandoffError(error instanceof Error ? error.message : String(error))
    } finally {
      if (pending.current === id) {
        pending.current = null
        if (mounted.current) setHandoffBusy(false)
      }
    }
  }

  return <div className={css.library}>
    <div className={css.heading}>
      <div>
        {showTitle && <h2 className={css.title}>{t('catalogTitle')}</h2>}
        <p className={css.hint}>{t('catalogIntro')}</p>
      </div>
      <Button variant="primary" disabled={handoffBusy} onClick={() => { void handoff(t('createTemplatePrompt')) }}>
        {t('createTemplateAction')}
      </Button>
    </div>
    {handoffError !== null && <p role="alert" className={css.error}>{handoffError}</p>}
    {state.phase === 'loading' && <p role="status">{t('templatesLoading')}</p>}
    {state.error !== null && <p role="alert" className={css.error}>{state.error}</p>}
    {state.phase === 'error' && <Button variant="outline" onClick={() => { void loadTemplates() }}>{t('errorRetry')}</Button>}
    {state.phase === 'ready' && state.templates.length === 0 && <p className={css.empty}>{t('templatesEmpty')}</p>}
    {state.phase !== 'error' && state.templates.length > 0 && <div className={css.columns}>
      <ul className={css.list} aria-label={t('myTemplates')}>
        {state.templates.map(item => <li key={item.id}>
          <button type="button" className={css.row} aria-current={item.id === activeId ? 'true' : undefined}
            onClick={() => { setSelectedId(item.id) }}>
            <span className={css.rowName}>{item.name}</span>
            <span className={css.meta}>{t('pages', { count: item.pages })}</span>
          </button>
        </li>)}
      </ul>
      {selected !== undefined && <div className={css.detail}>
        <div ref={previewRef} className={css.preview} aria-label={t('templatePreview')}>
          {preview === undefined || detail === undefined || previewWidth === 0 ? <p role="status">{t('previewLoading')}</p>
            : <SlideSurface deck={detail.deck} page={preview} width={previewWidth}
              mediaUrl={path => templateMediaUrl(selected.id, path)} />}
          {preview === undefined && state.error !== null && <Button variant="outline" size="sm"
            onClick={() => { void detailTemplate(selected.id) }}>{t('errorRetry')}</Button>}
        </div>
        <strong>{selected.name}</strong>
        <p className={css.meta}>{t('pages', { count: selected.pages })}{selected.sourceName === null ? '' : ` · ${selected.sourceName}`}</p>
        {(detail?.dropped ?? selected.dropped).length > 0 && <p className={css.warning}>{t('unsupportedNotice', {
          items: (detail?.dropped ?? selected.dropped).join('、'),
        })}</p>}
        <Button variant="outline" size="sm" disabled={handoffBusy}
          onClick={() => { void handoff(t('useTemplatePrompt', { name: selected.name, id: selected.id })) }}>
          {t('useTemplateAction')}
        </Button>
      </div>}
    </div>}
    <div className={css.builtins}>
      <h3>{t('builtinsTitle')}</h3>
      <p>{t('builtinsIntro')}</p>
      <p className={css.meta}>{BUILTIN_LAYOUTS.map(key => t(key)).join(' · ')}</p>
    </div>
  </div>
}

export type TemplateSettingsProps = PropsRuntime<'settings.section'> & TemplateCatalogProps

/** 设置导航中的模板管理分区。 */
export function TemplateSettingsSection(props: TemplateSettingsProps) {
  return <section className={css.settings}><TemplateCatalog {...props} onHandoff={props.close} /></section>
}
