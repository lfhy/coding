/**
 * `project-init` 技能包的注册、加载与卸载契约。
 *
 * 固定正文按 ID 与 `git init` 两条关键动作断言：目录描述可以改写，但「先有可回滚的基线，
 * 再动业务代码」这条操作顺序是技能存在的理由，正文丢了它，加载到的就只是泛泛的项目建议。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry, { renderSkillContent } from 'coding-skill'
import * as SkillProjectInit from 'coding-skill-project-init'

const bodyUrl = new URL('../assets/project-init.md', import.meta.url)
const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))
const description = '在新建项目、空目录或需要让改动可回滚时使用：先确认是否已在 Git 工作区内，未初始化就 git init、写 .gitignore、逐条确认后建基线提交，并给出新项目最小的 README／AGENTS；之后每一步改动都小步验证并本地提交。'

describe('bundled project-init skill', () => {
  it('registers, loads, and unregisters its published instructions', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillProjectInit)
    try {
      expect(await ctx.skills.list()).toEqual([{
        name: 'project-init',
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'project-init',
        source: 'bundled',
        resourceBase: { kind: 'directory', path: resourcePath },
      }])
      const loaded = await ctx.skills.get('project-init')
      if (loaded === undefined) throw new Error('bundled project-init skill is unavailable')
      expect(loaded.content).toBe(await readFile(bodyUrl, 'utf8'))
      expect(renderSkillContent(loaded)).toContain('<skill_instructions>')
      // 先判断现状、再初始化、最后建基线提交——这是技能的核心顺序。
      expect(loaded.content).toContain('git rev-parse --show-toplevel')
      expect(loaded.content).toContain('git init -b main')
      expect(loaded.content).toContain('git add <path>')
      expect(loaded.content).toContain('不要 `git add .`')
      // 回滚的目的与代价必须写在正文里，否则模型只会把它当成一次性的项目初始化清单。
      expect(loaded.content).toContain('回退的锚点')
      expect(loaded.content).toContain('不在工作目录之外初始化仓库')
      expect(loaded.content).toContain('任何改动都无法回滚')
    } finally {
      await fiber.dispose()
    }
    expect(await ctx.skills.list()).toEqual([])
  })
})
