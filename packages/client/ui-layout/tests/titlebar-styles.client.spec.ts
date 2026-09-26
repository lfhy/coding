import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/AppFrame.module.css', import.meta.url)), 'utf8')

describe('AppFrame titlebar hit regions', () => {
  it('keeps all panel resize separators outside native window dragging', () => {
    expect(css).toMatch(/\.handle\s*\{[^}]*-webkit-app-region: no-drag;/)
  })
})
