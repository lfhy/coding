import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { summarizeVisibleSubagents, type JobView } from '@deepseek-ai/dsh-client-runtime/client'
import { IconAgentPresetOutline16, IconChecklistOutline14, IconChevronRightOutline14, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 投影键由各自能力包声明，卡片只消费现有会话数据。
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { formatTokensPerSecond } from '../chat/message-chrome.ts'
import {
  billedInputTokens, cacheHitPercent, deriveStats, formatDuration, formatTokens,
} from '../chat/StatsLine.tsx'
import css from './OverviewCard.module.css'

const NO_JOBS: readonly JobView[] = []

/** 对话页面内会话概览的框架派生 props。 */
export type OverviewCardProps = PropsRuntime<'conversation.overview'>
  & PropsRenderSlots<'conversation.overview.subagents' | 'conversation.overview.jobs' | 'conversation.overview.git'>
  & PropsLocale<'conversation'>

/**
 * 展示当前会话的协作计数与全日志运行统计；缺少投影时仅回退到已加载窗口。
 * @param props - 会话数据、页内展开状态及本地化文本。
 * @returns 对话页内的信息卡，收起时保留隐藏的受控区域。
 */
export function OverviewCard({
  sessionId, useSession, useSessions, useProjection, overviewExpanded, toggleOverview, renderSlot, t,
}: OverviewCardProps) {
  const [expanded, setExpanded] = useState<'subagents' | 'jobs' | null>(null)
  const popoverId = useId()
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const subagentsButton = useRef<HTMLButtonElement>(null)
  const jobsButton = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const collapse = useCallback((row: 'subagents' | 'jobs'): void => {
    setExpanded(null)
    queueMicrotask(() => { (row === 'subagents' ? subagentsButton : jobsButton).current?.focus() })
  }, [])

  useLayoutEffect(() => { setExpanded(null) }, [sessionId, overviewExpanded])

  // 固定定位的浮层脱离概览卡滚动裁剪；捕获滚动可跟随嵌套滚动容器中的锚点。
  useLayoutEffect(() => {
    if (expanded === null || !overviewExpanded) return
    const place = () => {
      const anchor = (expanded === 'subagents' ? subagentsButton : jobsButton).current
      const layer = popover.current
      if (anchor === null || layer === null) return
      const rect = anchor.getBoundingClientRect()
      const margin = 12
      if (rect.width > 0 && (rect.bottom <= margin || rect.top >= window.innerHeight - margin)) {
        setExpanded(null)
        return
      }
      const gap = 4
      const width = Math.min(288, Math.max(0, window.innerWidth - margin * 2))
      const below = Math.max(0, window.innerHeight - margin - rect.bottom - gap)
      const above = Math.max(0, rect.top - margin - gap)
      const useAbove = below < 240 && above > below
      const maxHeight = Math.min(440, useAbove ? above : below)
      const height = Math.min(layer.scrollHeight, maxHeight)
      setPosition({
        left: Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin),
        top: useAbove ? Math.max(margin, rect.top - gap - height) : Math.min(rect.bottom + gap, window.innerHeight - margin),
        width,
        maxHeight,
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [expanded, overviewExpanded])

  useEffect(() => {
    if (expanded === null || !overviewExpanded) return
    const isOutside = (target: EventTarget | null): boolean => target instanceof Node
      && !popover.current?.contains(target)
      && !subagentsButton.current?.contains(target)
      && !jobsButton.current?.contains(target)
    const onPointerDown = (event: PointerEvent) => {
      if (isOutside(event.target)) setExpanded(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (popover.current?.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
      collapse(expanded)
    }
    const onFocusIn = (event: FocusEvent) => {
      if (isOutside(event.target)) setExpanded(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [expanded, overviewExpanded, collapse])
  const summaries = useSessions(state => state.byId)
  const catalog = useSessions(state => state.subagentsByParent[sessionId])
  const jobs = useSessions(state => state.jobsBySession[sessionId]) ?? NO_JOBS
  const descendants = useMemo(
    () => summarizeVisibleSubagents(summaries, sessionId, catalog),
    [summaries, sessionId, catalog],
  )
  const childCount = descendants.count
  const runningChildren = descendants.runningCount
  const runningJobs = jobs.filter(job => job.status === 'running' || job.status === 'stopping').length

  const settledNodes = useSession(snapshot => snapshot.chat.legacy.nodes)
  const projected = useProjection('sessionStats')
  const usage = useProjection('tokenUsage')
  const stats = useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])
  const inputTokens = usage === undefined ? 0 : billedInputTokens(usage)
  const hasUsage = usage !== undefined && (inputTokens > 0 || usage.outputTokens > 0)
  const cacheHit = usage === undefined ? null : cacheHitPercent(usage)

  return (
    <div className={css.root}>
      <section id="dsh-conversation-overview" className={css.card} hidden={!overviewExpanded} aria-label={t('overview.title')}>
        <button
          type="button"
          className={css.close}
          aria-label={t('overview.collapse')}
          title={t('overview.collapse')}
          onClick={() => {
            setExpanded(null)
            toggleOverview()
            queueMicrotask(() => { document.getElementById('dsh-conversation-overview-toggle')?.focus() })
          }}
        >
          <span aria-hidden="true"><IconCloseOutline16 size={14} /></span>
        </button>

        <div className={css.group}>
          <h2 className={css.groupTitle}>{t('overview.collaboration')}</h2>
          <div className={css.counts}>
            <div className={css.collaborationEntry}>
              <button
                ref={subagentsButton}
                type="button"
                className={css.countRow}
                aria-expanded={expanded === 'subagents'}
                aria-controls={popoverId}
                onClick={() => { setExpanded(value => value === 'subagents' ? null : 'subagents') }}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowDown') return
                  event.preventDefault()
                  setExpanded('subagents')
                  queueMicrotask(() => {
                    popover.current?.querySelector<HTMLElement>('[role="treeitem"]')?.focus()
                  })
                }}
              >
                <span className={css.rowIcon} aria-hidden="true"><IconAgentPresetOutline16 /></span>
                <span className={css.countLabel}>{t('overview.subagents')}</span>
                <span className={css.countValue}>
                  <strong>{childCount}</strong>
                  {runningChildren > 0 && <span>{t('overview.runningCount', { count: runningChildren })}</span>}
                </span>
                <IconChevronRightOutline14 className={expanded === 'subagents' ? css.chevronOpen : css.chevron} />
              </button>
            </div>
            <div className={css.collaborationEntry}>
              <button
                ref={jobsButton}
                type="button"
                className={css.countRow}
                aria-expanded={expanded === 'jobs'}
                aria-controls={popoverId}
                onClick={() => { setExpanded(value => value === 'jobs' ? null : 'jobs') }}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowDown') return
                  event.preventDefault()
                  setExpanded('jobs')
                  queueMicrotask(() => {
                    popover.current?.querySelector<HTMLElement>('button, [tabindex="0"]')?.focus()
                  })
                }}
              >
                <span className={css.rowIcon} aria-hidden="true"><IconChecklistOutline14 /></span>
                <span className={css.countLabel}>{t('overview.jobs')}</span>
                <span className={css.countValue}>
                  <strong>{jobs.length}</strong>
                  {runningJobs > 0 && <span>{t('overview.runningCount', { count: runningJobs })}</span>}
                </span>
                <IconChevronRightOutline14 className={expanded === 'jobs' ? css.chevronOpen : css.chevron} />
              </button>
            </div>
          </div>
        </div>

        {renderSlot('conversation.overview.git', {})}

        <div className={css.group}>
          <h2 className={css.groupTitle}>{t('overview.statistics')}</h2>
          <dl className={css.metrics}>
            <div><dt>{t('overview.turns')}</dt><dd>{stats.turns}</dd></div>
            <div><dt>{t('overview.steps')}</dt><dd>{stats.steps}</dd></div>
            {stats.llmMs > 0 && <div><dt>{t('overview.llmTime')}</dt><dd>{formatDuration(stats.llmMs)}</dd></div>}
            {stats.toolMs > 0 && <div><dt>{t('overview.toolTime')}</dt><dd>{formatDuration(stats.toolMs)}</dd></div>}
            {stats.ttftSteps > 0 && (
              <div><dt>{t('overview.ttft')}</dt><dd>{formatDuration(stats.ttftMs / stats.ttftSteps)}</dd></div>
            )}
            {stats.decodeMs > 0 && (
              <div>
                <dt>{t('overview.throughput')}</dt>
                <dd>{t('stats.tokensPerSecond', {
                  throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
                })}</dd>
              </div>
            )}
            {hasUsage && (
              <>
                {cacheHit !== null && <div><dt>{t('overview.cacheHit')}</dt><dd>{cacheHit}%</dd></div>}
                <div><dt>{t('overview.inputTokens')}</dt><dd>{formatTokens(inputTokens)} tok</dd></div>
                <div><dt>{t('overview.outputTokens')}</dt><dd>{formatTokens(usage.outputTokens)} tok</dd></div>
              </>
            )}
          </dl>
        </div>
      </section>
      {overviewExpanded && expanded !== null && createPortal(
        <div
          ref={popover}
          id={popoverId}
          className={css.collaborationPopover}
          role="region"
          aria-label={expanded === 'subagents' ? t('overview.subagents') : t('overview.jobs')}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
        >
          {expanded === 'subagents'
            ? renderSlot('conversation.overview.subagents', { collapse: () => { collapse('subagents') } })
            : renderSlot('conversation.overview.jobs', { collapse: () => { collapse('jobs') } })}
        </div>,
        document.body,
      )}
    </div>
  )
}
