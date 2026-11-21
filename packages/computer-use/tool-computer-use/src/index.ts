/** Computer Use 的模型可见消费方：Skill、引导工具与按 agent 暴露的执行工具。 @module coding-tool-computer-use */

import type { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-computer-use'
import type {} from 'coding-skill'
import type {} from 'coding-tools'
import { ComputerUseExposure } from './exposure.ts'
import { COMPUTER_USE_SKILL, LEGACY_COMPUTER_USE_SKILL } from './skill.ts'
import { createComputerUseTools } from './tools.ts'

export { createComputerUseTools } from './tools.ts'

/** 插件名。 */
export const name = 'tool-computer-use'
/** 工具注册表、技能注册表、agent 注册表与宿主层 Computer Use 服务；缺任一项时预设挂载会失败。 */
export const inject = ['tools', 'skills', 'agents', 'computerUse']

/**
 * 按宿主开关注册 Skill、引导工具与按 agent 暴露的执行工具。
 *
 * 注册落在调用方的预设作用域：六个提供本能力的模式各装配一份，模型可见的是同一套
 * 工具名；每份只对自己的 agent 生效。设置里的开关关闭时本插件不留下任何模型可见痕迹，
 * 重新打开后恢复引导工具，已加载过 Skill 的会话按会话日志重新取得执行工具。
 * 本函数不做权限判定，是否允许某次本机输入由服务层的租约、审批与确认令牌决定。
 * @param ctx - 携带工具注册表、技能注册表与 Computer Use 服务的上下文。
 * @returns 无返回值；全部注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  let generation = 0
  let disposed = false
  let release: (() => void) | undefined

  /** 一次性装配这一层作用域的全部注册；撤销顺序与注册顺序相反。 */
  const mount = (): (() => void) => {
    const exposure = new ComputerUseExposure(ctx, () => createComputerUseTools(ctx.computerUse))
    const activation = ctx.tools.register(exposure.activationTool)
    const skill = ctx.skills.register(COMPUTER_USE_SKILL)
    const legacySkill = ctx.skills.register(LEGACY_COMPUTER_USE_SKILL)
    try {
      const installed = exposure.install()
      return () => {
        installed()
        activation()
        legacySkill()
        skill()
      }
    } catch (error) {
      legacySkill()
      skill()
      activation()
      throw error
    }
  }

  // 开关是同步事实：设置提交后立即重新判定，避免一次调用窗口里留下过期工具。
  const refresh = (): void => {
    const current = ++generation
    let available = false
    try {
      available = ctx.computerUse.availability()
    } catch (error) {
      ctx.logger.warn('tool-computer-use: availability check failed; omitting tools', error)
    }
    if (disposed || current !== generation || available === (release !== undefined)) return
    release?.()
    release = available ? mount() : undefined
  }

  ctx.effect(() => () => {
    disposed = true
    generation++
    release?.()
    release = undefined
  }, 'dsh-tool-computer-use: progressive exposure')
  ctx.effect(() => ctx.computerUse.watchAvailability(refresh), 'dsh-tool-computer-use: availability notifications')
  refresh()
}
