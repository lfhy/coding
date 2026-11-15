/** `coding-git` 的 invariant 伴随包。 @module coding-git/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-git'

/** Cordis 伴随插件名。 */
export const name = 'git-invariant'
/** 伴随插件开始前需要的服务。 */
export const inject = ['invariants']

/**
 * No runtime invariant: 本包只拥有能力词汇与共享类型，实际观测点属于各提供方与
 * RPC 消费方。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册 Git 能力伴随插件。
 * @param ctx - 携带 invariant 服务的 Cordis 上下文。
 * @returns 注册成功后可用于撤销的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
