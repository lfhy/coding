/** 校验进度事实形状；轮次匹配由工具及投影分别约束。 */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller, InvariantFailure } from 'coding-invariants'
import type { Session, SessionEvent } from 'coding-session'
import { statusEventSchema } from './status.ts'

/** 进度工具的不变式伴随插件名。 */
export const name = 'tool-status-invariant'
/** 必须先有不变式注册表。 */
export const inject = ['invariants']

/** 所有入口使用同一份事件校验，不接受回放中的不规范文本。 */
function validate(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'status/set' && !statusEventSchema.safeParse(event.data).success) {
    fail('status/set 必须携带合法轮次和规范的单行进度或 null')
  }
}

/** 在加载和实时追加时检查同一份持久不变量。 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const validateSession = (session: Session): void => {
    for (const event of session.events) validate(event, fail)
  }
  for (const session of ctx.sessions.list()) validateSession(session)
  ctx.on('session/created', validateSession, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName === 'session/event') validate((args as [Session, SessionEvent])[1], fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * 注册进度事实校验器。
 * @param ctx 持有不变式服务的上下文。
 * @returns 注册成功后的释放函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('coding-tool-status', install))
