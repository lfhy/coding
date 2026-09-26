import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url)), 'utf8')
const root = readFileSync(fileURLToPath(new URL('../src/client/skeleton/ConversationRoot.tsx', import.meta.url)), 'utf8')
const session = readFileSync(fileURLToPath(new URL('../src/client/skeleton/ConversationSession.tsx', import.meta.url)), 'utf8')
const details = readFileSync(fileURLToPath(new URL('../src/client/skeleton/DetailsPanel.module.css', import.meta.url)), 'utf8')
const detailsMarkup = readFileSync(fileURLToPath(new URL('../src/client/skeleton/DetailsPanel.tsx', import.meta.url)), 'utf8')

describe('Hero action titlebar clearance', () => {
  it('keeps actions at the top and reserves only the platform right inset', () => {
    const actions = css.match(/\.heroActions\s*\{([^}]*)\}/)?.[1]
    expect(actions).toMatch(/\btop:\s*12px;/)
    expect(actions).toMatch(/\bright:\s*calc\(24px \+ var\(--app-safe-area-inset-right, 0px\)\);/)
    expect(actions).not.toContain('--app-safe-area-inset-top')
    expect(css).toMatch(/@media \(max-width: 480px\)\s*\{\s*\.heroActions/)
    expect(css).toContain('.heroActions { right: calc(12px + var(--app-safe-area-inset-right, 0px)); }')
    expect(css).toContain(':global([data-workbench-shown]) .heroActions {\n  right: 24px;\n}')
    expect(css).toContain(':global([data-workbench-shown]) .heroActions { right: 12px; }')
  })

  it('exposes an empty Hero drag strip and keeps actions clickable', () => {
    expect(root).toContain('(hero || settling) && <div className={css.windowDragStrip} data-window-drag-strip data-window-drag-region aria-hidden="true" />')
    expect(css).toMatch(/\.windowDragStrip\s*\{[^}]*right: var\(--app-safe-area-inset-right, 0px\);[^}]*-webkit-app-region: no-drag;/)
    expect(css).toMatch(/\.heroActions\s*\{[^}]*-webkit-app-region: no-drag;/)
    expect(css).toContain(
      ':global([data-sidebar-collapsed]) .windowDragStrip {\n' +
      '  left: max(0px, calc(var(--app-safe-area-inset-top, 0px) - 4px));',
    )
    expect(css).toMatch(/:global\(\[data-workbench-shown\]\) \.windowDragStrip\s*\{\s*right: 0;/)
  })

  it('drags only empty active headers while preserving controls and Windows caption clearance', () => {
    expect(session).toContain('<div className={css.activeHeaderDragStrip} data-window-drag-header-strip data-window-drag-region aria-hidden="true" />')
    expect(session).toContain('<div className={css.titleRow} data-window-drag-region>')
    expect(session).toContain('<div className={css.tabs} role="tablist" data-window-drag-region>')
    expect(css).toMatch(/\.activeHeaderDragStrip\s*\{[^}]*height: 12px;[^}]*-webkit-app-region: no-drag;/)
    expect(css).toContain(
      ':global([data-details-collapsed]:not([data-workbench-shown])) .activeHeaderDragStrip {\n' +
      '  right: var(--app-safe-area-inset-right, 0px);',
    )
    expect(css).toContain(
      ':global([data-details-collapsed]:not([data-workbench-shown])) .header {\n' +
      '  padding-right: calc(28px + var(--app-safe-area-inset-right, 0px));',
    )
    expect(css).toMatch(/\.header :is\([^)]*button[^)]*\)\s*\{\s*-webkit-app-region: no-drag;/)
    expect(css).toContain(
      ':global([data-sidebar-collapsed]) .activeHeaderDragStrip {\n' +
      '  left: max(0px, calc(var(--app-safe-area-inset-top, 0px) - 4px));',
    )
    expect(css).toMatch(/\.titleRow\s*\{[^}]*-webkit-app-region: no-drag;/)
    expect(css).toContain(
      ':global([data-sidebar-collapsed]) .titleRow {\n' +
      '  margin-left: max(0px, calc(var(--app-safe-area-inset-top, 0px) - 24px));',
    )
    expect(css).toMatch(/\.tabs\s*\{[^}]*-webkit-app-region: no-drag;/)
    expect(detailsMarkup).toContain('<div className={css.header} data-window-drag-region>')
    expect(details).toMatch(/\.header\s*\{[^}]*-webkit-app-region: no-drag;/)
    expect(details).toContain('padding: 14px calc(12px + var(--app-safe-area-inset-right, 0px)) 12px 12px;')
    expect(details).toMatch(/\.header :is\([^)]*button[^)]*\)\s*\{\s*-webkit-app-region: no-drag;/)
  })
})
