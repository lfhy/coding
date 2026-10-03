import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { JobView } from '@deepseek-ai/dsh-client-runtime/client'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './JobListAction.module.css'

/** 概览后台任务子 slot 的会话 props 与本地化接口。 */
export type JobListActionProps =
  PropsRuntime<'conversation.overview.jobs'> & PropsLocale<typeof NS>

/** Stable empty list so a session with no jobs keeps one array identity. */
const NO_TASKS: readonly JobView[] = []

/** A job the registry still holds open, and whose duration therefore ticks. */
function isLive(job: JobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/** Closed-union exhaustiveness fence for the wire status set. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a status is forged */
function assertNever(value: never): never {
  throw new Error(`unhandled job status: ${JSON.stringify(value)}`)
}

/**
 * Status marker semantics. `stopping` and `killed` share the attention color:
 * both mean the work ended (or is ending) on request rather than on its own.
 */
function dotState(status: JobView['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'stopping': return 'warning'
    case 'completed': return 'done'
    case 'killed': return 'warning'
    case 'failed': return 'error'
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

/** Human status word for the row and its accessible name. */
function statusLabel(status: JobView['status'], t: TranslateNS<typeof NS>): string {
  switch (status) {
    case 'running': return t('status.running')
    case 'stopping': return t('status.stopping')
    case 'completed': return t('status.completed')
    case 'killed': return t('status.killed')
    case 'failed': return t('status.failed')
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

/**
 * Elapsed time in at most two adjacent units. A background job that outlives
 * an hour is already exceptional, so hours is the widest unit — beyond that the
 * figure stays in hours rather than growing a day/month vocabulary no producer
 * currently reaches.
 */
function formatDuration(elapsedMs: number, t: TranslateNS<typeof NS>): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1_000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600)
  if (hours > 0) return t('duration.hours', { hours, minutes })
  if (minutes > 0) return t('duration.minutes', { minutes, seconds })
  return t('duration.seconds', { seconds })
}

/**
 * Live rows first in start order, then settled rows newest-first. Two jobs
 * that settled in the same millisecond fall back to start order, so the sort
 * never depends on the host's map iteration.
 */
function ordered(jobs: readonly JobView[]): JobView[] {
  return [...jobs].sort((left, right) => {
    const liveLeft = isLive(left)
    if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1
    if (liveLeft) return left.startedAt - right.startedAt
    const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    return finished !== 0 ? finished : left.startedAt - right.startedAt
  })
}

/**
 * 概览协作行展开后的后台任务列表；无任务时仍保留空列表语义。
 * @param props - 会话镜像、收起动作与本地化接口。
 * @returns 按活动状态和结算时间排序的任务列表。
 */
export function JobListAction({ sessionId, useSessions, collapse, t }: JobListActionProps) {
  const jobs = useSessions(state => state.jobsBySession[sessionId]) ?? NO_TASKS
  const [now, setNow] = useState(() => Date.now())

  const rows = useMemo(() => ordered(jobs), [jobs])
  const liveCount = useMemo(() => jobs.filter(isLive).length, [jobs])

  useEffect(() => {
    if (liveCount === 0) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [liveCount])

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    collapse()
  }

  return (
    <ul className={css.menu} aria-label={t('list.aria')} onKeyDown={onKeyDown}>
      {rows.map((job) => {
        const live = isLive(job)
        const elapsed = live ? now - job.startedAt : (job.finishedAt ?? job.startedAt) - job.startedAt
        const duration = formatDuration(elapsed, t)
        const status = statusLabel(job.status, t)
        return (
          <li key={job.id} className={live ? css.row : `${css.row} ${css.rowSettled}`}>
            <StateDot state={dotState(job.status)} className={css.rowDot} />
            <span className={css.kind}>{job.kind}</span>
            <span className={css.label} title={job.label}>{job.label}</span>
            <span className={css.status} title={job.detail ?? status}>{job.detail ?? status}</span>
            <span
              className={css.duration}
              title={t(live ? 'duration.title.live' : 'duration.title.done', { duration })}
            >
              {duration}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
