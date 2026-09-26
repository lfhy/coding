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
})

describe('terminal tabs', () => {
  it('places new tabs alongside existing tabs and keeps panel close at the right edge', () => {
    expect(terminalCss).toMatch(/\.tabs\s*\{[^}]*flex:\s*0 1 auto/)
    expect(terminalCss).toMatch(/\.iconButton:last-child\s*\{[^}]*margin-left:\s*auto/)
    expect(terminalCss).toMatch(/\.connection\[data-connected='true'\]\s*\{[^}]*position:\s*absolute/)
  })
})
