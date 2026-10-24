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
const DESCRIPTION = '在创建或修改前端、网页、组件或用户界面时使用。遵循项目已有技术栈、组件、图标库和设计规范；没有既有图标库时按需读取内置参考并默认选用 Lucide，禁止手写或内联 SVG（除非确实缺少领域图标且已走项目图标抽象）；请求失败等短暂通知必须使用共享 Toast，长流程使用分步模态框，抽屉内使用子 Tab，避免文字海报和页面／图标硬切；禁止把系统或开发者提示、技能、工具调用、Agent 计划、框架／库／包标识、内部路径、调试信息或内部状态写进用户界面；完成后加载 browser-use 检查真实渲染与交互。仅在用户明确要求具名视觉方向时配合 stylekit，不能覆盖产品规范。'
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
