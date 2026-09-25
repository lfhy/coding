/**
 * Generic-task adaptation for background bash process handles.
 *
 * @module @deepseek-ai/dsh-tool-bash/background
 */

import type { ShellProcess } from '@deepseek-ai/dsh-shell'

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
