/** computer-use 包的运行时不变式登记。 @module @deepseek-ai/dsh-computer-use/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-computer-use'

/** 全局可见的唯一 Computer Use 工具；其余工具只按 agent 暴露。 */
const ACTIVATION_TOOL = 'computer_use_activate'

/** Cordis 附属插件名称。 */
export const name = 'computer-use-invariant'
/** 登记所有权前要求工具注册表与不变量服务就绪。 */
export const inject = ['invariants']

/**
 * 执行类工具只能按 agent 暴露：一旦有插件把它们注册到全局，任何没加载 Skill 的会话
 * 都会直接拿到本机 UI 控制权，渐进式暴露这道门就废了。这里只读注册表视图，不参与派发。
 * @param tools - 已就绪的工具注册表视图。
 * @param fail - 不变量服务提供的失败上报函数。
 */
function assertScopedExposure(tools: ToolRuntime, fail: InvariantFailure): void {
  for (const schema of tools.schemas()) {
    if (schema.name !== ACTIVATION_TOOL && schema.name.startsWith('computer_')) {
      fail(`Computer Use tool "${schema.name}" is globally visible; execution tools must stay agent-scoped until the Skill is loaded`)
    }
  }
}

/** 在每次注册表变更后复查全局可见性；没有工具注册表的树里没有可检查的关系。 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const check = (): void => {
    // 注册表只在就绪后存在；同一次检查里复用同一个视图，避免重复查全局服务。
    const tools = ctx.get('tools')
    if (tools === undefined) return
    assertScopedExposure(tools, fail)
  }
  check()
  ctx.on('tools/change', check, { global: true })
}

/**
 * 登记本包的不变量附属插件。
 * @param ctx - 提供不变量服务的 Cordis context。
 * @returns 登记完成后的撤销函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
