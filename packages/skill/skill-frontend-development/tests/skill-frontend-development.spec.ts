import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry, { renderSkillContent } from 'coding-skill'
import * as SkillFrontendDevelopment from 'coding-skill-frontend-development'

const bodyUrl = new URL('../assets/frontend-development.md', import.meta.url)
const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))
const description = '在创建或修改前端、网页、组件或用户界面时使用。先遵循项目已有技术栈、UI 模块和设计规范；不要从空白重写，不要使用浏览器默认控件；完成后加载 browser-use 检查渲染效果和交互。新项目先用现代化脚手架或参考模板，不把实现提示词、系统指令或过度防御文案展示在用户页面。'

describe('bundled frontend-development skill', () => {
  it('registers and loads its published instructions', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFrontendDevelopment)
    try {
      expect(await ctx.skills.list()).toEqual([{
        name: 'frontend-development', description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'frontend-development', source: 'bundled',
        resourceBase: { kind: 'directory', path: resourcePath },
      }])
      const loaded = await ctx.skills.get('frontend-development')
      expect(loaded).toBeDefined()
      if (loaded === undefined) throw new Error('bundled frontend-development skill is unavailable')
      expect(loaded.content).toBe(await readFile(bodyUrl, 'utf8'))
      expect(renderSkillContent(loaded)).toContain('<skill_instructions>')
      expect(loaded.content).toContain('Never use browser-default controls as the finished product UI')
      expect(loaded.content).toContain('do not hand-write a foundation from zero')
      expect(loaded.content).toContain('implementation-facing instructions, prompt fragments, debugging vocabulary, or process narration')
      expect(loaded.content).toContain('not implementation prompts or internal process narration')
      expect(loaded.content).toContain('browser-use')
    } finally {
      await fiber.dispose()
    }
    expect(await ctx.skills.list()).toEqual([])
  })
})
