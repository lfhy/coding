/** 表格在窄面板内的折行规则：单元格换行、数字列不换行、滚动只作兜底。 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/GenuiBlock.module.css', import.meta.url), 'utf8')

/** 取某个选择器块（到下一个 `}` 为止）的规则体。 */
function blockOf(selector: string): string {
  const at = css.indexOf(selector)
  if (at < 0) throw new Error(`missing rule ${selector}`)
  const end = css.indexOf('}', at)
  return css.slice(at, end)
}

describe('GenUI 表格布局', () => {
  it('让表头与单元格按容器宽度折行，而不是整表横向滚动', () => {
    for (const selector of ['.table th {', '.table td {']) {
      const rule = blockOf(selector)
      expect(rule).toContain('white-space: normal')
      // anywhere 会让短列的最小宽度塌到一个字符，提交号一类的内容被竖排；
      // break-word 只在必要时断开长词。
      expect(rule).toContain('overflow-wrap: break-word')
      expect(rule).not.toContain('white-space: nowrap')
    }
  })

  it('数字列保持单行，滚动容器只兜住无法折行的内容', () => {
    expect(blockOf('.table th.thNum, .table td.tdNum')).toContain('white-space: nowrap')
    const wrap = blockOf('.tableWrap {')
    expect(wrap).toContain('overflow-x: auto')
    expect(wrap).toContain('max-width: 100%')
  })
})
