import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const css = readFileSync(fileURLToPath(new URL('../src/client/BrowserMirror.module.css', import.meta.url)), 'utf8')
describe('browser responsive styles', () => {
  it('keeps tabs scrollable and image/cursor scaled without clipping narrow controls', () => {
    expect(css).toContain('.tabs { display: flex')
    expect(css).toContain('overflow-x: auto')
    expect(css).toContain('width: 100%')
    expect(css).toContain('.address:focus-within')
    expect(css).toContain('@media (max-width: 768px)')
    expect(css).toContain('@media (max-width: 375px)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
