import { describe, expect, it } from 'vitest'
import { insertTable } from '../src/client/markdown-table.ts'

const template = { headers: ['列 1', '列 2'] as const, rows: 2 }
const table = '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n|  |  |'

describe('插入表格模板', () => {
  it('空文档里只插入表格本身', () => {
    const edit = insertTable('', 0, template)
    expect(edit.value).toBe(`${table}\n`)
    expect([edit.from, edit.to]).toEqual([0, 0])
  })

  it('光标在空行上时插在该行位置，前后各留一个空行', () => {
    const edit = insertTable('abc\n\ndef', 5, template)
    expect(edit.value).toBe(`abc\n\n${table}\n\ndef`)
  })

  it('光标在有正文的行上时接在这一行下面', () => {
    const edit = insertTable('abc\ndef', 1, template)
    expect(edit.value).toBe(`abc\n\n${table}\n\ndef`)
  })

  it('前面没有空行时补一行，避免表格被上一段吞掉', () => {
    const edit = insertTable('abc\ndef', 4, template)
    expect(edit.value).toBe(`abc\n\n${table}\n\ndef`)
  })

  it('文末插入后仍以换行结尾，不多出空行', () => {
    const edit = insertTable('abc\n', 4, template)
    expect(edit.value).toBe(`abc\n\n${table}\n`)
  })

  it('后面已经有空行时不再多补空行', () => {
    const edit = insertTable('abc\n\ndef', 1, template)
    expect(edit.value).toBe(`abc\n\n${table}\n\ndef`)
  })

  it('插入后选中第一个表头文字，直接输入即可改名', () => {
    const edit = insertTable('', 0, template)
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe('列 1')
  })

  it('多列表头按给定数量与顺序生成', () => {
    const edit = insertTable('', 0, { headers: ['A', 'B', 'C'] as const, rows: 1 })
    expect(edit.value.split('\n')[0]).toBe('| A | B | C |')
    expect(edit.value.split('\n')[2]).toBe('|  |  |  |')
    expect(edit.value.split('\n')).toHaveLength(4)
  })
})
