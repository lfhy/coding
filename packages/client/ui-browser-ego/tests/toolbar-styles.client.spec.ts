import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const css = readFileSync(fileURLToPath(new URL('../src/client/AgentBrowserPanel.module.css', import.meta.url)), 'utf8')

/**
 * 读取命中选择器的第一条规则正文；断言只关心声明，不锁换行或属性顺序。
 * @param selector - 规则选择器前缀。
 * @returns 从该选择器到该规则右花括号的原文。
 */
function rule(selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`missing rule ${selector}`)
  return css.slice(start, css.indexOf('}', start))
}

describe('Agent 浏览器工具栏样式', () => {
  it('工具栏图标按钮只在悬停时出现背景，静息状态保持透明', () => {
    // 整条工具栏读作一条通道：图标自身着色，不靠填充块划分可点击区域。
    expect(rule('.iconButton {')).toContain('background: transparent')
    expect(rule('.iconButton {')).not.toContain('--dsw-alias-button-tool-bar-fill')
    expect(rule('.iconButton:hover:not(:disabled)')).toContain('--dsw-alias-interactive-bg-hover')
    expect(css).not.toContain('--dsw-alias-button-tool-bar-hover')
  })

  it('键盘焦点与禁用态仍可辨认，不因透明背景丢掉状态差异', () => {
    expect(rule('.iconButton:focus-visible')).toContain('--dsw-alias-state-business-primary')
    expect(rule('.iconButton:disabled')).toContain('opacity: 0.4')
    expect(rule('.iconButton:disabled')).not.toContain('background')
  })
})
