import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/WorkspaceWorkbench.module.css', import.meta.url)), 'utf8')
const terminalCss = readFileSync(fileURLToPath(new URL('../src/client/TerminalPanel.module.css', import.meta.url)), 'utf8')

describe('workbench desktop titlebar', () => {
  it('allows dragging empty topbar space while controls remain interactive', () => {
    expect(css).toMatch(/\.topbar\s*\{[^}]*-webkit-app-region:\s*no-drag/)
    expect(css).toMatch(/\.topbar\s*\{[^}]*padding:\s*0 calc\(8px \+ var\(--app-safe-area-inset-right, 0px\)\) 0 8px/)
    expect(css).toMatch(/\.topbar button,\s*\.topbar input\s*\{[^}]*-webkit-app-region:\s*no-drag/)
  })

  it('reserves the macOS control band only while the workbench owns the main area', () => {
    // 停靠右栏时工作台列左缘已在会话列之后，避让内边距与避让带都只挂在全屏条件下。
    const gate = ':global([data-workbench-fullscreen][data-sidebar-collapsed]) .topbar'
    expect(css).toContain(`${gate} {`)
    expect(css).toContain(`${gate}::before {`)
    expect(css).toMatch(/padding-left:\s*calc\(8px \+ var\(--app-safe-area-inset-top, 0px\)\)/)
    // 避让带排在标签之前，宽度必须跟着同一条件走，否则停靠右栏时它会吃掉标签左端的点击。
    expect(css).toMatch(/\.topbar::before\s*\{[^}]*width:\s*0;[^}]*-webkit-app-region:\s*no-drag/)
  })

  it('shares one tab width, height, spacing and selection treatment across tab types', () => {
    expect(css).toMatch(/\.topbar\s*\{[^}]*--workbench-tab-width:\s*184px/)
    expect(css).toMatch(/\.browserTabs\s*\{[^}]*flex:\s*0 1 var\(--workbench-tab-width\)/)
    expect(css).toMatch(/\.tab\s*\{[^}]*flex:\s*0 1 var\(--workbench-tab-width\)/)
    expect(css).toMatch(/\.tab\s*\{[^}]*height:\s*var\(--workbench-tab-height\)/)
    expect(css).toMatch(/\.tab:not\(\.tabActive\):hover:has\(> button:enabled\)/)
    expect(css).toMatch(/\.tab:not\(\.tabActive\):focus-within/)
    expect(css).toMatch(/\.tabSelect\s*\{[^}]*height:\s*100%/)
    expect(css).toMatch(/\.tabGlyph\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px/)
    expect(css).toMatch(/\.tabClose\s*\{[^}]*width:\s*26px;[^}]*height:\s*26px;[^}]*padding:\s*0;[^}]*border-radius:\s*8px/)
  })
})

describe('workbench narrow files layout', () => {
  it('gives the file manager a full-width tree without a preview overlay', () => {
    expect(css).toMatch(
      /\.root\[data-narrow='true'\] \.body\[data-file-manager='true'\]\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
    )
    expect(css).toMatch(
      /\.root\[data-narrow='true'\] \.body\[data-file-manager='true'\] \.previewStack\s*\{[^}]*display:\s*none/,
    )
    expect(css).not.toMatch(/\.root\[data-narrow='true'\] \.treeView[^{}]*\{[^}]*position:\s*absolute/)
  })
})

describe('workbench file tree scrolling', () => {
  it('constrains the tree panel and lets the tree own vertical overflow', () => {
    expect(css).toMatch(/\.treeView\s*\{[^}]*display:\s*grid[^}]*min-height:\s*0[^}]*overflow:\s*hidden/)
    expect(css).toMatch(/\.filesPanel\s*\{[^}]*height:\s*100%/)
    expect(css).toMatch(/\.tree\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/)
  })
})

describe('terminal tabs', () => {
  it('keeps the selected glyph above xterm’s opaque selection layer', () => {
    // 本包自行实现 xterm 样式，需保留其为选中字符提供的顶层堆叠规则。
    expect(terminalCss).toMatch(/\.screen :global\(\.xterm \.xterm-decoration-top\)\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/)
  })

  it('places new tabs alongside existing tabs and keeps panel close at the right edge', () => {
    expect(terminalCss).toMatch(/\.tabs\s*\{[^}]*flex:\s*0 1 auto/)
    expect(terminalCss).toMatch(/\.iconButton:last-child\s*\{[^}]*margin-left:\s*auto/)
    expect(terminalCss).toMatch(/\.connection\[data-connected='true'\]\s*\{[^}]*position:\s*absolute/)
  })
})
