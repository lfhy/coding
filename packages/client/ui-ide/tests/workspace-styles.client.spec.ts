import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/IdeTabs.module.css', import.meta.url)), 'utf8')

describe('IDE 标签栏几何', () => {
  it('标签栏占满编辑区宽度，高度单独由纵轴约束', () => {
    expect(css).toMatch(/\.tabs\s*\{[^}]*flex:\s*1 1 auto;[^}]*height:\s*36px/)
    expect(css).not.toMatch(/\.tabs\s*\{[^}]*flex:\s*0 0 36px/)
  })
})
