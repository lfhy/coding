/** 按会话隔离的浏览器使用能力定义；页面与资源生命周期由提供方实现。 @module @deepseek-ai/dsh-browser */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { BrowserCapture, BrowserCommand, BrowserExpectedTarget, BrowserHumanCommand, BrowserSessionState, BrowserUseErrorCode } from './types.ts'

export type { BrowserCapture, BrowserCommand, BrowserExpectedTarget, BrowserHumanCommand, BrowserObservation, BrowserSessionState, BrowserTabId, BrowserTabSummary, BrowserUseErrorCode } from './types.ts'

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

/** 每个 SessionId 独占浏览器上下文、标签页与代理的可替换服务。 */
export abstract class BrowserUseService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'browserUse')
  }

  /**
   * 对指定会话执行一个命令，成功时发布对应的观测与可选截图。
   * 元素操作必须拒绝跨标签页或过期 revision；拒绝与取消不得发布虚假的新观测。
   * @param sessionId - 独占浏览器上下文的会话身份。
   * @param command - 导航、快照、交互或关闭命令。
   * @param signal - 中止当前操作；提供方应保留调用方给出的中止原因。
   * @param expectedTarget - 审批前采样的可选空会话或活跃标签页与状态修订版，执行队列中必须再次核对。
   * @returns 成功命令产生的观测和可选 PNG 字节。
   */
  abstract execute(sessionId: SessionId, command: BrowserCommand, signal: AbortSignal,
    expectedTarget?: BrowserExpectedTarget): Promise<BrowserCapture>

  /**
   * 同步读取最近一次队列操作完成后的会话状态，不启动或导航页面。
   * @param sessionId - 要读取的会话身份。
   * @returns 资源不存在时为 undefined；空白标签页没有观测。
   */
  abstract state(sessionId: SessionId): BrowserSessionState | undefined

  /**
   * 串行执行人工导航、标签页或有界页面视口操作，取消时释放不确定的会话状态。
   * @param sessionId - 独占浏览器上下文的会话身份。
   * @param command - 人工操作，标签页 id 只在当前会话有效。
   * @param signal - 调用方中止信号。
   * @returns 操作后的状态；关闭最后一个标签页时为 undefined。
   */
  abstract control(sessionId: SessionId, command: BrowserHumanCommand, signal: AbortSignal): Promise<BrowserSessionState | undefined>

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
