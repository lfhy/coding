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

  it('侧栏开关只在外层导航底部渲染，所有端与页内都不再出第二枚', () => {
    // 外层：固定显示，不靠平台变量开关。
    expect(shellCss).toMatch(/\.footer\s*\{[^}]*margin-top:\s*auto;/u)
    expect(shellCss).toMatch(/\.sidebarToggle\s*\{[^}]*-webkit-app-region:\s*no-drag;/u)
    expect(shellCss).not.toMatch(/\.sidebarToggle\s*\{[^}]*display:\s*none;/u)
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
