import { describe, expect, it } from 'vitest'
import { indentSelection } from '../src/client/markdown-indent.ts'

describe('markdown 按行缩进', () => {
  it('缩进选区覆盖的每一行，并把选区扩到整行', () => {
    const edit = indentSelection('a\nb\nc', 0, 3, false)
    expect(edit.value).toBe('  a\n  b\nc')
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([0, 7])
    expect(edit.block).toBe('  a\n  b')
  })

  it('选区从行中开始也只改整行，选中停在行首的那一行不算在内', () => {
    const edit = indentSelection('a\nb\nc', 1, 4, false)
    expect(edit.value).toBe('  a\n  b\nc')
    expect([edit.from, edit.to]).toEqual([0, 3])
  })

  it('退一级删掉行首两格空格，只删得到的行改变原样其余保持', () => {
    const edit = indentSelection('    a\n b\nc', 0, 10, true)
    expect(edit.value).toBe('  a\nb\nc')
  })

  it('退一级把行首制表符当成一级缩进', () => {
    const edit = indentSelection('\ta\n\t b', 0, 5, true)
    expect(edit.value).toBe('a\n b')
  })

  it('一行空白都没有时退不动，返回原文与原选区', () => {
    const edit = indentSelection('a\nb', 0, 3, true)
    expect(edit).toEqual({ value: 'a\nb', from: 0, to: 3, block: 'a\nb', selectionStart: 0, selectionEnd: 3 })
  })

  it('只是选中换行时缩进该换行所属的行', () => {
    const edit = indentSelection('a\nb', 1, 2, false)
    expect(edit.value).toBe('  a\nb')
  })

  it('空行不缩进，避免在 Markdown 里留下行尾空格', () => {
    const edit = indentSelection('a\n\nb', 0, 4, false)
    expect(edit.value).toBe('  a\n\n  b')
  })
})
