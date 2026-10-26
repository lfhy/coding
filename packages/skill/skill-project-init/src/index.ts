/**
 * 随包分发的 `project-init` 技能：把「先定地基与版本基线、再动业务代码」写成可加载的操作步骤。
 * 新项目在能联网且未要求从零开发时先去 GitHub 找模板或同类仓库落地；前端进 Go 工程的 `web/`
 * 并由 `go:embed` 提供，后端按分层技能搭。插件只向 `ctx.skills` 登记一个固定提供方，
 * 不读文件、不注册工具、不改权限。
 * @module coding-skill-project-init
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from 'coding-skill'

const PROVIDER_NAME = 'project-init'
const SKILL_BODY_URL = new URL('../assets/project-init.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = '在新建项目（含 AI 对话／Agent 页面）、空目录或需要让改动可回滚时使用：已在 Git 工作区就不重复初始化；新项目且有联网时先在 GitHub 按优先级找 template 或同类开源仓库（如 vben、shadcn-admin、assistant-ui、Cherry Studio）当地基，对话页面直接接成熟实现不重写；前端进 Go 工程的 web 目录并由 go:embed 提供、后端按分层技能自己搭；未初始化就 git init、写 .gitignore、逐条确认后建基线提交，并给出新项目最小的 README／AGENTS；之后每一步改动都小步验证并本地提交。'
const CANDIDATE: SkillCandidate = {
  name: 'project-init',
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
export const name = 'skill-project-init'
/** 技能提供方所需的注册表服务。 */
export const inject = ['skills']

/**
 * 注册随包分发的 `project-init` 技能提供方。
 * @param ctx - 提供技能注册表的 Cordis 上下文。
 * @returns 无返回值；注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
