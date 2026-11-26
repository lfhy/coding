// @vitest-environment jsdom
/** 文件树的排序、懒展开行、空态与目录错误恢复。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { IdeFileTree } from '../src/client/IdeFileTree.tsx'
import type { IdeDirectoryState } from '../src/client/ide-store.ts'
import { zh } from '../src/client/locales.ts'
import { translate } from './translate.client.ts'

afterEach(() => { cleanup() })

function setup(directories: Record<string, IdeDirectoryState>, expanded: string[] = []) {
  const onToggle = vi.fn()
  const onOpen = vi.fn()
  const onRetry = vi.fn()
  render(<IdeFileTree title="项目" collapsed={false} width={280} directories={directories} expanded={expanded}
    activePath="src/a.ts" onToggle={onToggle} onOpen={onOpen} onRetry={onRetry} t={translate} />)
  return { onToggle, onOpen, onRetry }
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
})
