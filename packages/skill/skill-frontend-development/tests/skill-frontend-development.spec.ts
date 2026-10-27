import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry, { renderSkillContent } from 'coding-skill'
import * as SkillFrontendDevelopment from 'coding-skill-frontend-development'

const bodyUrl = new URL('../assets/frontend-development.md', import.meta.url)
const notificationUrl = new URL('../assets/notification-and-structure.md', import.meta.url)
const iconLibraryUrl = new URL('../assets/icon-library.md', import.meta.url)
const motionIndexUrl = new URL('../assets/motion-recipes/index.md', import.meta.url)
const listScrollUrl = new URL('../assets/list-scroll.md', import.meta.url)
const motionRecipeUrls = [
  'view-switch.css',
  'icon-feedback.css',
  'disclosure.css',
  'list-stagger.css',
  'feedback.css',
].map(name => new URL(`../assets/motion-recipes/${name}`, import.meta.url))
const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))
const description = '在创建或修改前端、网页、组件或用户界面时使用。遵循项目已有技术栈、组件、图标库和设计规范；没有既有图标库时按需读取内置参考并默认选用 Lucide，禁止手写或内联 SVG（除非确实缺少领域图标且已走项目图标抽象）；请求失败等短暂通知必须使用共享 Toast，长流程使用分步模态框，抽屉内使用子 Tab；列表页不整页滚动，搜索与筛选工具栏留在视口内，只让列表区域内部滚动，长列表使用虚拟滚动与无限滚动加载；列表不超出屏幕宽度，长名称截断成省略号且整行不换行，行高统一，列不够时按优先级隐藏；避免文字海报和页面／图标硬切；禁止把系统或开发者提示、技能、工具调用、Agent 计划、框架／库／包标识、内部路径、调试信息或内部状态写进用户界面；完成后加载 browser-use 检查真实渲染与交互。仅在用户明确要求具名视觉方向时配合 stylekit，不能覆盖产品规范。'

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
      expect(await readFile(notificationUrl, 'utf8')).toContain('request failure that only needs brief acknowledgement')
      expect(await readFile(notificationUrl, 'utf8')).toContain('Shared Dialog, Drawer, Stepper, Tabs, Field, and Toast primitives')
      expect(loaded.content).toContain('prefers-reduced-motion')
      expect(loaded.content).toContain('Never render system or developer instructions')
      expect(loaded.content).toContain('Compose a product surface, not a text poster')
      expect(loaded.content).toContain('Only content the user supplied and explicitly asked to inspect')
      expect(loaded.content).toContain('do not hand-write a foundation from zero')
      expect(loaded.content).toContain('remain usable within one viewport (`100vh`')
      expect(loaded.content).toContain('Use hierarchy intentionally: use child tabs')
      expect(loaded.content).toContain('A create action must open a modal dialog')
      expect(loaded.content).toContain('Check that the primary flow fits within the target viewport')
      expect(loaded.content).toContain('only the list body scrolls')
      expect(loaded.content).toContain('A page-scrolling list, an unbounded mounted row count, and a full collection fetched before the first screen are defects')
      expect(loaded.content).toContain('Own the scroll in exactly one place: the list viewport')
      expect(loaded.content).toContain('the next page loads before the end with visible loading and end-of-list states')
      expect(loaded.content).toContain('Keep the list inside the viewport width with uniform, single-line rows')
      expect(loaded.content).toContain('Keep rows one line and one height')
      expect(loaded.content).toContain('every row reports the same height')
      expect(loaded.content).toContain('list-scroll.md')
      expect(loaded.content).toContain('implementation-facing instructions, prompt fragments, debugging vocabulary, or process narration')
      expect(loaded.content).toContain('not implementation prompts or internal process narration')
      expect(loaded.content).toContain('browser-use')
      expect(loaded.content).toContain('load the `stylekit` skill')
      expect(loaded.content).toContain('followed a `stylekit` style spec')
      expect(await readFile(motionIndexUrl, 'utf8')).toContain('view-switch.css')
      expect(await readFile(motionIndexUrl, 'utf8')).toContain('view-switch.css')
      expect(await readFile(iconLibraryUrl, 'utf8')).toContain('Use [Lucide]')
      expect(await readFile(iconLibraryUrl, 'utf8')).toContain('Do not hand-draw or inline SVG icons')
      const listScrollReference = await readFile(listScrollUrl, 'utf8')
      expect(listScrollReference).toContain('the only scroll container')
      expect(listScrollReference).toContain('Do not simulate a fixed toolbar with `position: sticky`')
      expect(listScrollReference).toContain('the toolbar is stationary while rows scroll')
      expect(listScrollReference).toContain('one line per row, never wider than the screen')
      expect(listScrollReference).toContain('text-overflow: ellipsis')
      expect(listScrollReference).toContain('minmax(0, 1fr)')
      expect(listScrollReference).toContain('At the narrowest supported width the page has no horizontal scroll')
      expect(await readFile(motionIndexUrl, 'utf8')).toContain('view-switch.css')
      for (const url of motionRecipeUrls) {
        expect(await readFile(url, 'utf8')).toContain('prefers-reduced-motion')
      }
    } finally {
      await fiber.dispose()
    }
    expect(await ctx.skills.list()).toEqual([])
  })
})
