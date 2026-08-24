/** 为通用浏览器品牌 slot 提供官方 Coding 占用者。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { OfficialBrandMark, OfficialBrandName } from './Brand.tsx'

/** 所需服务：UI slot 注册表。 */
export const inject = ['slots']

/**
 * 将已发布的品牌 slot 作为一组声明感知注册填充。
 * @param ctx - Client 根上下文。
 */
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.inject('conversation.hero.brand.mark', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, OfficialBrandName)
      yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, OfficialBrandMark)
    }))
}
