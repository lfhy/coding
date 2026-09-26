import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/BrowserMirror.module.css', import.meta.url)), 'utf8')

describe('browser mirror responsive styles', () => {
  it('keeps screenshot ratio and cursor geometry on narrow and wide layouts', () => {
    expect(css).toMatch(/\.viewport\s*\{[^}]*width:\s*min\(100%, 1280px\)/)
    expect(css).toMatch(/\.canvas\s*\{[^}]*overflow:\s*auto/)
    expect(css).toContain('@media (max-width: 768px)')
    expect(css).toContain('@media (max-width: 375px)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toMatch(/\.close:focus-visible[^}]*outline:/)
  })
})
