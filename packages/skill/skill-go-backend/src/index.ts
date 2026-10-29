/**
 * 随包分发的 `go-backend` 技能：Go 服务端实现的默认约定（布局、context、错误、数据访问、验证命令）。
 * 插件只向 `ctx.skills` 登记一个固定提供方，不读仓库、不注册工具、不改变权限。
 * @module coding-skill-go-backend
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

const PROVIDER_NAME = 'go-backend'
const SKILL_BODY_URL = new URL('../assets/go-backend.md', import.meta.url)
const SKILL_PACKAGE = 'coding-skill-go-backend'
/** 资产目录的真实位置：只用于注册虚拟前缀，不进入模型提示或界面。 */
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url))
const SKILL_RESOURCE_PATH = internalSkillPath(SKILL_PACKAGE)
const RESOURCE_BASE = internalSkillResourceBase(SKILL_PACKAGE)
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = '在写或改 Go 后端代码时使用：按项目已有布局与依赖实现 HTTP、后台任务、数据库访问与测试，涵盖根 main.go 加 cmd／conf／core 分层、web 目录经 go:embed 提供前端、context 与并发生命周期、错误包装、参数化查询与迁移，以及 go vet、go test -race 的交付验证。'
const CANDIDATE: SkillCandidate = {
  name: 'go-backend',
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
export const name = 'skill-go-backend'
/** 技能提供方所需的注册表服务与文件系统路径别名。 */
export const inject = ['skills', 'fs']

/**
 * 注册随包分发的 `go-backend` 技能提供方。
 * @param ctx - 提供技能注册表的 Cordis 上下文。
 * @returns 无返回值；注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  // 虚拟前缀随插件卸载撤销；多个模式预设挂同一提供方时由文件系统按计数合并。
  ctx.effect(() => ctx.fs.registerPathAlias(SKILL_RESOURCE_PATH, ASSETS_DIR))
  ctx.skills.registerProvider(() => provider)
}
