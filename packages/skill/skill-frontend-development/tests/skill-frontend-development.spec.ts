import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { FsRegistry } from 'coding-fs'
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
const examplesIndexUrl = new URL('../assets/examples/index.md', import.meta.url)
const exampleUrls = [
  'tabs/Tabs.tsx',
  'tabs/Tabs.module.css',
  'dialog/Dialog.tsx',
  'dialog/Dialog.module.css',
  'toast/Toast.tsx',
  'toast/Toast.module.css',
  'pages/auth-page.tsx',
  'pages/auth-page.module.css',
  'pages/settings-page.tsx',
  'pages/settings-page.module.css',
  'pages/list-page.tsx',
  'pages/list-page.module.css',
].map(path => new URL(`../assets/examples/${path}`, import.meta.url))
const resourcePrefix = '${INTERNAL_SKILL_DIR}/coding-skill-frontend-development'
const description = '在创建或修改前端、网页、组件或用户界面时使用。遵循项目已有技术栈、组件、图标库和设计规范；没有既有图标库时按需读取内置参考并默认选用 Lucide，禁止手写或内联 SVG（除非确实缺少领域图标且已走项目图标抽象，且先用画图工具生成底板再转 SVG）；请求失败等短暂通知必须使用共享 Toast，长流程使用分步模态框，抽屉内使用子 Tab；列表页不整页滚动，搜索与筛选工具栏留在视口内，只让列表区域内部滚动，长列表使用虚拟滚动与无限滚动加载；列表不超出屏幕宽度，长名称截断成省略号且整行不换行，行高统一，列不够时按优先级隐藏；缺少共享组件时直接抄内置案例（子 Tab、弹层、Toast、认证页、设置页含修改密码弹窗、列表页），并保持其 ARIA 与键盘行为；避免文字海报和页面／图标硬切；禁止把系统或开发者提示、技能、工具调用、Agent 计划、框架／库／包标识、内部路径、调试信息或内部状态写进用户界面；完成后加载 browser-use 检查真实渲染与交互。仅在用户明确要求具名视觉方向时配合 stylekit，不能覆盖产品规范。'

describe('bundled frontend-development skill', () => {
  it('registers and loads its published instructions', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    // 内置技能的展示路径是虚拟前缀，插件挂载时把它注册到文件系统。
    await ctx.plugin(FsRegistry)
    const fiber = await ctx.plugin(SkillFrontendDevelopment)
    try {
      // 插件挂载时把虚拟前缀登记到文件系统，模型之后才能按前缀读到资产。
      expect(ctx.fs.pathAliasPrefixes).toEqual([resourcePrefix])
      expect(await ctx.skills.list()).toEqual([{
        name: 'frontend-development', description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'frontend-development', source: 'bundled',
        resourceBase: { kind: 'alias', path: resourcePrefix },
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
      expect(loaded.content).toContain('assets/examples/index.md')
      expect(loaded.content).toContain('Copyable examples')
      expect(loaded.content).toContain('map its `--ui-*` seams onto the product')
      const exampleIndex = await readFile(examplesIndexUrl, 'utf8')
      expect(exampleIndex).toContain('tabs/Tabs.tsx')
      expect(exampleIndex).toContain('pages/settings-page.tsx')
      expect(exampleIndex).toContain('never keep a private copy')
      expect(loaded.content).toContain('One shared copy per concept')
      const [tabsUrl, tabsCssUrl, dialogUrl, dialogCssUrl, toastUrl, toastCssUrl, authUrl, authCssUrl,
        settingsUrl, settingsCssUrl, listUrl, listCssUrl] = exampleUrls
      expect(await readFile(tabsUrl!, 'utf8')).toContain('role="tabpanel"')
      expect(await readFile(tabsUrl!, 'utf8')).toContain('aria-selected')
      expect(await readFile(tabsCssUrl!, 'utf8')).toContain('--ui-border')
      expect(await readFile(dialogUrl!, 'utf8')).toContain('aria-modal="true"')
      expect(await readFile(dialogCssUrl!, 'utf8')).toContain('100dvh')
      expect(await readFile(toastUrl!, 'utf8')).toContain('aria-live="polite"')
      expect(await readFile(toastCssUrl!, 'utf8')).toContain('--ui-border')
      // 认证页是单列居中卡片，占满视口高度、宽度 400px 上限。
      expect(await readFile(authUrl!, 'utf8')).toContain('className={styles.page}')
      expect(await readFile(authCssUrl!, 'utf8')).toContain('min-height: 100dvh')
      expect(await readFile(authCssUrl!, 'utf8')).toContain('width: min(400px, 100%)')
      // 设置页：竖向子 Tab + 修改密码按钮打开弹窗，而不是把表单平铺在页面上。
      expect(await readFile(settingsUrl!, 'utf8')).toContain('orientation="vertical"')
      expect(await readFile(settingsUrl!, 'utf8')).toContain('<Dialog open={changing}')
      expect(await readFile(settingsCssUrl!, 'utf8')).toContain('--ui-accent')
      // 列表页：页面 100dvh，工具栏在滚动区之外，行单行省略。
      expect(await readFile(listUrl!, 'utf8')).toContain('role="list"')
      expect(await readFile(listCssUrl!, 'utf8')).toContain('grid-template-columns: minmax(0, 1fr)')
      expect(await readFile(listCssUrl!, 'utf8')).toContain('text-overflow: ellipsis')
      expect(loaded.content).toContain('load the `stylekit` skill')
      expect(loaded.content).toContain('followed a `stylekit` style spec')
      expect(await readFile(motionIndexUrl, 'utf8')).toContain('view-switch.css')
      expect(await readFile(motionIndexUrl, 'utf8')).toContain('view-switch.css')
      expect(await readFile(iconLibraryUrl, 'utf8')).toContain('Use [Lucide]')
      expect(await readFile(iconLibraryUrl, 'utf8')).toContain('Do not hand-draw or inline SVG icons')
      // 缺插图／领域图标时先画底板再转 SVG，而不是凭空手绘路径。
      expect(loaded.content).toContain('draw a base plate first with the image tool')
      expect(loaded.content).toContain('Without image tools, fall back to a library icon with a label')
      expect(await readFile(iconLibraryUrl, 'utf8')).toContain('Draw the base plate before writing the path')
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
