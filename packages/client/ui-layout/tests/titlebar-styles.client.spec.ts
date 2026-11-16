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

  it('将 macOS 共用开关放到外层导航底部，页内按钮在桌面端退出布局和焦点顺序', () => {
    expect(shellCss).toMatch(/\.footer\s*\{[^}]*margin-top:\s*auto;/u)
    expect(shellCss).toMatch(/\.desktopSidebarToggle\s*\{[^}]*display:\s*var\(--desktop-sidebar-toggle, none\);/u)
    expect(shellCss).not.toMatch(/\.desktopSidebarToggle\s*\{[^}]*\b(?:top|left):\s*\d+px;/u)
    expect(shellCss).toMatch(/\.desktopSidebarToggle\s*\{[^}]*-webkit-app-region:\s*no-drag;/u)
    expect(conversationCss).toMatch(/\.sectionToggle\s*\{[^}]*display:\s*var\(--sidebar-inline-toggle, flex\);/u)
    expect(railCss).toMatch(/\.toggleArea\s*\{[^}]*display:\s*var\(--sidebar-inline-toggle, flex\);/u)
    expect(pageCss).toMatch(/\.iconButton\s*\{[^}]*display:\s*var\(--sidebar-inline-toggle, inline-flex\);/u)
    expect(pageCss).toMatch(/\.railToggle\s*\{[^}]*display:\s*var\(--sidebar-inline-toggle, inline-flex\);/u)
  })
})
