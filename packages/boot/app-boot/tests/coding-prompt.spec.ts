/** 固定 Coding 回答语言与工作方式的注册、无服务降级与卸载行为。 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from 'coding-system-prompt'
import { describe, expect, it } from 'vitest'
import {
  addCodingPromptSections,
  CODING_GUIDELINES,
  CODING_GUIDELINES_SECTION,
} from '../src/coding-prompt.ts'

describe('addCodingPromptSections', () => {
  it('在身份与 persona 之间注册回答语言与工作方式，不保留禁止默认提交的旧规则', async () => {
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
      const languageAt = rendered.indexOf('# 回答语言')
      const guidelinesAt = rendered.indexOf('# 工作方式')
      const personaAt = rendered.indexOf('测试项目 persona。')
      expect(identityAt).toBeGreaterThanOrEqual(0)
      expect(languageAt).toBeGreaterThan(identityAt)
      expect(guidelinesAt).toBeGreaterThan(languageAt)
      expect(personaAt).toBeGreaterThan(guidelinesAt)
      // 回答语言规则固定 verbatim：模型可见文本，中英混杂回复时按这里回归。
      expect(rendered).toContain('默认使用简体中文回答，避免中英混杂；除非用户明确要求其他语言。')
      expect(rendered).toContain('代码、命令、标识符、路径和必要引用保留原文，不翻译')
      expect(rendered).not.toContain('用用户使用的语言回复。')
      expect(rendered).toContain('# 新项目初始化')
      expect(rendered).toContain('docs/codemap/README.md')
      expect(rendered).toContain('总入口，再按任务读相关模块地图与专项文档')
      expect(rendered).toContain('仓库内相对链接')
      expect(rendered).toContain('# Git 工作')
      expect(rendered).toContain('动业务代码前先把版本基线立起来')
      expect(rendered).toContain('不要先问用户要不要提交')
      expect(rendered).toContain('调用 edit 前必须读取目标文件的最新内容')
      expect(rendered).toContain('old_string was not found')
      expect(rendered).toContain('页面是给用户使用的产品界面，不是模型或开发者的调试面板')
      expect(rendered).toContain('主题跟随系统当前的亮暗设置')
      expect(rendered).toContain('取不到时用亮色兜底')
      expect(rendered).toContain('两套颜色分别放在独立的 themes 目录')
      expect(rendered).toContain('用统一的子 Tab（顶部或左侧）分层，一次只显示一层')
      expect(rendered).toContain('修改密码、删除、导出、批量替换')
      expect(rendered).toContain('列表页的搜索与筛选工具栏固定在视口内')
      expect(rendered).toContain('页面外壳的高度等于一屏（100dvh 或等效）')
      expect(rendered).toContain('卡片里的列表同样给固定高度、内部滚动并配「查看全部」入口')
      expect(rendered).toContain('单元格垂直居中')
      expect(rendered).toContain('认证与首屏表单：登录、注册、创建管理员、重置密码')
      expect(rendered).toContain('不要把营销文案或功能清单塞成左栏')
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
