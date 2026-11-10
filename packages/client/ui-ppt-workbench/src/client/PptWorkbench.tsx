/**
 * PPT 工作台：顶部操作胶囊、可收起的页导航与画布。
 *
 * 组件只读注入的快照、只调注入的回调；请求、轮询与冲突处理都在控制器里，因此同一
 * 会话的多个工作台实例看到的是同一份状态。
 * @module coding-ppt-workbench/client/PptWorkbench
 */

import { useEffect, useRef, useState } from 'react'
import { Button, Menu, Modal } from 'coding-client-ui-primitives'
import type { SnapshotStore } from 'coding-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import {
  Icon,
  IconChevronDownOutline14, IconCloseOutline16, IconDownloadOutline16, IconEllipsisOutline16,
  IconPanelLeftOutline16, IconPlusOutline16, IconSettingsOutline16,
} from 'coding-client-ui-icons'
import type { PptElementKind, SlideTransition } from 'coding-ppt-model'
import type { PptPanelState } from './controller.ts'
import { currentPage } from './controller.ts'
import type { ElementPatch } from './Inspector.tsx'
import { Inspector } from './Inspector.tsx'
import { NS } from './locales.ts'
import { Stage } from './Stage.tsx'
import { ThumbStrip } from './ThumbStrip.tsx'
import { TemplateCatalog, type TemplateCatalogInjected } from './TemplateCatalog.tsx'
import type { TemplateCatalogState } from './template-catalog.ts'
import css from './PptWorkbench.module.css'

/** 注册侧传给面板的全部动作。 */
export interface PptWorkbenchInjected {
  hooks: {
    /** 会话级面板状态。 */
    ppt: SnapshotStore<PptPanelState>
    templateCatalog: SnapshotStore<TemplateCatalogState>
  }
  catalogActions: Omit<TemplateCatalogInjected, 'hooks'>
  show: (visible: boolean) => void
  refresh: () => void
  open: (dir: string) => Promise<void>
  create: (title: string) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  exportDeck: () => Promise<void>
  selectPage: (index: number) => void
  selectElement: (id: string | null) => void
  setEditing: (id: string | null) => void
  addPage: (template?: string) => Promise<void>
  removePage: (pageId: string) => Promise<void>
  movePage: (pageId: string, to: number) => Promise<void>
  addElement: (kind: PptElementKind) => Promise<void>
  removeElement: (id: string) => Promise<void>
  updateElement: (id: string, patch: ElementPatch) => Promise<void>
  editCell: (id: string, row: number, column: number, content: string) => Promise<void>
  updatePage: (patch: { name?: string; background?: string | null; transition?: SlideTransition }) => Promise<void>
  updateDeck: (patch: { title?: string; theme?: string; size?: '16:9' | '4:3' }) => Promise<void>
  duplicateElement: (id: string) => Promise<void>
  copyElement: (id: string) => void
  cutElement: (id: string) => Promise<void>
  pasteElement: (at?: { x: number; y: number }) => Promise<void>
  reorderElement: (id: string, to: 'front' | 'back' | 'forward' | 'backward') => Promise<void>
  insertImage: (file: File, replaceId?: string) => Promise<void>
  checkDeck: () => Promise<void>
  preview: (pages?: readonly number[]) => Promise<void>
  mediaUrl: (dir: string | undefined, source: string) => string
}

export type PptWorkbenchProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<typeof NS>
  & InjectFace<PptWorkbenchInjected>

const ADD_KINDS: readonly PptElementKind[] = ['text', 'rect', 'ellipse', 'line', 'chart']

/** 各元素种类在工具条上的文案键。 */
const LABEL_OF: Readonly<Record<string, (t: PptWorkbenchProps['t']) => string>> = {
  text: t => t('addText'),
  rect: t => t('addRect'),
  ellipse: t => t('addEllipse'),
  line: t => t('addLine'),
  chart: t => t('addChart'),
}

