/** 在发送消息时按本地占位目录准备该会话的 SSH 路由。 */
import type { Context } from '@deepseek-ai/cordis'

interface RemoteWorkspaceActivation {
  /** @param path - 已注册远端工作区的本地占位目录。 */
  activate(path: string): Promise<void>
}

const MARKER_ROOT = /(?:^|[\\/])remote-workspaces[\\/][a-f0-9]{20}[\\/][A-Za-z0-9_-]+-[a-f0-9]{20}$/u

/**
 * 判断工作区路径是否是桌面端生成的远端占位目录。
 * @param path - 工作区的本地路径。
 * @returns 是否为远端占位目录。
 */
export function isRemoteWorkspacePath(path: string): boolean {
  return MARKER_ROOT.test(path)
}

/**
 * 为一个 Client 复用同一路径在途的连接准备；失败不缓存，便于重试。
 * @param ctx - 桌面端按需注册 SSH 能力的根上下文。
 * @returns 准备远端路由的函数；取消发送不影响其他发送共享的连接。本地路径返回 undefined。
 */
export function createRemoteWorkspacePreparation(ctx: Context): (cwd: string, signal?: AbortSignal) => Promise<void> | undefined {
  const pending = new Map<string, Promise<void>>()
  return (cwd, signal) => {
    if (!isRemoteWorkspacePath(cwd)) return undefined
    let attempt = pending.get(cwd)
    if (attempt === undefined) {
      const activation = ctx.get('remoteWorkspace') as RemoteWorkspaceActivation | undefined
      if (activation === undefined) return Promise.reject(new Error('remote workspace activation is unavailable'))
      attempt = Promise.resolve().then(() => activation.activate(cwd)).finally(() => { pending.delete(cwd) })
      pending.set(cwd, attempt)
    }
    return signal === undefined ? attempt : waitForPreparation(attempt, signal)
  }
}

/** 只中止当前发送的等待；共享的桌面调用继续结算。 */
async function waitForPreparation(attempt: Promise<void>, signal: AbortSignal): Promise<void> {
  const cancelled = Promise.withResolvers<never>()
  const abort = () => { cancelled.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) abort()
    await Promise.race([attempt, cancelled.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
