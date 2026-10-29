/** 随发行包提供 StyleKit 视觉风格技能正文与公开风格目录快照。 @module coding-skill-stylekit */

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

const PROVIDER_NAME = 'stylekit'
const SKILL_BODY_URL = new URL('../assets/stylekit.md', import.meta.url)
const SKILL_PACKAGE = 'coding-skill-stylekit'
/** 资产目录的真实位置：只用于注册虚拟前缀，不进入模型提示或界面。 */
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url))
const SKILL_RESOURCE_PATH = internalSkillPath(SKILL_PACKAGE)
const RESOURCE_BASE = internalSkillResourceBase(SKILL_PACKAGE)
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = '在需要给网页或界面一个具名视觉风格时使用：玻璃拟态、新野兽派、赛博朋克、包豪斯、瑞士网格、便当盒布局、Apple／Stripe／Notion／Linear 风格、日式极简、复古 Y2K 等 StyleKit 风格目录。用来把“做得好看点”落成可执行的配色、设计令牌与 do／don\'t 规则，并在项目现有技术栈内实现；风格指南不覆盖产品行为、无障碍与项目已有组件。'
const CANDIDATE: SkillCandidate = {
  name: 'stylekit',
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
export const name = 'skill-stylekit'
/** 技能提供方所需的注册表服务与文件系统路径别名。 */
export const inject = ['skills', 'fs']

/**
 * 注册随包分发的 `stylekit` 技能提供方。
 * @param ctx - 提供技能注册表的 Cordis 上下文。
 * @returns 无返回值；注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  // 虚拟前缀随插件卸载撤销；多个模式预设挂同一提供方时由文件系统按计数合并。
  ctx.effect(() => ctx.fs.registerPathAlias(SKILL_RESOURCE_PATH, ASSETS_DIR))
  ctx.skills.registerProvider(() => provider)
}
