import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/QuestionComposer.module.css', import.meta.url)), 'utf8')

function rule(selector: string): string {
  const block = css.split(`${selector} {`).at(-1)?.split('}')[0]
  expect(css).toContain(`${selector} {`)
  return block ?? ''
}

describe('提问自定义答案焦点样式', () => {
  it('文本框沿自身圆角显示一层主题色焦点光晕', () => {
    expect(rule('.customTextarea')).toContain('border-radius: 10px')
    expect(rule('.customTextarea')).toContain('outline: none')

    const focus = rule('.customTextarea:focus')
    expect(focus).toContain('border-color: var(--dsw-alias-state-business-primary)')
    expect(focus).toContain('box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)')
    expect(focus).not.toMatch(/outline\s*:/)
  })
})
