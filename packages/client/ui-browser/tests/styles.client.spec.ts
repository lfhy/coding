import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const css = readFileSync(fileURLToPath(new URL('../src/client/BrowserMirror.module.css', import.meta.url)), 'utf8')

/**
 * 读取命中选择器的第一条规则正文；断言只关心声明，不锁换行或属性顺序。
 * @param selector - 规则选择器前缀，逗号并列时用其中第一段即可。
 * @returns 从该选择器到该规则右花括号的原文。
 */
function rule(selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`missing rule ${selector}`)
  return css.slice(start, css.indexOf('}', start))
}

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

  it('paints tab hover and selection on the item, keeping the close button inside the tab box', () => {
    // 整块标签承载选中与悬停背景：逐个按钮的盒子会把关闭键留在标签外。
    expect(rule(".tab:not([data-active='true']):hover:has(> button:enabled)"))
      .toContain('--dsw-alias-interactive-bg-hover')
    expect(rule(".tab[data-active='true']")).toContain('--dsw-alias-interactive-bg-active')
    expect(rule('.tabClose:hover:not(:disabled)')).toContain('--dsw-alias-interactive-bg-hover')
    expect(css).not.toContain('.tab button:hover')
  })
})
