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
 * 注册 Skill、引导工具与按 agent 暴露的执行工具。
 *
 * 注册落在调用方的预设作用域：标准预设与 PTC/Code Mode 预设各装配一份，模型可见的
 * 是同一套工具名；每份只对自己的 agent 生效。本函数不做权限判定，是否允许某次
 * 本机输入由服务层的租约、审批与确认令牌决定。
 * @param ctx - 携带工具注册表、技能注册表与 Computer Use 服务的上下文。
 * @returns 无返回值；全部注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  const exposure = new ComputerUseExposure(ctx, () => createComputerUseTools(ctx.computerUse))
  ctx.effect(() => {
    const activation = ctx.tools.register(exposure.activationTool)
    const skill = ctx.skills.register(COMPUTER_USE_SKILL)
    const legacySkill = ctx.skills.register(LEGACY_COMPUTER_USE_SKILL)
    const installed = exposure.install()
    return () => {
      installed()
      activation()
      legacySkill()
      skill()
    }
  }, 'dsh-tool-computer-use: progressive exposure')
}
