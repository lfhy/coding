/** `coding-git-local` 的 invariant 伴随包。 @module coding-git-local/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-git-local'

/** Cordis 伴随插件名。 */
export const name = 'git-local-invariant'
/** 伴随插件开始前需要的服务。 */
export const inject = ['invariants']

/**
 * No runtime invariant: 本包只是 Git seam 的本机实现，观测点（仓库状态、认证往返）
 * 由消费网关按请求持有。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本机 Git 伴随插件。
 * @param ctx - 携带 invariant 服务的 Cordis 上下文。
 * @returns 注册成功后可用于撤销的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
