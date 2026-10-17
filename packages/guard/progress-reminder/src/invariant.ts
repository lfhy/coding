/**
 * 本包自有的不变式配套入口：提醒文本声明的工具调用数必须等于日志中该提醒之前、
 * 最近一次计数边界之后真正完成的 `tool/result` 数，且消息确实归本包所有。
 *
 * @module coding-progress-reminder/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from 'coding-invariants'
import type { UserMessage } from 'coding-llm'
import type { Session, SessionEvent } from 'coding-session'
import { renderProgressReminder, unreportedToolCalls } from './index.ts'

const PACKAGE_NAME = 'coding-progress-reminder'
const SOURCE_NAME = 'progress-reminder'
const DECLARED_TOOL_CALLS = /^<system-reminder>\n你已连续执行 (\d+) 次工具调用，其间没有向用户汇报过进展。\n/

/** Cordis companion plugin name. */
export const name = 'progress-reminder-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** 判断一条用户消息是否为本插件注入的提醒。 */
function isProgressReminder(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === SOURCE_NAME
}

/**
 * 校验一条提醒：位置在写入它的开放轮次内，声明数量与日志派生结果一致。
 * @param history - 该提醒之前已持久化的全部事件。
 * @param event - 待校验的提醒消息事件。
 * @param fail - 记录违规的回调。
 */
function validateReminder(
  history: readonly SessionEvent[],
  event: SessionEvent<'user/message'>,
  fail: InvariantFailure,
): void {
  if (event.data.content.length !== 1) fail('progress-reminder 消息必须只包含一个内容块')
  const block = event.data.content[0]
  if (block === undefined || block.type !== 'text') fail('progress-reminder 消息必须是文本块')
  const text = block.text
  const match = DECLARED_TOOL_CALLS.exec(text)
  if (match === null) fail('progress-reminder 文本不符合固定格式')
  const declared = Number(match[1])
  if (!Number.isSafeInteger(declared) || declared < 1) {
    fail('progress-reminder 声明的工具调用数必须是正的安全整数')
  }
  if (text !== renderProgressReminder(declared)) {
    fail('progress-reminder 文本必须逐字等于渲染结果')
  }
  const source = event.data.source
  if (source.kind !== 'plugin' || source.plugin !== SOURCE_NAME) {
    fail('progress-reminder 消息必须保留本包来源')
  }
  const expected = unreportedToolCalls(history)
  if (declared !== expected) {
    fail(`progress-reminder 声明 ${declared} 次调用，日志中该边界之后为 ${expected} 次`)
  }
}

/** 校验一个会话中已存在的全部提醒。 */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const [index, event] of session.events.entries()) {
    if (event.type !== 'user/message' || !isProgressReminder(event.data)) continue
    validateReminder(session.events.slice(0, index), event, fail)
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Install validation for loaded and newly appended reminders. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'user/message' || !isProgressReminder(event.data)) return
    validateReminder(session.events.slice(0, event.seq), event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
