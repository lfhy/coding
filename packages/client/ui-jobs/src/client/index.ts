/** 浏览器后台任务插件将当前会话的任务镜像注册到概览子 slot；列表展开由概览卡片持有。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { JobListAction } from './JobListAction.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, NS, zh, type JobKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Background-job list copy. */
    'job': JobKey
  }
}

export type { JobListActionProps } from './JobListAction.tsx'

/** locale 注册与概览子 slot 贡献依赖的服务。 */
export const inject = ['sessions', 'slots', 'locale']

/**
 * 注册任务字典与概览列表；slot 声明晚到时注入会重试注册。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-job: dictionaries')
  ctx.slots.inject(
    'conversation.overview.jobs',
    () => ctx.slots.register({
      name: 'conversation.overview.jobs',
      locale: NS,
    }, JobListAction),
  )
}
