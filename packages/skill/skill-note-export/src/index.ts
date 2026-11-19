/**
 * 随包分发的 `note-export` 技能：把「把笔记导出成 Word、PDF、图片，产物放进用户主目录」
 * 写成可加载的操作步骤。正文指导模型用 pandoc 转格式、用无头 Chrome 出 PDF 与图片，
 * 默认落点是 `$HOME/笔记导出`，并说明与应用内导出的差异。插件只向 `ctx.skills`
 * 登记一个固定提供方，不读文件、不注册工具、不改权限。
 * @module coding-skill-note-export
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

const PROVIDER_NAME = 'note-export'
const SKILL_BODY_URL = new URL('../assets/note-export.md', import.meta.url)
const SKILL_PACKAGE = 'coding-skill-note-export'
/** 资产目录的真实位置：只用于注册虚拟前缀，不进入模型提示或界面。 */
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url))
const SKILL_RESOURCE_PATH = internalSkillPath(SKILL_PACKAGE)
const RESOURCE_BASE = internalSkillResourceBase(SKILL_PACKAGE)
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = '把笔记导出成 Word（.docx）、PDF 或图片（.png）时使用：产物默认放到用户主目录的 `笔记导出` 目录，用户能在访达／资源管理器里直接看到；先用 pandoc 转格式、再用无头 Chrome 打印 PDF 或截图，逐页出图用 pdftoppm；导出只读原笔记，不改写不移动，写主目录被沙箱拒绝时按提示申请一次升权或退回笔记目录并说明位置。'
const CANDIDATE: SkillCandidate = {
  name: 'note-export',
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
export const name = 'skill-note-export'
/** 技能提供方所需的注册表服务与文件系统路径别名。 */
export const inject = ['skills', 'fs']

/**
 * 注册随包分发的 `note-export` 技能提供方。
 * @param ctx - 提供技能注册表的 Cordis 上下文。
 * @returns 无返回值；注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  // 虚拟前缀随插件卸载撤销；多个模式预设挂同一提供方时由文件系统按计数合并。
  ctx.effect(() => ctx.fs.registerPathAlias(SKILL_RESOURCE_PATH, ASSETS_DIR))
  ctx.skills.registerProvider(() => provider)
}
