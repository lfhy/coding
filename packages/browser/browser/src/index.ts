/** 按会话隔离的浏览器使用能力定义；页面与资源生命周期由提供方实现。 @module @deepseek-ai/dsh-browser */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { BrowserCapture, BrowserCommand, BrowserUseErrorCode } from './types.ts'

export type { BrowserCapture, BrowserCommand, BrowserObservation, BrowserUseErrorCode } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserUse: BrowserUseService
  }
}

/** 浏览器操作失败，code 可供工具和界面稳定路由。 */
export class BrowserUseError extends Error {
  constructor(message: string, readonly code: BrowserUseErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserUseError'
  }
}

/** 每个 SessionId 独占一个浏览器资源的可替换服务。 */
export abstract class BrowserUseService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'browserUse')
  }

  /**
   * 对指定会话执行一个命令，成功时发布对应的观测与可选截图。
   * 元素操作必须拒绝过期 revision；拒绝与取消不得发布虚假的新观测。
   * @param sessionId - 独占页面的会话身份。
   * @param command - 导航、快照、交互或关闭命令。
   * @param signal - 中止当前操作；提供方应保留调用方给出的中止原因。
   * @returns 成功命令产生的观测和可选 PNG 字节。
   */
  abstract execute(sessionId: SessionId, command: BrowserCommand, signal: AbortSignal): Promise<BrowserCapture>

  /**
   * 读取指定会话最近一次成功发布的观测，不启动浏览器操作。
   * @param sessionId - 要读取的会话身份。
   * @returns 已发布的捕获；尚无观测或资源已关闭时为 undefined。
   */
  abstract latest(sessionId: SessionId): BrowserCapture | undefined

  /**
   * 停止并释放指定会话的浏览器资源；调用方等待资源完全停稳。
   * @param sessionId - 要关闭的会话身份。
   * @returns 清理完成后兑现；没有该会话资源时也完成。
   */
  abstract closeSession(sessionId: SessionId): Promise<void>
}

export default BrowserUseService
