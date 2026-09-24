import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url)), 'utf8')

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
})
