import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  IconBranchOutline16, IconChevronRightOutline14, IconDownloadOutline16, IconListPenOutline16,
  IconRefreshOutline16, Modal, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
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

interface GitCredentials {
  username: string
  password: string
  /** 远端操作成功后由 Host 保存这组凭据；只在用户勾选时携带。 */
  remember?: boolean
}

type GitOperationOutcome = 'done' | 'conflict' | {
  authRequired: string
  /** 被拒绝的本机已存凭据引用；存在时界面提示并允许清除它。 */
  credentialRef?: string
}

/** 认证弹窗当前正在处理的一次认证请求与它的已存凭据引用。 */
interface SavedCredential {
  action: 'push' | 'pull'
  remote: string
  credentialRef: string
}

/** Git 概览只通过注入的动作访问当前会话的仓库、本机凭据存储与新会话。 */
export interface GitOverviewInjected {
  status: (sessionId: SessionId) => Promise<GitStatusView | null>
  branches: (sessionId: SessionId) => Promise<GitBranchesView | null>
  checkout: (sessionId: SessionId, branch: string) => Promise<GitStatusView>
  operate: (sessionId: SessionId, action: 'push' | 'pull', credentials?: GitCredentials) => Promise<GitOperationOutcome>
  /** 清除本机为该远端保存的 Git 凭据；本就没有保存时同样成功。 */
  forgetCredentials: (ref: string) => Promise<void>
  resolveConflict: (sessionId: SessionId, prompt: string) => Promise<void>
}

type GitOverviewProps = GitOverviewInjected & PropsLocale<'conversation'> & {
  sessionId: SessionId
  /** 行内分支入口提供锚点时，复用同一操作面板而不绘制概览摘要行。 */
  triggerRef?: RefObject<HTMLButtonElement> | undefined
  controlledOpen?: boolean | undefined
  onControlledClose?: (() => void) | undefined
  /** 分支切换或远端操作改变 HEAD 时，更新工作区行内名称。 */
  onBranchChange?: ((branch: string | null) => void) | undefined
}

