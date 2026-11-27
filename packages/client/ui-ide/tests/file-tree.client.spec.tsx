// @vitest-environment jsdom
/** 文件树的排序、懒展开行、空态与目录错误恢复。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { IdeFileTree } from '../src/client/IdeFileTree.tsx'
import type { IdeOpenEditorRow } from '../src/client/IdeOpenEditors.tsx'
import type { IdeDirectoryState } from '../src/client/ide-store.ts'
import { zh } from '../src/client/locales.ts'
import { translate } from './translate.client.ts'

afterEach(() => { cleanup() })

function setup(directories: Record<string, IdeDirectoryState>, expanded: string[] = [], collapsed = false,
  openEditors: IdeOpenEditorRow[] = []) {
  const onToggle = vi.fn()
  const onOpen = vi.fn()
  const onActivateEditor = vi.fn()
  const onPinEditor = vi.fn()
  const onRetry = vi.fn()
  render(<IdeFileTree title="项目" collapsed={collapsed} width={280} directories={directories} expanded={expanded}
    activePath="src/a.ts" openEditors={openEditors} onToggle={onToggle} onOpen={onOpen}
    onActivateEditor={onActivateEditor} onPinEditor={onPinEditor} onRetry={onRetry} t={translate} />)
  return { onToggle, onOpen, onActivateEditor, onPinEditor, onRetry }
}

describe('IDE 文件树', () => {
  it('目录优先、名称排序，展开后显示子级并忽略其他类型', () => {
    const { onToggle, onOpen } = setup({
      '': {
        status: 'ready', truncated: false,
        entries: [
          { name: 'z.ts', type: 'file', segments: ['z.ts'] },
          { name: 'src', type: 'directory', segments: ['src'] },
          { name: 'a.ts', type: 'file', segments: ['a.ts'] },
          { name: 'link', type: 'other', segments: ['link'] },
        ],
      },
      src: {
        status: 'ready', truncated: false,
        entries: [{ name: 'a.ts', type: 'file', segments: ['src', 'a.ts'] }],
      },
    }, ['src'])
    const rows = screen.getAllByRole('listitem')
    expect(rows.map(row => row.textContent)).toEqual(['src', 'a.ts', 'a.ts', 'z.ts'])
    fireEvent.click(screen.getByText('src'))
    expect(onToggle).toHaveBeenCalledWith('src')
    fireEvent.click(within(rows[1] as HTMLElement).getByText('a.ts'))
    expect(onOpen).toHaveBeenCalledWith('src/a.ts', 'a.ts', ['src', 'a.ts'])
  })

  it('根目录加载、空态、截断与失败分别显示对应反馈', () => {
    setup({ '': { status: 'loading', entries: [], truncated: false } })
    expect(screen.getByText(zh.loading)).toBeTruthy()
    cleanup()
    setup({ '': { status: 'ready', entries: [], truncated: false } })
    expect(screen.getByText(zh.treeEmpty)).toBeTruthy()
    cleanup()
    setup({ '': { status: 'ready', entries: [], truncated: true } })
    expect(screen.getByText(zh.treeTruncated)).toBeTruthy()
    cleanup()
    const failed = setup({ '': { status: 'error', entries: [], truncated: false } })
    expect(screen.getByRole('alert').textContent).toContain(zh.treeError)
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(failed.onRetry).toHaveBeenCalledOnce()
  })

  it('顶部打开编辑器与项目文件分区共用侧栏，预览可双击固定', () => {
    const opened = setup({ '': { status: 'ready', entries: [], truncated: false } }, [], false, [
      { path: 'a.ts', name: 'a.ts', paneId: 'pane-0', active: true, dirty: true, preview: true },
      { path: 'b.ts', name: 'b.ts', paneId: 'pane-1', active: false, dirty: false, preview: false },
    ])
    expect(screen.getByRole('region', { name: zh.openEditors })).toBeTruthy()
    const preview = screen.getByRole('button', { name: /a\.ts/ })
    const pinned = screen.getByRole('button', { name: /b\.ts/ })
    expect(preview.closest('[data-preview]')).not.toBeNull()
    expect(pinned.closest('[data-preview]')).toBeNull()
    fireEvent.click(preview)
    fireEvent.doubleClick(preview)
    fireEvent.doubleClick(pinned)
    expect(opened.onActivateEditor).toHaveBeenCalledWith('pane-0', 'a.ts')
    expect(opened.onPinEditor).toHaveBeenCalledOnce()
    expect(opened.onPinEditor).toHaveBeenCalledWith('pane-0', 'a.ts')
  })

  it('没有打开编辑器时显示空态，收起侧栏时隐藏整个分区', () => {
    setup({ '': { status: 'ready', entries: [], truncated: false } })
    expect(screen.getByText(zh.noOpenEditors)).toBeTruthy()
    cleanup()
    setup({ '': { status: 'ready', entries: [], truncated: false } }, [], true, [
      { path: 'a.ts', name: 'a.ts', paneId: 'pane-0', active: true, dirty: false, preview: true },
    ])
    expect(screen.queryByRole('region', { name: zh.openEditors })).toBeNull()
  })
})
