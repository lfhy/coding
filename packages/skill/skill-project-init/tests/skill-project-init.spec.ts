/**
 * `project-init` 技能包的注册、加载与卸载契约。
 *
 * 固定正文按关键动作断言：目录描述可以改写，但「新项目先找现成地基、再建可回滚基线、
 * 然后才动业务代码」这条操作顺序是技能存在的理由，正文丢了它，加载到的就只是泛泛的项目建议。
 * 因此模板搜索的条件与优先级、模板落地方式、后端按分层技能搭，都按稳定短语钉住。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry, { renderSkillContent } from 'coding-skill'
import * as SkillProjectInit from 'coding-skill-project-init'

const bodyUrl = new URL('../assets/project-init.md', import.meta.url)
const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))
const description = '在新建项目（含 AI 对话／Agent 页面）、空目录或需要让改动可回滚时使用：已在 Git 工作区就不重复初始化；新项目且有联网时先在 GitHub 按优先级找 template 或同类开源仓库（如 vben、shadcn-admin、assistant-ui、Cherry Studio）当地基，对话页面直接接成熟实现不重写；前端进 Go 工程的 web 目录并由 go:embed 提供、后端按分层技能自己搭；未初始化就 git init、写 .gitignore、逐条确认后建基线提交，并给出新项目最小的 README／AGENTS；之后每一步改动都小步验证并本地提交。'

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
      // 新项目在有联网且未要求从零开发时先找现成地基：模板优先，其次是同类项目参考。
      expect(loaded.content).toContain('web_search')
      expect(loaded.content).toContain('完全从 0 开发')
      expect(loaded.content).toContain('template 仓库优先')
      expect(loaded.content).toContain('vue-vben-admin')
      expect(loaded.content).toContain('shadcn-admin')
      // 对话／Agent 页面按成熟实现走：模板、同类项目与「不重写基础件」的规则都要在正文里。
      expect(loaded.content).toContain('vercel/ai-chatbot')
      expect(loaded.content).toContain('heroui-inc/heroui')
      expect(loaded.content).toContain('assistant-ui/assistant-ui')
      expect(loaded.content).toContain('deepseek-ai/deepseek-harness')
      expect(loaded.content).toContain('不要自己再写一遍')
      expect(loaded.content).toContain('AGPL-3.0')
      // 模板不是照布局重写：在落地的那份真实代码上改，否则会丢掉模板已处理的边界与时序。
      expect(loaded.content).toContain('就在这份真实代码上改')
      expect(loaded.content).toContain('另建一套「差不多」的实现')
      // 直连 GitHub 不通时走镜像前缀；degit 不认镜像，来源仍写 github.com。
      expect(loaded.content).toContain('https://gh-proxy.com/https://github.com/')
      expect(loaded.content).toContain('UNSUPPORTED_HOST')
      expect(loaded.content).toContain('不写镜像地址')
      expect(loaded.content).toContain('npx degit')
      // 前端进 Go 工程的 web/ 并由 go:embed 提供；后端不用模板定型，按分层技能搭。
      expect(loaded.content).toContain('go-backend')
      expect(loaded.content).toContain('`core/<domain>/`')
      expect(loaded.content).toContain('新项目不建 `internal/`')
      expect(loaded.content).toContain('`web/dist`')
      expect(loaded.content).toContain('go:embed')
      expect(loaded.content).toContain('npm --prefix web run build')
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
