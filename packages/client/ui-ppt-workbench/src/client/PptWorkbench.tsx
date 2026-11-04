/**
 * 右侧「PPT 工作台」面板：工具条 + 缩略图 / 画布 / 属性三栏 + 状态条。
 *
 * 组件只读注入的快照、只调注入的回调；请求、轮询与冲突处理都在控制器里，因此同一
 * 会话的多个工作台实例看到的是同一份状态。
 * @module coding-ppt-workbench/client/PptWorkbench
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from 'coding-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import {
  IconChevronDownOutline14, IconChevronUpOutline14, IconDownloadOutline16,
  IconPlusOutline16, IconRefreshOutline16,
} from 'coding-client-ui-icons'
import type { PptElementKind } from 'coding-ppt-model'
import type { PptPanelState } from './controller.ts'
import { currentPage } from './controller.ts'
import type { ElementPatch } from './Inspector.tsx'
import { Inspector } from './Inspector.tsx'
import { NS } from './locales.ts'
import { Stage } from './Stage.tsx'
import { ThumbStrip } from './ThumbStrip.tsx'
import css from './PptWorkbench.module.css'

/** 注册侧传给面板的全部动作。 */
export interface PptWorkbenchInjected {
  hooks: {
    /** 会话级面板状态。 */
    ppt: SnapshotStore<PptPanelState>
  }
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
  addPage: () => Promise<void>
  removePage: (pageId: string) => Promise<void>
  movePage: (pageId: string, to: number) => Promise<void>
  addElement: (kind: PptElementKind) => Promise<void>
  removeElement: (id: string) => Promise<void>
  updateElement: (id: string, patch: ElementPatch) => Promise<void>
  updatePage: (patch: { name?: string; background?: string | null }) => Promise<void>
  updateDeck: (patch: { title?: string; theme?: string; size?: '16:9' | '4:3' }) => Promise<void>
}

export type PptWorkbenchProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<typeof NS>
  & InjectFace<PptWorkbenchInjected>

const ADD_KINDS: readonly PptElementKind[] = ['text', 'rect', 'ellipse', 'line']

/**
 * 工作台面板。
 * @param props - 会话、显隐、文案与注入的动作。
 * @returns 工作台或空态。
 */
export function PptWorkbench({
  shown, t, usePpt, show, refresh, open, create, undo, redo, exportDeck,
  selectPage, selectElement, setEditing, addPage, removePage, movePage,
  addElement, removeElement, updateElement, updatePage, updateDeck,
}: PptWorkbenchProps) {
  const state = usePpt(snapshot => snapshot)
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (!shown) return undefined
    show(true)
    return () => { show(false) }
  }, [shown, show])

  const project = state.project
  const page = currentPage(project, state.pageIndex)
  const element = page === null
    ? null
    : page.elements.find(entry => entry.id === state.selectedId) ?? null

  const notice = describeNotice(state, t)

  return (
    <div className={css.root} data-busy={state.busy ? 'true' : undefined}>
      <header className={css.toolbar}>
        <span className={css.deckTitle} title={project?.title ?? t('title')}>
          {project?.title ?? t('title')}
        </span>
        <span className={css.badge}>{project === null ? '' : `v${project.revision}`}</span>
        <span className={css.spacer} />
        <button type="button" className={css.action} disabled={state.busy || project?.canUndo !== true}
          title={t('undo')} onClick={() => { void undo() }}>
          <IconChevronUpOutline14 size={14} />
        </button>
        <button type="button" className={css.action} disabled={state.busy || project?.canRedo !== true}
          title={t('redo')} onClick={() => { void redo() }}>
          <IconChevronDownOutline14 size={14} />
        </button>
        <button type="button" className={css.action} title={t('reload')} onClick={refresh}>
          <IconRefreshOutline16 size={14} />
        </button>
        <button type="button" className={css.primary} disabled={state.busy || project === null}
          onClick={() => { void exportDeck() }}>
          <IconDownloadOutline16 size={14} />
          {t('export')}
        </button>
      </header>

      {state.phase === 'error' ? (
        <div className={css.blank}>
          <p className={css.blankTitle}>{t('errorTitle')}</p>
          <button type="button" className={css.primary} onClick={refresh}>{t('errorRetry')}</button>
        </div>
      ) : state.phase === 'loading' ? (
        <div className={css.blank}><p className={css.blankTitle}>{t('loading')}</p></div>
      ) : project === null ? (
        <div className={css.blank}>
          <p className={css.blankTitle}>{t('emptyTitle')}</p>
          <p className={css.blankHint}>{t('emptyHint')}</p>
          {state.projects.length === 0 ? null : (
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
          )}
          <form
            className={css.create}
            onSubmit={(event) => {
              event.preventDefault()
              const next = title.trim()
              if (next === '') return
              void create(next).then(() => { setTitle('') })
            }}
          >
            <input
              type="text"
              value={title}
              placeholder={t('newDeckTitle')}
              aria-label={t('newDeckTitle')}
              onChange={(event) => { setTitle(event.target.value) }}
            />
            <button type="submit" className={css.primary} disabled={state.busy || title.trim() === ''}>
              <IconPlusOutline16 size={14} />
              {t('newDeck')}
            </button>
          </form>
        </div>
      ) : (
        <div className={css.body}>
          <ThumbStrip
            deck={project.deck}
            pageIndex={state.pageIndex}
            busy={state.busy}
            t={t}
            onSelect={selectPage}
            onAdd={() => { void addPage() }}
            onRemove={(next) => { void removePage(next.id) }}
            onMove={(next, to) => { void movePage(next.id, to) }}
          />
          <main className={css.main}>
            <div className={css.addRow}>
              {ADD_KINDS.map(kind => (
                <button key={kind} type="button" className={css.action} disabled={state.busy}
                  title={t(kind === 'text' ? 'addText' : kind === 'rect' ? 'addRect' : kind === 'ellipse' ? 'addEllipse' : 'addLine')}
                  onClick={() => { void addElement(kind) }}>
                  {t(kind === 'text' ? 'addText' : kind === 'rect' ? 'addRect' : kind === 'ellipse' ? 'addEllipse' : 'addLine')}
                </button>
              ))}
            </div>
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
              />
            )}
          </main>
          {page === null ? null : (
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
              onPage={(patch) => { void updatePage(patch) }}
              onDeck={(patch) => { void updateDeck(patch) }}
            />
          )}
        </div>
      )}

      <footer className={css.status} data-tone={notice.tone}>
        <span className={css.statusText}>{notice.text}</span>
      </footer>
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
