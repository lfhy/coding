import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/GoalBar.module.css', import.meta.url)), 'utf8')

function block(selector: string): string {
  const rule = css.split(`${selector} {`)
  expect(rule.length, `缺少 ${selector} 样式`).toBe(2)
  return rule[1]?.split('}')[0] ?? ''
}

describe('GoalBar 输入焦点样式', () => {
  it('编辑目标时保留圆角，并以单层主题色光晕显示键盘焦点', () => {
    expect(block('.objectiveInput')).toContain('border-radius: 6px')
    expect(block('.objectiveInput:focus')).toContain('border-color: var(--dsw-alias-state-business-primary)')
    const focus = block('.objectiveInput:focus-visible')
    expect(focus).toContain('box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)')
    expect(focus).not.toMatch(/outline\s*:/)
  })
})
