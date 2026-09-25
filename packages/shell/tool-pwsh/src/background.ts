/**
 * Generic-task adaptation for background pwsh process handles — the shell-agnostic
 * twin of `dsh-tool-bash`'s background adaptation.
 * @module @deepseek-ai/dsh-tool-pwsh/background
 */

import type { ShellProcess } from '@deepseek-ai/dsh-shell'

/* jscpd:ignore-start -- deliberate twin of dsh-tool-bash/background.ts (design record). */

/**
 * 将后台进程的结算事实映射为任务结果。provider 失败只报告结果未知，不泄露错误原文；
 * 非零命令退出仍是 `completed`，信号退出才是 `killed`。
 * @param proc - 已结算的进程句柄。
 * @returns 提供给 `ctx.jobs` 的结果。
 */
export function processOutcome(proc: ShellProcess): { status: 'completed' | 'killed' | 'failed'; detail: string } {
  if (proc.status === 'failed') return { status: 'failed', detail: 'process outcome unknown' }
  if (proc.status === 'killed') {
    return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
  }
  return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
}
/* jscpd:ignore-end */
