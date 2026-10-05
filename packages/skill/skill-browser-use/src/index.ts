/** 随发行包提供浏览器操作技能正文，并把资源目录交给技能注册表。 @module @deepseek-ai/dsh-skill-browser-use */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'browser-use'
const SKILL_BODY_URL = new URL('../assets/browser-use.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = 'Use for tasks that require browsing a web page: open a URL, inspect page text and elements, click or fill observed controls, scroll, or inspect a screenshot. Load before using the browser_navigate, browser_snapshot, browser_click, browser_fill, browser_scroll, browser_screenshot, or browser_close tools.'
const CANDIDATE: SkillCandidate = {
  name: 'browser-use',
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
export const name = 'skill-browser-use'
/** 技能提供方所需的注册表服务。 */
export const inject = ['skills']

/**
 * 注册随包分发的 `browser-use` 技能提供方。
 * @param ctx - 提供技能注册表的 Cordis 上下文。
 * @returns 无返回值；注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
