import { describe, expect, it } from 'vitest'
import { edgeSelection, indentAtCaret, indentSelection, lineEdges } from '../src/client/editor-keys.ts'

describe('编辑器按行缩进', () => {
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

  it('光标处 Tab 插入一级缩进并停在缩进之后', () => {
    const edit = indentAtCaret('abc', 1)
    expect(edit.value).toBe('a  bc')
    expect([edit.from, edit.to, edit.block]).toEqual([1, 1, '  '])
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([3, 3])
  })
})

describe('编辑器 Home／End 语义', () => {
  const text = 'ab\n  cd\nef'

  it('取光标所在逻辑行的首尾，行尾不含换行符', () => {
    expect(lineEdges(text, 5)).toEqual({ start: 3, end: 7 })
    expect(lineEdges(text, 0)).toEqual({ start: 0, end: 2 })
    // 光标停在换行符位置时仍属于前一行。
    expect(lineEdges(text, 2)).toEqual({ start: 0, end: 2 })
  })

  it('End 落在行尾而不是文末', () => {
    expect(edgeSelection(text, 5, 5, 'none', 'end', false)).toEqual(
      { value: text, selectionStart: 7, selectionEnd: 7, selectionDirection: 'none' },
    )
  })

  it('Home 先落在行内首个非空白字符，已经在那里时回到行首', () => {
    expect(edgeSelection(text, 6, 6, 'none', 'start', false).selectionStart).toBe(5)
    expect(edgeSelection(text, 5, 5, 'none', 'start', false).selectionStart).toBe(3)
  })

  it('按住 Shift 保留锚点，选区方向跟随落点一侧', () => {
    const forward = edgeSelection(text, 5, 5, 'none', 'end', true)
    expect([forward.selectionStart, forward.selectionEnd, forward.selectionDirection]).toEqual([5, 7, 'forward'])
    const fromEnd = edgeSelection(text, 7, 7, 'none', 'start', true)
    expect([fromEnd.selectionStart, fromEnd.selectionEnd, fromEnd.selectionDirection]).toEqual([5, 7, 'backward'])
  })

  it('反向选区按起点那一端移动，锚点留在另一端', () => {
    // 反向选区（起点 5 是移动端、终点 8 是锚点）：End 把起点推到所在行行尾 7，锚点不动。
    const edit = edgeSelection(text, 5, 8, 'backward', 'end', true)
    expect([edit.selectionStart, edit.selectionEnd, edit.selectionDirection]).toEqual([7, 8, 'backward'])
  })

  it('有选区时用会移动的那一端所在行，不跳到选区另一端的行', () => {
    const edit = edgeSelection(text, 3, 7, 'forward', 'end', false)
    expect(edit.selectionStart).toBe(7)
  })

  it('光标越界时按全文边界兜住', () => {
    expect(lineEdges(text, -5)).toEqual({ start: 0, end: 2 })
    expect(lineEdges(text, 999)).toEqual({ start: 8, end: 10 })
  })

  it('Windows 换行下 End 停在 \\r 之前', () => {
    const crlf = 'ab\r\ncd'
    expect(lineEdges(crlf, 1)).toEqual({ start: 0, end: 2 })
  })
})
