/** 随发行包提供前端开发技能正文，并把资源目录交给技能注册表。 @module coding-skill-frontend-development */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from 'coding-skill'

const PROVIDER_NAME = 'frontend-development'
const SKILL_BODY_URL = new URL('../assets/frontend-development.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = '在创建或修改前端、网页、组件或用户界面时使用。先遵循项目已有技术栈、UI 模块和设计规范；不要从空白重写，不要使用浏览器默认控件；完成后加载 browser-use 检查渲染效果和交互。新项目先用现代化脚手架或参考模板，不把实现提示词、系统指令或过度防御文案展示在用户页面。'
const CANDIDATE: SkillCandidate = {
  name: 'frontend-development',
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
export const name = 'skill-frontend-development'
/** 技能提供方所需的注册表服务。 */
export const inject = ['skills']

/**
 * 注册随包分发的 `frontend-development` 技能提供方。
 * @param ctx - 提供技能注册表的 Cordis 上下文。
 * @returns 无返回值；注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