/** 概览摘要行与 Hero 分支按钮共用 Git 浮层；任一入口只读取其目标会话。 */
export function GitOverview({
  sessionId, status, branches, checkout, operate, forgetCredentials, resolveConflict, t,
  triggerRef, controlledOpen, onControlledClose, onBranchChange,
}: GitOverviewProps) {
  const [git, setGit] = useState<GitStatusView | null>(null)
  const [branchList, setBranchList] = useState<GitBranchesView | null>(null)
  const [open, setOpen] = useState(false)
  const [showBranches, setShowBranches] = useState(false)
  const popoverId = useId()
  const branchListId = useId()
  const usernameId = useId()
  const passwordId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const anchor = triggerRef ?? trigger
  const isOpen = controlledOpen ?? open
  const popover = useRef<HTMLDivElement>(null)
  const branchTrigger = useRef<HTMLButtonElement>(null)
  const branchMenu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const [branchPosition, setBranchPosition] = useState<CSSProperties | null>(null)
  const [busy, setBusy] = useState<'push' | 'pull' | 'resolve' | 'checkout' | 'forget' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const [auth, setAuth] = useState<{ action: 'push' | 'pull'; remote: string; credentialRef?: string } | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setGit(null)
    setOpen(false)
    setShowBranches(false)
    setBranchList(null)
    setError(null)
    setConflict(false)
    setAuth(null)
    setAuthError(null)
    setPassword('')
    setRemember(false)
    void status(sessionId).then((value) => { if (current) setGit(value) }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { current = false }
  }, [sessionId, status])

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    onControlledClose?.()
    setShowBranches(false)
    if (restoreFocus) queueMicrotask(() => { anchor.current?.focus() })
  }, [anchor, onControlledClose])

  // 浮层脱离卡片滚动裁剪，并随滚动和窗口变化跟随触发行。
  useLayoutEffect(() => {
    if (!isOpen) return
    const place = () => {
      const triggerElement = anchor.current
      const layer = popover.current
      if (!triggerElement || !layer) return
      const rect = triggerElement.getBoundingClientRect()
      const margin = 12
      const gap = 4
      if (rect.width > 0 && (rect.bottom <= margin || rect.top >= window.innerHeight - margin)) {
        close(false)
        return
      }
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
      const branchAnchor = branchTrigger.current
      const menu = branchMenu.current
      if (!branchAnchor || !menu) return
      const branchRect = branchAnchor.getBoundingClientRect()
      const panelRect = layer.getBoundingClientRect()
      if (branchRect.height > 0 && panelRect.height > 0
        && (branchRect.bottom <= panelRect.top || branchRect.top >= panelRect.bottom
          || branchRect.bottom <= margin || branchRect.top >= window.innerHeight - margin)) {
        setShowBranches(false)
        return
      }
      const branchWidth = Math.min(branchRect.width, Math.max(0, window.innerWidth - margin * 2))
      const branchBelow = Math.max(0, window.innerHeight - margin - branchRect.bottom - gap)
      const branchAbove = Math.max(0, branchRect.top - margin - gap)
      const branchUseAbove = branchBelow < Math.min(180, menu.scrollHeight) && branchAbove > branchBelow
      const branchMaxHeight = Math.min(180, branchUseAbove ? branchAbove : branchBelow)
      setBranchPosition({
        left: Math.min(Math.max(branchRect.left, margin), window.innerWidth - branchWidth - margin),
        top: branchUseAbove ? branchRect.top - gap - Math.min(menu.scrollHeight, branchMaxHeight) : branchRect.bottom + gap,
        width: branchWidth,
        maxHeight: branchMaxHeight,
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [isOpen, showBranches, git, error, conflict, busy, anchor, close])

  useEffect(() => {
    if (!isOpen || auth !== null) return
    const isOutside = (target: EventTarget | null): boolean => target instanceof Node
      && !anchor.current?.contains(target) && !popover.current?.contains(target) && !branchMenu.current?.contains(target)
    const onPointerDown = (event: PointerEvent) => { if (isOutside(event.target)) close(false) }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || popover.current?.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
    const onFocusIn = (event: FocusEvent) => { if (isOutside(event.target)) close(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [isOpen, auth, close, anchor])

  if (git === null) return null

  const changeSummary = <>
    {t('overview.git.fileCount', { count: git.files.length })}
    {git.additions > 0 && <> · <span className={css.additions}>+{git.additions}</span></>}
    {git.deletions > 0 && <> <span className={css.deletions}>−{git.deletions}</span></>}
  </>

  const toggleBranches = async () => {
    if (showBranches) {
      setShowBranches(false)
      return
    }
    setError(null)
    try {
      setBranchList(await branches(sessionId))
      setShowBranches(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const switchBranch = async (branch: string) => {
    if (branch === git.branch) {
      setShowBranches(false)
      return
    }
    setBusy('checkout')
    setError(null)
    setConflict(false)
    try {
      const next = await checkout(sessionId, branch)
      setGit(next)
      onBranchChange?.(next.branch)
      setShowBranches(false)
      setBranchList(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const run = async (action: 'push' | 'pull', credentials?: GitCredentials) => {
    setBusy(action)
    setError(null)
    setAuthError(null)
    setConflict(false)
    try {
      const outcome = await operate(sessionId, action, credentials)
      if (typeof outcome === 'object') {
        setAuth({
          action,
          remote: outcome.authRequired,
          ...(outcome.credentialRef === undefined ? {} : { credentialRef: outcome.credentialRef }),
        })
        close(false)
      } else if (outcome === 'conflict') {
        setConflict(true)
      } else {
        setAuth(null)
        setUsername('')
        setPassword('')
        setRemember(false)
        const next = await status(sessionId)
        setGit(next)
        onBranchChange?.(next?.branch ?? null)
        setToast(value => ({ seq: (value?.seq ?? 0) + 1, text: t('overview.git.done') }))
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      if (auth !== null) setAuthError(message)
      else setError(message)
    } finally {
      setBusy(null)
    }
  }

  const solve = async () => {
    setBusy('resolve')
    setError(null)
    try {
      await resolveConflict(sessionId, t('overview.git.solvePrompt'))
      setConflict(false)
      close(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const cancelAuth = () => {
    if (busy !== null) return
    setAuth(null)
    setAuthError(null)
    setUsername('')
    setPassword('')
    setRemember(false)
    setError(null)
    anchor.current?.focus()
  }

  /** 清除被拒绝的本机凭据：弹窗留在原位，用户可接着输入新的一组。 */
  const forget = async (saved: SavedCredential) => {
    setBusy('forget')
    setAuthError(null)
    try {
      await forgetCredentials(saved.credentialRef)
      setAuth({ action: saved.action, remote: saved.remote })
    } catch (reason) {
      setAuthError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const submitAuth = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (auth === null || !username || !password || busy !== null) return
    setAuthError(null)
    const credentials = { username, password, ...(remember ? { remember: true } : {}) }
    setPassword('')
    void run(auth.action, credentials)
  }

  // 已存凭据引用只在被拒时存在；提前取出，回调里就不必再收窄可能为 null 的弹窗状态。
  const saved = auth?.credentialRef === undefined ? null : {
    action: auth.action, remote: auth.remote, credentialRef: auth.credentialRef,
  }

  return (
    <section
      data-overview-git={triggerRef === undefined ? '' : undefined}
      className={triggerRef === undefined ? css.root : undefined}
      aria-label={triggerRef === undefined ? t('overview.git.title') : undefined}
    >
      {triggerRef === undefined && <button ref={trigger} type="button" className={css.row} aria-expanded={isOpen} aria-controls={popoverId}
        onClick={() => { if (isOpen) close(false); else setOpen(true) }}>
        <span className={css.rowIcon} aria-hidden="true"><IconBranchOutline16 /></span>
        <span className={css.rowLabel}>{t('overview.git.title')}</span>
        <span className={css.rowSummary}>{changeSummary}</span>
        <IconChevronRightOutline14 className={isOpen ? css.chevronOpen : css.chevron} aria-hidden="true" />
      </button>}
      {isOpen && createPortal(
        <div ref={popover} id={popoverId} className={css.popover} role="region" aria-label={t('overview.git.title')}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) } }}>
          <button ref={branchTrigger} type="button" className={css.branchButton} aria-expanded={showBranches}
            aria-controls={branchListId} disabled={busy !== null} onClick={() => { void toggleBranches() }}>
            <span className={css.branchLabel}>
              <span className={css.metricIcon} aria-hidden="true"><IconBranchOutline16 /></span>
              <span className={css.metricLabel}>{t('overview.git.branches')}</span>
            </span>
            <span className={css.branchCurrent} title={git.branch ?? undefined}>{git.branch ?? t('overview.git.detached')}</span>
            <IconChevronRightOutline14 className={showBranches ? css.chevronOpen : css.chevron} aria-hidden="true" />
          </button>
          {showBranches && branchList && <div ref={branchMenu} id={branchListId} className={css.branchList} role="group"
            aria-label={t('overview.git.branchList')}
            style={branchPosition ?? { visibility: 'hidden', left: 0, top: 0 }}>
            {branchList.branches.map(branch => <button key={branch} type="button" className={css.branchOption}
              aria-current={branch === git.branch ? 'true' : undefined} disabled={busy !== null}
              onClick={() => { void switchBranch(branch) }}>{branch}</button>)}
          </div>}
          <div className={css.metrics}>
            {git.files.length > 0 && <div className={css.metricRow}>
              <span className={css.metricHeading}>
                <span className={css.metricIcon} aria-hidden="true"><IconListPenOutline16 /></span>
                <span className={css.metricLabel}>{t('overview.git.changesLabel')}</span>
              </span>
              <span className={css.metricValue}>{changeSummary}</span>
            </div>}
            {(git.ahead > 0 || git.behind > 0) && <div className={css.metricRow}>
              <span className={css.metricHeading}>
                <span className={css.metricIcon} aria-hidden="true"><IconRefreshOutline16 /></span>
                <span className={css.metricLabel}>{t('overview.git.syncLabel')}</span>
              </span>
              <span className={css.metricValue}>{t('overview.git.sync', { ahead: git.ahead, behind: git.behind })}</span>
            </div>}
          </div>
          <div className={css.actions}>
            <button type="button" disabled={busy !== null} onClick={() => { void run('push') }}>
              <IconDownloadOutline16 className={css.pushIcon} aria-hidden="true" />
              {busy === 'push' ? t('overview.git.pushRunning') : t('overview.git.push')}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => { void run('pull') }}>
              <IconDownloadOutline16 aria-hidden="true" />
              {busy === 'pull' ? t('overview.git.pullRunning') : t('overview.git.pull')}
            </button>
          </div>
          {conflict && <div role="alert" className={css.feedback}>
            <p>{t('overview.git.conflict')}</p>
            <button type="button" disabled={busy !== null} onClick={() => { void solve() }}>
              {busy === 'resolve' ? t('overview.git.solving') : t('overview.git.solve')}
            </button>
          </div>}
          {error && <p role="alert" className={css.error}>{error}</p>}
        </div>, document.body,
      )}
      {auth === null && toast && <Toast key={toast.seq} text={toast.text} onDone={() => { setToast(null) }} />}
      <Modal open={auth !== null} trapFocus onClose={cancelAuth} title={t('overview.git.auth.title')}
        closeLabel={t('overview.git.auth.cancel')} description={t('overview.git.auth.description', { remote: auth?.remote ?? '' })}
        footer={<div className={css.authActions}>
          <button type="button" disabled={busy !== null} onClick={cancelAuth}>{t('overview.git.auth.cancel')}</button>
          <button type="submit" form={`dsh-git-auth-form-${usernameId}`} disabled={busy !== null || !username || !password}>
            {busy !== null ? t('overview.git.auth.running') : t('overview.git.auth.submit')}
          </button>
        </div>}>
        <form id={`dsh-git-auth-form-${usernameId}`} className={css.authForm} onSubmit={submitAuth}>
          <label htmlFor={usernameId}>{t('overview.git.auth.username')}</label>
          <input id={usernameId} autoComplete="username" value={username} onChange={(event) => { setUsername(event.target.value) }} />
          <label htmlFor={passwordId}>{t('overview.git.auth.password')}</label>
          <input id={passwordId} type="password" autoComplete="current-password" value={password}
            onChange={(event) => { setPassword(event.target.value) }} />
          <label className={css.authRemember}>
            <input type="checkbox" checked={remember} disabled={busy !== null}
              onChange={(event) => { setRemember(event.target.checked) }} />
            <span>{t('overview.git.auth.remember')}</span>
          </label>
          {saved !== null && <div className={css.authStale}>
            <p>{t('overview.git.auth.stale', { remote: saved.remote })}</p>
            <button type="button" disabled={busy !== null} onClick={() => { void forget(saved) }}>
              {busy === 'forget' ? t('overview.git.auth.forgetting') : t('overview.git.auth.forget')}
            </button>
          </div>}
          {authError && <p role="alert" className={css.error}>{authError}</p>}
        </form>
      </Modal>
    </section>
  )
}
