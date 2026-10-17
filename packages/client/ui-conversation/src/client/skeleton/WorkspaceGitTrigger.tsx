// 空白会话工作区行右侧的 Git 分支入口：仅当前会话所属工作区进入探测，
// 非仓库或远程工作区不显示按钮；浮层复用概览里的 Git 操作面板。
import { useEffect, useRef, useState } from 'react'
import { IconBranchOutline16 } from 'coding-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { SessionId } from 'coding-client-runtime/client'
import { GitOverview, type GitOverviewInjected } from './GitOverview.tsx'
import css from './WorkspaceGit.module.css'

/** 行内分支按钮的完整属性：Git 访问面 + 行份额 + 本地化文本。 */
export type WorkspaceGitTriggerProps = PropsRuntime<'conversation.hero.git'> & PropsLocale<'conversation'> & GitOverviewInjected

/**
 * 在空白会话的工作区行里渲染分支按钮与它打开的 Git 操作面板。
 * @param props - 当前工作区会话、Git 访问面与本地化文本。
 * @returns 分支按钮与（打开时的）共享 Git 面板。
 */
export function WorkspaceGitTrigger({
  sessionId, status, branches, checkout, operate, forgetCredentials, archiveSession, resolveConflict, t,
}: WorkspaceGitTriggerProps) {
  const button = useRef<HTMLButtonElement>(null)
  const [gitSessionId, setGitSessionId] = useState<SessionId | undefined>()
  const [branch, setBranch] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  // 行内只探测正在呈现的工作区会话，不在渲染过程中创建会话。
  useEffect(() => {
    setOpen(false)
    setGitSessionId(undefined)
    setBranch(null)
    if (sessionId === undefined) return
    let current = true
    void status(sessionId).then((result) => {
      if (current && result !== null) {
        setGitSessionId(sessionId)
        setBranch(result.branch ?? '')
      }
    }).catch(() => { /* 非 Git 或远程工作区不渲染分支入口。 */ })
    return () => { current = false }
  }, [sessionId, status])

  if (gitSessionId === undefined || branch === null) return null

  return (
    <span className={css.wrapper} data-workspace-git>
      <button
        ref={button}
        type="button"
        className={css.trigger}
        aria-label={t('overview.git.branch')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={branch || t('overview.git.detached')}
        onPointerDown={(event) => { event.stopPropagation() }}
        onClick={() => { setOpen(value => !value) }}
      >
        <IconBranchOutline16 className={css.triggerIcon} size={14} aria-hidden="true" />
        <span className={css.triggerLabel}>{branch || t('overview.git.detached')}</span>
      </button>
      <GitOverview
        sessionId={gitSessionId}
        status={status}
        branches={branches}
        checkout={checkout}
        operate={operate}
        forgetCredentials={forgetCredentials}
        resolveConflict={resolveConflict}
        archiveSession={async (id) => { await archiveSession(id) }}
        t={t}
        triggerRef={button}
        controlledOpen={open}
        onControlledClose={() => { setOpen(false) }}
        onBranchChange={setBranch}
      />
    </span>
  )
}
