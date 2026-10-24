/** 固定 Coding 工作方式的注册、无服务降级与卸载行为。 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from 'coding-system-prompt'
import { describe, expect, it } from 'vitest'
import {
  addCodingPromptSections,
  CODING_GUIDELINES,
  CODING_GUIDELINES_SECTION,
} from '../src/coding-prompt.ts'

describe('addCodingPromptSections', () => {
  it('在身份与 persona 之间注册完整工作方式，不保留禁止默认提交的旧规则', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { persona: '测试项目 persona。' })
      const dispose = addCodingPromptSections(ctx)
      expect(dispose).toBeTypeOf('function')
      const prompt = ctx.get('systemPrompt')!
      const assembly = await prompt.assemble()
      expect(assembly.sections.find(section => section.name === CODING_GUIDELINES_SECTION))
        .toEqual({ name: CODING_GUIDELINES_SECTION, text: CODING_GUIDELINES })
      const rendered = renderPrompt(assembly)
      const identityAt = rendered.indexOf('你是 Coding 的编程 agent，在用户自己的电脑上工作。')
      const guidelinesAt = rendered.indexOf('# 工作方式')
      const personaAt = rendered.indexOf('测试项目 persona。')
      expect(identityAt).toBeGreaterThanOrEqual(0)
      expect(guidelinesAt).toBeGreaterThan(identityAt)
      expect(personaAt).toBeGreaterThan(guidelinesAt)
      expect(rendered).toContain('# 新项目初始化')
      expect(rendered).toContain('docs/codemap/README.md')
      expect(rendered).toContain('总入口，再按任务读相关模块地图与专项文档')
      expect(rendered).toContain('仓库内相对链接')
      expect(rendered).toContain('# Git 工作')
      expect(rendered).toContain('调用 edit 前必须读取目标文件的最新内容')
      expect(rendered).toContain('old_string was not found')
      expect(rendered).toContain('页面是给用户使用的产品界面，不是模型或开发者的调试面板')
      expect(rendered).not.toContain('未经要求不提交')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('未挂载系统提示词服务时不执行操作', async () => {
    const ctx = new Context()
    try {
      expect(addCodingPromptSections(ctx)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('卸载后移除工作方式段并允许重新注册', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, {})
      const prompt = ctx.get('systemPrompt')!
      const dispose = addCodingPromptSections(ctx)!
      expect((await prompt.assemble()).sections.some(section => section.name === CODING_GUIDELINES_SECTION)).toBe(true)
      dispose()
      expect((await prompt.assemble()).sections.some(section => section.name === CODING_GUIDELINES_SECTION)).toBe(false)
      const next = addCodingPromptSections(ctx)!
      expect(renderPrompt(await prompt.assemble())).toContain('# Git 工作')
      next()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
