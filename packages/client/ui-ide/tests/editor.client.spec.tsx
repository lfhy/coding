// @vitest-environment jsdom
/** 文本编辑器的快捷键、光标状态、错误恢复与有界行号呈现。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { IdeEditor } from '../src/client/IdeEditor.tsx'
import type { IdeDocument } from '../src/client/ide-store.ts'
import { zh } from '../src/client/locales.ts'
import { translate } from './translate.client.ts'

afterEach(() => { cleanup() })

function document(overrides: Partial<IdeDocument> = {}): IdeDocument {
  return {
    path: 'a.ts', name: 'a.ts', segments: ['a.ts'], content: 'const a = 1\n', savedContent: 'const a = 1\n',
    version: 'v1', dirty: false, status: 'ready', ...overrides,
  }
}

function setup(overrides: Partial<IdeDocument> = {}) {
  const onChange = vi.fn()
  const onSave = vi.fn()
  const onReload = vi.fn()
  const onRetry = vi.fn()
  render(<IdeEditor document={document(overrides)} t={translate} onChange={onChange}
    onSave={onSave} onReload={onReload} onRetry={onRetry} />)
  return { onChange, onSave, onReload, onRetry }
}

describe('IDE 文本编辑器', () => {
  it('显示行号、语言与光标位置，并同步横向滚动', () => {
    setup({ content: 'first\nsecond' })
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('TS')).toBeTruthy()
    fireEvent.select(input, { target: { selectionStart: 8, selectionEnd: 8 } })
    expect(screen.getByText('第 2 行，第 3 列')).toBeTruthy()
    input.scrollTop = 42
    fireEvent.scroll(input)
    expect(input.parentElement?.firstElementChild).toHaveProperty('scrollTop', 42)
    fireEvent.click(input)
    fireEvent.keyUp(input, { key: 'ArrowRight' })
  })

  it('Tab 插入缩进，Shift+Tab 按两个或一个空格退格', () => {
    const first = setup({ content: 'abc' })
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    input.setSelectionRange(3, 3)
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(first.onChange).toHaveBeenLastCalledWith('abc  ')
    cleanup()

    const two = setup({ content: '  abc' })
    const twoInput = screen.getByRole('textbox') as HTMLTextAreaElement
    twoInput.setSelectionRange(5, 5)
    fireEvent.keyDown(twoInput, { key: 'Tab', shiftKey: true })
    expect(two.onChange).toHaveBeenLastCalledWith('abc')
    cleanup()

    const one = setup({ content: ' abc' })
    const oneInput = screen.getByRole('textbox') as HTMLTextAreaElement
    oneInput.setSelectionRange(4, 4)
    fireEvent.keyDown(oneInput, { key: 'Tab', shiftKey: true })
    expect(one.onChange).toHaveBeenLastCalledWith('abc')
    cleanup()

    const none = setup({ content: 'abc' })
    const noneInput = screen.getByRole('textbox') as HTMLTextAreaElement
    noneInput.setSelectionRange(3, 3)
    fireEvent.keyDown(noneInput, { key: 'Tab', shiftKey: true })
    expect(none.onChange).not.toHaveBeenCalled()
  })

  it('带选区的 Shift+Tab 仍插入缩进，修饰键与保存快捷键分开处理', () => {
    const { onChange, onSave } = setup({ content: 'abc' })
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    input.setSelectionRange(0, 1)
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    fireEvent.keyDown(input, { key: 'Tab', ctrlKey: true })
    fireEvent.keyDown(input, { key: 'Tab', altKey: true })
    expect(onChange).toHaveBeenCalledOnce()
    fireEvent.keyDown(input, { key: 's', metaKey: true })
    fireEvent.keyDown(input, { key: 's', ctrlKey: true })
    fireEvent.keyDown(input, { key: 'x', ctrlKey: true })
    expect(onSave).toHaveBeenCalledTimes(2)
  })

  it('加载、读取失败、二进制与过大文件显示对应状态', () => {
    const first = setup({ status: 'loading' })
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
    expect(first.onRetry).not.toHaveBeenCalled()
    cleanup()

    const failed = setup({ status: 'error', error: 'load' })
    expect(screen.getByRole('alert').textContent).toBe(zh.loadError)
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(failed.onRetry).toHaveBeenCalledOnce()
    cleanup()

    setup({ status: 'unsupported', error: 'unsupported' })
    expect(screen.getByText(zh.unsupported)).toBeTruthy()
    cleanup()
    setup({ status: 'unsupported', error: 'too-large' })
    expect(screen.getByText(zh.tooLarge)).toBeTruthy()
  })

  it('冲突与普通保存失败保留可编辑草稿，并提供不同恢复动作', () => {
    const conflict = setup({ dirty: true, error: 'conflict' })
    expect(screen.getByText(zh.conflictKept)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.reload }))
    expect(conflict.onReload).toHaveBeenCalledOnce()
    cleanup()

    const failed = setup({ dirty: true, error: 'save' })
    expect(screen.getByText(zh.draftKept)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(failed.onRetry).toHaveBeenCalledOnce()
  })

  it('超长文件隐藏行号，无扩展名与尾点文件显示纯文本', () => {
    setup({ name: 'README', content: Array.from({ length: 5_001 }, () => 'x').join('\n') })
    expect(screen.queryByText('5001')).toBeNull()
    expect(screen.getByText(zh.plainText)).toBeTruthy()
    fireEvent.scroll(screen.getByRole('textbox'))
    cleanup()
    setup({ name: 'config.', content: '' })
    expect(screen.getByText(zh.plainText)).toBeTruthy()
  })
})
