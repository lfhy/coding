import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/AppFrame.module.css', import.meta.url)), 'utf8')
const shellCss = readFileSync(fileURLToPath(new URL('../src/client/WindowShell.module.css', import.meta.url)), 'utf8')
const conversationCss = readFileSync(fileURLToPath(new URL('../../ui-workspace/src/client/WorkspaceBrowser.module.css', import.meta.url)), 'utf8')
const railCss = readFileSync(fileURLToPath(new URL('../../ui-sidebar/src/client/SidebarRoot.module.css', import.meta.url)), 'utf8')
const pageCss = readFileSync(fileURLToPath(new URL('../../ui-primitives/src/SidebarRoot.module.css', import.meta.url)), 'utf8')

describe('AppFrame titlebar hit regions', () => {
  it('keeps all panel resize separators outside native window dragging', () => {
    expect(css).toMatch(/\.handle\s*\{[^}]*-webkit-app-region: no-drag;/)
  })

  it('导航列自成一张带外框的卡片，与内层工作区之间留出窗口底色', () => {
    // 左列宽度可变：桌面壳按交通灯宽度注入，Web 缺省 52px。
    expect(shellCss).toMatch(/\.shell\s*\{[^}]*grid-template-columns:\s*var\(--app-rail-inline-size, 52px\)/u)
    expect(shellCss).toMatch(/\.shell\s*\{[^}]*column-gap:\s*8px;/u)
    // 外框与圆角让导航列（含顶部原生按钮区）成为独立一列。
    expect(shellCss).toMatch(/\.navigation\s*\{[^}]*border:\s*1px solid var\(--dsw-alias-border-l1\);/u)
    expect(shellCss).toMatch(/\.navigation\s*\{[^}]*border-radius:\s*16px;/u)
    expect(shellCss).toMatch(/\.titleDragInset\s*\{[^}]*width:\s*calc\(8px \+ var\(--app-rail-inline-size, 52px\)\);/u)
    // 内层圆角工作区仍靠自身外圈单独成卡，两卡之间只有窗口底色。
    expect(shellCss).toMatch(/\.surface\s*\{[^}]*border-radius:\s*16px;/u)
  })

  it('侧栏开关只在外层导航底部渲染，所有端与页内都不再出第二枚', () => {
    // 外层：固定显示，不靠平台变量开关。
    expect(shellCss).toMatch(/\.footer\s*\{[^}]*margin-top:\s*auto;/u)
    // 开关与主题按钮共用一个规则块，选择器列表里出现 `.sidebarToggle` 即可。
    expect(shellCss).toMatch(/\.sidebarToggle[^{}]*\{[^}]*-webkit-app-region:\s*no-drag;/u)
    expect(shellCss).not.toMatch(/\.sidebarToggle[^{}]*\{[^}]*display:\s*none;/u)
    expect(shellCss).not.toContain('--desktop-sidebar-toggle')
    // 页内：对话区头、侧栏图标轨、页内侧栏都没有开关样式。
    for (const source of [conversationCss, railCss, pageCss]) {
      expect(source).not.toContain('--sidebar-inline-toggle')
    }
    expect(conversationCss).not.toContain('.sectionToggle')
    expect(railCss).not.toContain('.toggleArea')
    expect(pageCss).not.toContain('.railToggle')
  })
})
