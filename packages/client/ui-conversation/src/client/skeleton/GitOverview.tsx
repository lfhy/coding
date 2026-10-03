import { useEffect, useId, useRef, useState } from 'react'
import { IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
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

interface GitBranchesView {
  branches: string[]
  current: string | null
}

/** Git 概览只通过注入的动作访问当前会话的仓库与新会话。 */
export interface GitOverviewInjected {
  status: (sessionId: SessionId) => Promise<GitStatusView | null>
  branches: (sessionId: SessionId) => Promise<GitBranchesView | null>
  checkout: (sessionId: SessionId, branch: string) => Promise<GitStatusView>
  operate: (sessionId: SessionId, action: 'push' | 'pull') => Promise<'done' | 'conflict'>
  resolveConflict: (sessionId: SessionId, prompt: string) => Promise<void>
}

type GitOverviewProps = PropsRuntime<'conversation.overview.git'> & PropsLocale<'conversation'> & GitOverviewInjected

/** 非 Git 工作区不占概览空间；分支切换失败时保留原状态与错误供用户重试。 */
export function GitOverview({ sessionId, status, branches, checkout, operate, resolveConflict, t }: GitOverviewProps) {
  const [git, setGit] = useState<GitStatusView | null>(null)
  const [branchList, setBranchList] = useState<GitBranchesView | null>(null)
  const [branchOpen, setBranchOpen] = useState(false)
  const branchListId = useId()
  const branchButton = useRef<HTMLButtonElement>(null)
  const branchPanel = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState<'push' | 'pull' | 'resolve' | 'checkout' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<'done' | 'conflict' | null>(null)

  useEffect(() => {
    let current = true
    setGit(null)
    setBranchOpen(false)
    setBranchList(null)
    setError(null)
    setNotice(null)
    void status(sessionId).then((value) => { if (current) setGit(value) }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { current = false }
  }, [sessionId, status])

  useEffect(() => {
    if (!branchOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !branchButton.current?.contains(event.target)
        && !branchPanel.current?.contains(event.target)) setBranchOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setBranchOpen(false)
      branchButton.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [branchOpen])

  if (git === null) return null

  const toggleBranches = async () => {
    if (branchOpen) {
      setBranchOpen(false)
      return
    }
    setError(null)
    try {
      setBranchList(await branches(sessionId))
      setBranchOpen(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const switchBranch = async (branch: string) => {
    if (branch === git.branch) {
      setBranchOpen(false)
      return
    }
    setBusy('checkout')
    setError(null)
    setNotice(null)
    try {
      setGit(await checkout(sessionId, branch))
      setBranchOpen(false)
      setBranchList(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

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
        {git.branch && <button ref={branchButton} type="button" className={css.branchButton} title={git.branch}
          aria-label={t('overview.git.branches', { branch: git.branch })}
          aria-expanded={branchOpen} aria-controls={branchListId} disabled={busy !== null}
          onClick={() => { void toggleBranches() }}>
          <span>{git.branch}</span><IconChevronRightOutline14 aria-hidden="true" />
        </button>}
      </div>
      {branchOpen && branchList && <div ref={branchPanel} id={branchListId} className={css.branchList} role="group" aria-label={t('overview.git.branchList')}>
        {branchList.branches.map(branch => <button key={branch} type="button" className={css.branchOption}
          aria-current={branch === git.branch ? 'true' : undefined} disabled={busy !== null}
          onClick={() => { void switchBranch(branch) }}>{branch}</button>)}
      </div>}
      <div className={css.metrics}>
        {git.files.length > 0 && <div className={css.metricRow}>
          <span className={css.metricLabel}>{t('overview.git.changesLabel')}</span>
          <span className={css.metricValue}>
            {t('overview.git.fileCount', { count: git.files.length })}
            {git.additions > 0 && <> · <span className={css.additions}>+{git.additions}</span></>}
            {git.deletions > 0 && <> <span className={css.deletions}>−{git.deletions}</span></>}
          </span>
        </div>}
        {(git.ahead > 0 || git.behind > 0) && <div className={css.metricRow}>
          <span className={css.metricLabel}>{t('overview.git.syncLabel')}</span>
          <span className={css.metricValue}>{t('overview.git.sync', { ahead: git.ahead, behind: git.behind })}</span>
        </div>}
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
