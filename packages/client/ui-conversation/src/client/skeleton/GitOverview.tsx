import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import css from './GitOverview.module.css'

interface GitStatusView {
  branch: string | null
  ahead: number
  behind: number
  additions: number
  deletions: number
  files: readonly { path: string }[]
}

/** Git 概览只通过注入的动作访问当前会话的仓库与新会话。 */
export interface GitOverviewInjected {
  status: (sessionId: SessionId) => Promise<GitStatusView | null>
  operate: (sessionId: SessionId, action: 'push' | 'pull') => Promise<'done' | 'conflict'>
  resolveConflict: (sessionId: SessionId, prompt: string) => Promise<void>
}

type GitOverviewProps = PropsRuntime<'conversation.overview.git'> & PropsLocale<'conversation'> & GitOverviewInjected

/** 非 Git 工作区不占概览空间；远端操作的错误保留在本地供用户重试。 */
export function GitOverview({ sessionId, status, operate, resolveConflict, t }: GitOverviewProps) {
  const [git, setGit] = useState<GitStatusView | null>(null)
  const [busy, setBusy] = useState<'push' | 'pull' | 'resolve' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<'done' | 'conflict' | null>(null)

  useEffect(() => {
    let current = true
    setGit(null)
    setError(null)
    setNotice(null)
    void status(sessionId).then((value) => { if (current) setGit(value) }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { current = false }
  }, [sessionId, status])

  if (git === null) return null

  const run = async (action: 'push' | 'pull') => {
    setBusy(action)
    setError(null)
    setNotice(null)
    try {
      const outcome = await operate(sessionId, action)
      setNotice(outcome)
      setGit(await status(sessionId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const solve = async () => {
    setBusy('resolve')
    setError(null)
    try {
      await resolveConflict(sessionId, t('overview.git.solvePrompt'))
      setNotice(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section data-overview-git className={css.root} aria-label={t('overview.git.title')}>
      <div className={css.header}>
        <h2 className={css.title}>{t('overview.git.title')}</h2>
        {git.branch && <span className={css.branch} title={git.branch}>{git.branch}</span>}
      </div>
      <div className={css.metrics}>
        <p className={css.changes}>{t('overview.git.changes', {
          count: git.files.length, additions: git.additions, deletions: git.deletions,
        })}</p>
        {(git.ahead > 0 || git.behind > 0) && <p className={css.sync}>{t('overview.git.sync', {
          ahead: git.ahead, behind: git.behind,
        })}</p>}
      </div>
      <div className={css.actions}>
        <button type="button" disabled={busy !== null} onClick={() => { void run('push') }}>
          {busy === 'push' ? t('overview.git.pushRunning') : t('overview.git.push')}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => { void run('pull') }}>
          {busy === 'pull' ? t('overview.git.pullRunning') : t('overview.git.pull')}
        </button>
      </div>
      {notice === 'done' && <p role="status" className={css.notice}>{t('overview.git.done')}</p>}
      {notice === 'conflict' && <div role="alert" className={css.feedback}>
        <p>{t('overview.git.conflict')}</p>
        <button type="button" disabled={busy !== null} onClick={() => { void solve() }}>
          {busy === 'resolve' ? t('overview.git.solving') : t('overview.git.solve')}
        </button>
      </div>}
      {error && <p role="alert" className={css.error}>{error}</p>}
    </section>
  )
}
