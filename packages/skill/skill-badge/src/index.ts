/**
 * Bundled `dsh-badge` skill provider.
 *
 * @module coding-skill-badge
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-fs'
import {
  BUNDLED_SKILL_RANK,
  internalSkillPath,
  internalSkillResourceBase,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from 'coding-skill'

const PROVIDER_NAME = 'dsh-badge'
const SKILL_BODY_URL = new URL('../assets/dsh-badge.md', import.meta.url)
const SKILL_PACKAGE = 'coding-skill-badge'
/** 资产目录的真实位置：只用于注册虚拟前缀，不进入模型提示或界面。 */
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url))
const SKILL_RESOURCE_PATH = internalSkillPath(SKILL_PACKAGE)
const RESOURCE_BASE = internalSkillResourceBase(SKILL_PACKAGE)
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = 'Add the official “powered by dsh” badge to documents, pull requests, merge requests, and other content produced with DeepSeek Harness. Use whenever creating a pull request or merge request. Also use when the user asks for a dsh badge, powered-by-dsh attribution, or a reusable dsh badge asset or snippet.'
const CANDIDATE: SkillCandidate = {
  name: 'dsh-badge',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

/** Cordis 插件名。 */
export const name = 'skill-badge'
/** 内置技能提供方所需的技能注册表与文件系统路径别名。 */
export const inject = ['skills', 'fs']

/**
 * 注册随包分发的 `dsh-badge` 技能提供方。
 * @param ctx - 提供技能注册表与文件系统的 Cordis 上下文。
 * @returns 无返回值；注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  // 虚拟前缀随插件卸载撤销；多个模式预设挂同一提供方时由文件系统按计数合并。
  ctx.effect(() => ctx.fs.registerPathAlias(SKILL_RESOURCE_PATH, ASSETS_DIR))
  ctx.skills.registerProvider(() => provider)
}
