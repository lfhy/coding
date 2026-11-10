/** 在常驻对话列中渲染会话页头与主体；空白会话保留输入区节点。 */

import { useEffect, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconChecklistOutline14, IconNewChatOutline16 } from 'coding-client-ui-primitives'
import type {
  ConversationSessionHeaderSlotProps, ConversationSessionSlotProps,
} from '../contract/slots.ts'
import type { ViewTab } from '../contract/views.ts'
import css from './ConversationRoot.module.css'

/** 会话主体从严格会话作用域取得的完整属性。 */
export type ConversationSessionProps = ConversationSessionSlotProps

/** 页头从严格会话作用域取得的完整属性。 */
export type ConversationSessionHeaderProps = ConversationSessionHeaderSlotProps

const DEFAULT_VIEW_ID = 'chat'

/** 已保存的视图失效时，仍显示默认对话视图。 */
function resolveActiveView(tabs: readonly ViewTab[], selectedId: string | null): ViewTab | undefined {
  const requestedId = selectedId ?? DEFAULT_VIEW_ID
  return tabs.find(view => view.id === requestedId)
    ?? tabs.find(view => view.id === DEFAULT_VIEW_ID)
}

/**
 * 在常驻滚动区上方渲染当前会话的模式、操作和视图切换。
 * @param props - 会话快照、视图列表及页头操作。
 * @returns 空白会话隐藏的页头，或已开始会话的操作行。
 */
export function ConversationSessionHeader({
  useSession, useStore, actions,
  renderSlot, views, startSession, overviewExpanded, toggleOverview, t,
}: ConversationSessionHeaderProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const tabs = views.list()
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const composerPhase = useSession(s => s.composerPhase)
  const blank = useSession(s => s.blank)
  const hideChrome = blank && composerPhase === 'blank'

  return (
    <header
      className={clsx(css.header, hideChrome && css.headerHidden)}
      data-active-view={active?.id}
      aria-hidden={hideChrome || undefined}
    >
      {!hideChrome && (
        <>
          <div className={css.activeHeaderDragStrip} data-window-drag-header-strip data-window-drag-region aria-hidden="true" />
          <div className={css.titleRow} data-window-drag-region>
            <div className={css.titleCluster}>
              <div className={css.headerActions}>
                {renderSlot('conversation.session.header.actions', {})}
              </div>
              <button
                id="dsh-conversation-overview-toggle"
                type="button"
                className={css.headerNewSession}
                aria-label={t('session.new.label')}
                title={t('session.new.label')}
                onClick={() => { startSession() }}
              >
                <IconNewChatOutline16 size={14} />
              </button>
            </div>
            {/* 操作先于视图切换以保留键盘顺序；网格列使视图切换居中。 */}
            <div className={css.headerUtilities}>
              <button
                type="button"
                className={css.overviewToggle}
                data-expanded={overviewExpanded || undefined}
                aria-expanded={overviewExpanded}
                aria-controls="dsh-conversation-overview"
                aria-label={t(overviewExpanded ? 'overview.collapse' : 'overview.expand')}
                title={t(overviewExpanded ? 'overview.collapse' : 'overview.expand')}
                onClick={toggleOverview}
              >
                <IconChecklistOutline14 size={16} />
              </button>
              {renderSlot('conversation.session.header.utilities', {})}
            </div>
            {tabs.length > 1 && (
              <div className={css.tabs} role="tablist" data-window-drag-region>
                {tabs.map(viewTab => (
                  <button
                    key={viewTab.id}
                    type="button"
                    role="tab"
                    aria-selected={viewTab.id === active?.id}
                    className={clsx(css.tab, viewTab.id === active?.id && css.tabActive)}
                    onClick={() => { actions.setView(viewTab.id) }}
                  >
                    {viewTab.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </header>
  )
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function ConversationSession({
  sessionId, useSession, useInput, inputActions, useStore, actions,
  renderSlot, views, bindDraftMirror, releaseSessionImages,
}: ConversationSessionProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const tabs = views.list()
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const composerPhase = useSession(s => s.composerPhase)
  const blank = useSession(s => s.blank)
  const inputState = useInput(s => s)
  const storedDraft = useStore(s => s.draft)
  // `?? null`: persisted snapshots from before the inspect field rehydrate without it.
  const inspect = useStore(s => s.inspect ?? null)

  useEffect(() => {
    if (inputState.draft === '' && storedDraft !== '') inputActions.setDraft(storedDraft)
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // Mount-only (deps pinned to inputActions): later store writes come from
    // the machine mirror, not this seed effect.
  }, [inputActions])

  useEffect(() => () => {
    releaseSessionImages(sessionId)
  }, [releaseSessionImages, sessionId])

  if (blank && composerPhase === 'blank') return null
  return (
    <div className={css.viewArea}>
      {active !== undefined && renderSlot('conversation.view', {
        inspect,
        onInspectDone: () => { actions.setInspect(null) },
      }, { only: active.id })}
    </div>
  )
}
