/** 加载态只复用主题 token，并在减少动态效果时保持静态状态提示。 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/StreamingFence.module.css', import.meta.url), 'utf8')

describe('流式围栏动效样式', () => {
  it('为加载指示器提供循环动画和减少动态效果覆盖', () => {
    expect(css).toContain('@keyframes spin')
    expect(css).toContain('linear infinite')
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.spinner\s*\{\s*animation:\s*none;/u)
    expect(css).toContain('var(--dsw-alias-state-business-primary)')
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/iu)
  })

  it('在有界占位区域内水平和垂直居中，不保留代码正文区域', () => {
    expect(css).toContain('min-height: 120px')
    expect(css).toContain('align-items: center')
    expect(css).toContain('justify-content: center')
    expect(css).not.toContain('.body')
    expect(css).not.toContain('.header')
    expect(css).not.toContain('.language')
  })
})
