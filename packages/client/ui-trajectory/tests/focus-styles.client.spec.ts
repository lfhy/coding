import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/TrajectoryToolbar.module.css', import.meta.url)), 'utf8')

function rule(selector: string): string {
  const block = css.split(`${selector} {`).at(-1)?.split('}')[0]
  expect(css).toContain(`${selector} {`)
  return block ?? ''
}

describe('轨迹搜索焦点样式', () => {
  it('输入框只由圆角外壳显示一层主题色焦点光晕', () => {
    expect(rule('.search')).toContain('border-radius: 4px')
    expect(rule('.searchInput')).toContain('outline: 0')

    const focus = rule('.search:focus-within')
    expect(focus).toContain('border-color: var(--dsw-alias-state-business-primary)')
    expect(focus).toContain('box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)')
    expect(focus).not.toMatch(/outline\s*:/)
  })
})
