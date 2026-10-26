/** 为通用浏览器品牌 slot 提供官方 Coding 占用者。 */
import type { ClientContext } from 'coding-client-runtime/client'
import type {} from 'coding-client-ui-conversation/client'
import { OfficialBrandMark } from './Brand.tsx'

/** 所需服务：UI slot 注册表。 */
export const inject = ['slots']

/**
 * 将 Hero 品牌图标注册为声明感知占用者；声明缺失时等待，撤销后自行摘除。
 * @param ctx - Client 根上下文。
 */
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, OfficialBrandMark))
}
