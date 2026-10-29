/** 随发行包提供前端开发技能正文，并把资源目录交给技能注册表。 @module coding-skill-frontend-development */

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

const PROVIDER_NAME = 'frontend-development'
const SKILL_BODY_URL = new URL('../assets/frontend-development.md', import.meta.url)
const SKILL_PACKAGE = 'coding-skill-frontend-development'
/** 资产目录的真实位置：只用于注册虚拟前缀，不进入模型提示或界面。 */
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url))
const SKILL_RESOURCE_PATH = internalSkillPath(SKILL_PACKAGE)
const RESOURCE_BASE = internalSkillResourceBase(SKILL_PACKAGE)
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = '在创建或修改前端、网页、组件或用户界面时使用。遵循项目已有技术栈、组件、图标库和设计规范；没有既有图标库时按需读取内置参考并默认选用 Lucide，禁止手写或内联 SVG（除非确实缺少领域图标且已走项目图标抽象）；请求失败等短暂通知必须使用共享 Toast，长流程使用分步模态框，抽屉内使用子 Tab；列表页不整页滚动，搜索与筛选工具栏留在视口内，只让列表区域内部滚动，长列表使用虚拟滚动与无限滚动加载；列表不超出屏幕宽度，长名称截断成省略号且整行不换行，行高统一，列不够时按优先级隐藏；避免文字海报和页面／图标硬切；禁止把系统或开发者提示、技能、工具调用、Agent 计划、框架／库／包标识、内部路径、调试信息或内部状态写进用户界面；完成后加载 browser-use 检查真实渲染与交互。仅在用户明确要求具名视觉方向时配合 stylekit，不能覆盖产品规范。'
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
/** 技能提供方所需的注册表服务与文件系统路径别名。 */
export const inject = ['skills', 'fs']

/**
 * 注册随包分发的 `frontend-development` 技能提供方。
 * @param ctx - 提供技能注册表的 Cordis 上下文。
 * @returns 无返回值；注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  // 虚拟前缀随插件卸载撤销；多个模式预设挂同一提供方时由文件系统按计数合并。
  ctx.effect(() => ctx.fs.registerPathAlias(SKILL_RESOURCE_PATH, ASSETS_DIR))
  ctx.skills.registerProvider(() => provider)
}
