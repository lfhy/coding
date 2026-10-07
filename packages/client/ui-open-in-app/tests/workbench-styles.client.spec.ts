import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/WorkspaceWorkbench.module.css', import.meta.url)), 'utf8')
const terminalCss = readFileSync(fileURLToPath(new URL('../src/client/TerminalPanel.module.css', import.meta.url)), 'utf8')

describe('workbench desktop titlebar', () => {
  it('allows dragging empty topbar space while controls remain interactive', () => {
    expect(css).toMatch(/\.topbar\s*\{[^}]*-webkit-app-region:\s*no-drag/)
    expect(css).toMatch(/\.topbar\s*\{[^}]*padding:\s*0 calc\(8px \+ var\(--app-safe-area-inset-right, 0px\)\)/)
    expect(css).toMatch(/\.topbar button,\s*\.topbar input\s*\{[^}]*-webkit-app-region:\s*no-drag/)
    expect(css).toMatch(/\.topbar::before\s*\{[^}]*width:\s*var\(--app-safe-area-inset-top, 0px\)[^}]*-webkit-app-region:\s*no-drag/)
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

describe('terminal tabs', () => {
  it('places new tabs alongside existing tabs and keeps panel close at the right edge', () => {
    expect(terminalCss).toMatch(/\.tabs\s*\{[^}]*flex:\s*0 1 auto/)
    expect(terminalCss).toMatch(/\.iconButton:last-child\s*\{[^}]*margin-left:\s*auto/)
    expect(terminalCss).toMatch(/\.connection\[data-connected='true'\]\s*\{[^}]*position:\s*absolute/)
  })
})