/**
 * 工作台面板。
 * @param props - 会话、显隐、文案与注入的动作。
 * @returns 工作台或空态。
 */
export function PptWorkbench({
  shown, t, usePpt, show, refresh, open, undo, redo, exportDeck,
  selectPage, selectElement, setEditing, addPage, removePage, movePage,
  addElement, removeElement, updateElement, editCell, updatePage, updateDeck,
  duplicateElement, copyElement, cutElement, pasteElement, reorderElement, insertImage, checkDeck, preview, mediaUrl,
  useTemplateCatalog, catalogActions,
}: PptWorkbenchProps) {
  const state = usePpt(snapshot => snapshot)
  const [menu, setMenu] = useState<'new' | 'insert' | 'page' | 'more' | null>(null)
  const [showThumbs, setShowThumbs] = useState(true)
  const [showInspector, setShowInspector] = useState(false)
  const [showIssues, setShowIssues] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const replacingImage = useRef<string | undefined>(undefined)
  const chooseImage = (id?: string): void => {
    replacingImage.current = id
    fileInput.current?.click()
  }
  const inspectorClose = useRef<HTMLButtonElement>(null)
  const inspectorTrigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!shown) return undefined
    show(true)
    return () => { show(false) }
  }, [shown, show])

  useEffect(() => {
    setMenu(null)
    replacingImage.current = undefined
    setShowInspector(false)
    setShowIssues(false)
  }, [state.project?.dir])

  useEffect(() => {
    if (state.issues !== null) setShowIssues(true)
  }, [state.issues])

  useEffect(() => {
    if (!showInspector) return undefined
    inspectorClose.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setShowInspector(false)
      inspectorTrigger.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [showInspector])

  const project = state.project
  const page = currentPage(project, state.pageIndex)
  const element = page === null
    ? null
    : page.elements.find(entry => entry.id === state.selectedId) ?? null
  const catalogModal = <Modal open={catalogOpen} onClose={() => { setCatalogOpen(false) }}
    title={t('catalogTitle')} closeLabel={t('close')} className={css.catalogDialog as string}
    contentClassName={css.catalogContent as string} trapFocus>
    {catalogOpen && <TemplateCatalog {...catalogActions} useTemplateCatalog={useTemplateCatalog} t={t} showTitle={false}
      onHandoff={() => { setCatalogOpen(false) }} />}
  </Modal>

  if (state.phase === 'ready' && project === null) {
    return (
      <div className={css.root}>
        <div className={css.blank}>
          {state.projects.length === 0 ? (
            <div className={css.blankCard}>
              <div className={css.brand}>
                <Icon name="ppt-workbench" size={20} />
                <span>{t('title')}</span>
              </div>
              <p className={css.blankHint}>{t('emptyTitle')}</p>
              <Button variant="outline" size="sm" onClick={() => { setCatalogOpen(true) }}>{t('templateLibrary')}</Button>
            </div>
          ) : (
            <>
              <p className={css.blankTitle}>{t('projects')}</p>
              <ul className={css.projects}>
                {state.projects.map(item => (
                  <li key={item.dir}>
                    <button type="button" className={css.project} onClick={() => { void open(item.dir) }}>
                      <span className={css.projectName}>{item.title}</span>
                      <span className={css.projectMeta}>{t('pages', { count: item.pages })}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <Button variant="outline" size="sm" onClick={() => { setCatalogOpen(true) }}>{t('templateLibrary')}</Button>
            </>
          )}
        </div>
        {catalogModal}
      </div>
    )
  }

  const notice = describeNotice(state, t)
  const mediaUrlOf = (source: string): string => mediaUrl(project?.dir, source)
  const toggleMenu = (target: NonNullable<typeof menu>): void => {
    setShowInspector(false)
    setMenu(current => current === target ? null : target)
  }
  const newTemplates = [
    { id: '', label: t('blankPage') },
    { id: 'title', label: t('templateTitle') },
    { id: 'section', label: t('templateSection') },
    { id: 'bullets', label: t('templateBullets') },
    { id: 'two-column', label: t('templateTwoColumn') },
    { id: 'data', label: t('templateData') },
    { id: 'chart', label: t('templateChart') },
    { id: 'quote', label: t('templateQuote') },
  ]
  const insertItems = [
    ...ADD_KINDS.map(kind => ({ id: kind, label: LABEL_OF[kind]?.(t) ?? kind })),
    { id: 'image', label: t('addImage') },
    { id: 'table', label: t('addTable') },
  ]

  return (
    <div className={css.root} data-busy={state.busy ? 'true' : undefined}>
      {project === null ? null : (
        <header className={css.toolbar}>
          <div className={css.capsuleTitle}>
            <button type="button" className={css.iconAction} aria-label={showThumbs ? t('hideThumbs') : t('showThumbs')}
              title={showThumbs ? t('hideThumbs') : t('showThumbs')}
              aria-pressed={showThumbs} onClick={() => { setShowThumbs(value => !value) }}>
              <IconPanelLeftOutline16 size={16} />
            </button>
            <span className={css.deckTitle} title={project.title}>{project.title}</span>
            <span className={css.badge}>{t('pages', { count: project.deck.pages.length })} · {t('revision', { count: project.revision })}</span>
            <span className={css.feedback} data-tone={notice.tone} role="status" title={notice.text}>{notice.text}</span>
          </div>
          <div className={css.capsule}>
            <Menu open={menu === 'new'} onClose={() => { setMenu(null) }} items={newTemplates}
              keyboardNavigation compact portal
              onSelect={(id) => { setMenu(null); void addPage(id === '' ? undefined : id) }}
              anchor={<button type="button" className={css.action} disabled={state.busy}
                aria-haspopup="menu" aria-expanded={menu === 'new'} onClick={() => { toggleMenu('new') }}>
                <IconPlusOutline16 size={14} />{t('addPage')}<IconChevronDownOutline14 size={12} />
              </button>}
            />
            <Menu open={menu === 'insert'} onClose={() => { setMenu(null) }} items={insertItems}
              keyboardNavigation compact portal
              onSelect={(id) => {
                setMenu(null)
                if (id === 'image') chooseImage()
                else void addElement(id as PptElementKind)
              }}
              anchor={<button type="button" className={css.action} disabled={state.busy}
                aria-haspopup="menu" aria-expanded={menu === 'insert'} onClick={() => { toggleMenu('insert') }}>
                {t('insert')}<IconChevronDownOutline14 size={12} />
              </button>}
            />
            <Menu open={menu === 'page'} onClose={() => { setMenu(null) }} compact keyboardNavigation portal
              items={[
                { id: 'up', label: t('movePageUp'), disabled: state.busy || state.pageIndex === 0 },
                { id: 'down', label: t('movePageDown'), disabled: state.busy || state.pageIndex === project.deck.pages.length - 1 },
                { type: 'separator', id: 'separator' },
                { id: 'delete', label: t('deletePage'), danger: true, disabled: state.busy || project.deck.pages.length === 1 },
              ]}
              onSelect={(id) => {
                setMenu(null)
                if (page === null) return
                if (id === 'delete') void removePage(page.id)
                else void movePage(page.id, state.pageIndex + (id === 'up' ? -1 : 1))
              }}
              anchor={<button type="button" className={css.action} aria-haspopup="menu" aria-expanded={menu === 'page'}
                onClick={() => { toggleMenu('page') }}>{t('pageActions')}<IconChevronDownOutline14 size={12} /></button>}
            />
            <span className={css.divider} />
            <button type="button" className={css.iconAction} disabled={state.busy || !project.canUndo}
              aria-label={t('undo')} title={t('undo')} onClick={() => { void undo() }}>
              <Icon name="undo" size={16} />
            </button>
            <button type="button" className={css.iconAction} disabled={state.busy || !project.canRedo}
              aria-label={t('redo')} title={t('redo')} onClick={() => { void redo() }}>
              <Icon name="redo" size={16} />
            </button>
          </div>
          <div className={`${css.capsule} ${css.capsuleEnd}`}>
            <button ref={inspectorTrigger} type="button" className={css.action} aria-expanded={showInspector}
              aria-haspopup="dialog" onClick={() => { setMenu(null); setShowInspector(value => !value) }}>
              <IconSettingsOutline16 size={14} />{t('properties')}
            </button>
            <button type="button" className={css.action} disabled={state.busy}
              onClick={() => { setShowIssues(true); void checkDeck() }}>
              {t('check')}
            </button>
            <button type="button" className={css.action} disabled={state.busy} onClick={() => { void preview() }}>{t('preview')}</button>
            <button type="button" className={css.action} disabled={state.busy} onClick={() => { void exportDeck() }}>
              <IconDownloadOutline16 size={14} />{t('export')}
            </button>
            <Menu open={menu === 'more'} onClose={() => { setMenu(null) }} compact keyboardNavigation portal align="end"
              items={[{ id: 'templates', label: t('templateLibrary') }, { id: 'reload', label: t('reload') }]}
              onSelect={(id) => {
                setMenu(null)
                if (id === 'templates') setCatalogOpen(true)
                else refresh()
              }}
              anchor={<button type="button" className={css.iconAction} aria-label={t('more')}
                title={t('more')} aria-haspopup="menu" aria-expanded={menu === 'more'}
                onClick={() => { toggleMenu('more') }}><IconEllipsisOutline16 size={16} /></button>}
            />
          </div>
          <input ref={fileInput} type="file" aria-label={t('chooseImage')}
            accept="image/png,image/jpeg,image/gif,image/webp" hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              const replaceId = replacingImage.current
              replacingImage.current = undefined
              if (file !== undefined) {
                if (replaceId === undefined) void insertImage(file)
                else void insertImage(file, replaceId)
              }
            }} />
          {showIssues && state.issues !== null ? (
            <div className={css.issuesPanel}>
              <button type="button" className={css.issuesClose} onClick={() => { setShowIssues(false) }}
                aria-label={t('closeCheck')}>{t('close')}</button>
              <ul className={css.issues}>
                {state.issues.length === 0
                  ? <li data-severity="ok">{t('checkClean')}</li>
                  : state.issues.map((issue, index) => (
                    <li key={`${issue.code}-${index}`} data-severity={issue.severity}>{issue.message}</li>
                  ))}
              </ul>
            </div>
          ) : null}
        </header>
      )}

      {state.phase === 'error' ? (
        <div className={css.blank}>
          <p className={css.blankTitle}>{t('errorTitle')}</p>
          {state.notice?.tone === 'error' ? <p className={css.errorReason} role="alert">{state.notice.reason}</p> : null}
          <button type="button" className={css.primary} onClick={refresh}>{t('errorRetry')}</button>
        </div>
      ) : state.phase === 'loading' ? (
        <div className={css.blank}><p className={css.blankTitle}>{t('loading')}</p></div>
      ) : project === null ? null : (
        <div className={css.body}>
          {showThumbs ? <ThumbStrip
            deck={project.deck}
            pageIndex={state.pageIndex}
            busy={state.busy}
            t={t}
            onSelect={selectPage}
            onHide={() => { setShowThumbs(false) }}
            onMove={(next, to) => { void movePage(next.id, to) }}
          /> : null}
          <main className={css.main}>
            {page === null ? null : (
              <Stage
                deck={project.deck}
                page={page}
                selectedId={state.selectedId}
                editingId={state.editingId}
                busy={state.busy}
                t={t}
                onSelect={selectElement}
                onBeginEdit={setEditing}
                onEndEdit={(content) => {
                  const target = state.editingId
                  setEditing(null)
                  if (content !== null && target !== null) void updateElement(target, { text: { content } })
                }}
                onMove={(id, x, y) => { void updateElement(id, { frame: { x, y } }) }}
                onResize={(id, box) => { void updateElement(id, { frame: box }) }}
                onEditCell={(id, row, column, content) => { void editCell(id, row, column, content) }}
                mediaUrl={mediaUrlOf}
                hasClipboard={state.hasClipboard}
                onCopySelected={copyElement}
                onCutSelected={(id) => { void cutElement(id) }}
                onPaste={(at) => { void pasteElement(at) }}
                onInsert={(kind) => { void addElement(kind) }}
                onChooseImage={chooseImage}
                onDeleteSelected={(id) => { void removeElement(id) }}
                onDuplicateSelected={(id) => { void duplicateElement(id) }}
              />
            )}
          </main>
          {page === null || !showInspector ? null : (
            <div className={css.inspectorOverlay} role="dialog" aria-label={t('properties')}>
              <div className={css.inspectorHeading}>
                <span>{t('properties')}</span>
                <button ref={inspectorClose} type="button" className={css.iconAction}
                  aria-label={t('closeProperties')} title={t('closeProperties')}
                  onClick={() => { setShowInspector(false); inspectorTrigger.current?.focus() }}>
                  <IconCloseOutline16 size={16} />
                </button>
              </div>
              <Inspector
                deck={project.deck}
                page={page}
                element={element}
                busy={state.busy}
                t={t}
                onElement={(patch) => {
                  if (element === null) return
                  void updateElement(element.id, patch)
                }}
                onRemove={() => { if (element !== null) void removeElement(element.id) }}
                onDuplicate={() => { if (element !== null) void duplicateElement(element.id) }}
                onReorder={(to) => { if (element !== null) void reorderElement(element.id, to) }}
                onChart={(patch) => {
                  if (element === null || element.kind !== 'chart') return
                  const series = element.series.map((entry, index) => {
                    if (patch.combo !== undefined) {
                      return { ...entry, as: patch.combo && index > 0 ? 'line' as const : undefined }
                    }
                    if (patch.secondary !== undefined) {
                      return { ...entry, axis: patch.secondary && index > 0 ? 'secondary' as const : 'primary' as const }
                    }
                    return entry
                  }).map(({ as, axis, ...rest }) => ({
                    ...rest,
                    ...as === undefined ? {} : { as },
                    ...axis === undefined ? {} : { axis },
                  }))
                  void updateElement(
                    element.id,
                    element.chart === 'pie' && patch.stacked === undefined
                      ? {}
                      : {
                        chart: { categories: element.categories, series },
                        ...patch.stacked === undefined ? {} : { stacked: patch.stacked },
                      },
                  )
                }}
                onPage={(patch) => { void updatePage(patch) }}
                onDeck={(patch) => { void updateDeck(patch) }}
              />
            </div>
          )}
        </div>
      )}

      {catalogModal}

    </div>
  )
}

function describeNotice(
  state: PptPanelState,
  t: PptWorkbenchProps['t'],
): { tone: string; text: string } {
  if (state.busy) return { tone: 'busy', text: t('saving') }
  const notice = state.notice
  if (notice === null) {
    const revision = state.project?.revision
    return { tone: 'idle', text: revision === undefined ? t('idle') : t('saved', { count: revision }) }
  }
  switch (notice.tone) {
    case 'saved': return { tone: 'idle', text: t('saved', { count: notice.revision }) }
    case 'exporting': return { tone: 'busy', text: t('exporting') }
    case 'exported': return { tone: 'idle', text: t('exported', { path: notice.path }) }
    case 'conflict': return { tone: 'warn', text: t('conflict', { count: notice.revision }) }
    case 'error': return { tone: 'error', text: t('saveFailed', { reason: notice.reason }) }
  }
}
