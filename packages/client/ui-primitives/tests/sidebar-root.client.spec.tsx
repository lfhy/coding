// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Button } from '../src/Button.tsx'
import { SidebarRoot, type SidebarRootItem } from '../src/SidebarRoot.tsx'

afterEach(cleanup)

const items: SidebarRootItem[] = [
  { id: 'all', label: '全部', icon: 'files-panel', iconTone: 'amber', active: true, onSelect: vi.fn() },
  { id: 'image', label: '图片', icon: 'model-vision', iconTone: 'green', onSelect: vi.fn() },
]
describe('SidebarRoot', () => {
  it('展开时呈现标题行与可选中条目，选中项用 aria-current 标记', () => {
    render(<SidebarRoot label="资料空间" title="资料空间" items={items} collapsed={false} width={320} />)
    expect(screen.getByRole('complementary', { name: '资料空间' })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: '资料空间' }).getAttribute('style')).toContain('width: 320px')
    expect(screen.getByText('资料空间')).toBeTruthy()
    const all = screen.getByText('全部').closest('button')
    expect(all?.getAttribute('aria-current')).toBe('true')
    expect(all?.getAttribute('data-icon-tone')).toBe('amber')
    const image = screen.getByText('图片').closest('button')
    expect(image?.getAttribute('aria-current')).toBeNull()
    expect(image?.getAttribute('data-icon-tone')).toBe('green')
    fireEvent.click(screen.getByText('图片'))
    expect(items[1]?.onSelect).toHaveBeenCalledOnce()
  })

  it('收起后每条退化为 36px 图标按钮，列内不再有开关', () => {
    render(<SidebarRoot label="资料空间" title="资料空间" items={items} collapsed width={56} />)
    expect(screen.getByRole('complementary', { name: '资料空间' }).getAttribute('style')).toContain('width: 56px')
    expect(screen.getByRole('button', { name: '全部' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '全部' }).getAttribute('data-icon-tone')).toBe('amber')
    expect(screen.getByRole('button', { name: '图片' }).getAttribute('data-icon-tone')).toBe('green')
    // 收放统一由外层导航底部的那一枚承担。
    expect(screen.queryByRole('button', { name: '展开侧栏' })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(items.length)
  })

  it('无条目时显示空态说明，而不是空列表', () => {
    render(<SidebarRoot label="资料空间" title="资料空间" items={[]} collapsed={false} width={280} empty="还没有生成图片" />)
    expect(screen.getByText('还没有生成图片')).toBeTruthy()
  })

  it('缩略图行同时给出图标，收起后仍可识别', () => {
    render(<SidebarRoot label="最近生成" title="最近生成" variant="media" collapsed={false} width={280}
      items={[{ id: 'a', label: '云海', icon: 'model-vision', media: <img src="blob:x" alt="" /> }]} />)
    expect(screen.getByText('云海').closest('button')?.querySelector('img')).not.toBeNull()
  })

  it('树形条目按层级缩进，目录行带展开箭头与 aria-expanded', () => {
    const tree: SidebarRootItem[] = [
      { id: 'd1', label: '想法', icon: 'files', folder: true, open: true, depth: 0, onSelect: vi.fn() },
      { id: 'n1', label: '草稿', icon: 'file', depth: 1, active: true, onSelect: vi.fn() },
      { id: 'n0', label: '顶层笔记', icon: 'file', depth: 0, onSelect: vi.fn() },
    ]
    render(<SidebarRoot label="笔记" title="笔记" items={tree} collapsed={false} width={280} />)
    const dir = screen.getByText('想法').closest('button')
    expect(dir?.getAttribute('aria-expanded')).toBe('true')
    const deep = screen.getByText('草稿').closest('button')
    expect(deep?.style.getPropertyValue('--tree-depth')).toBe('1')
    expect(deep?.getAttribute('aria-expanded')).toBeNull()
    const top = screen.getByText('顶层笔记').closest('button')
    expect(top?.style.getPropertyValue('--tree-depth')).toBe('0')
  })

  it('收起的图标轨只显示文件条目，目录行不进入图标轨', () => {
    const tree: SidebarRootItem[] = [
      { id: 'd1', label: '想法', icon: 'files', folder: true, open: true, depth: 0 },
      { id: 'n1', label: '草稿', icon: 'file', depth: 1 },
      { id: 'n0', label: '顶层笔记', icon: 'file', depth: 0 },
    ]
    render(<SidebarRoot label="笔记" title="笔记" items={tree} collapsed width={56} />)
    expect(screen.getByRole('button', { name: '顶层笔记' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '草稿' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '想法' })).toBeNull()
  })

  it('header 插槽渲染在标题行上方，收起态保留在图标轨之前', () => {
    const header = <button type="button" data-testid="page-entry">子页切换</button>
    const { unmount } = render(<SidebarRoot label="最近生成" title="最近生成" items={items} collapsed={false} width={280} header={header} />)
    const entry = screen.getByTestId('page-entry')
    expect(entry.compareDocumentPosition(screen.getByText('最近生成')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    unmount()
    render(<SidebarRoot label="最近生成" title="最近生成" items={items} collapsed width={56} header={header} />)
    expect(screen.getByTestId('page-entry')).toBeTruthy()
    expect(screen.queryByText('最近生成')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(items.length + 1)
  })

  it('标题同行的动作不随卷动列表卸载，收起后仍是原按钮', async () => {
    const name = '这是一篇需要保留完整提示的长标题笔记'
    const onCreate = vi.fn()
    const headerAction = <Button onClick={onCreate}>新建</Button>
    const tree: SidebarRootItem[] = [{ id: 'a', label: name, icon: 'notes' }]
    const view = render(<SidebarRoot label="笔记" title="全部笔记" items={tree} collapsed={false} width={280} headerAction={headerAction} />)
    const action = screen.getByRole('button', { name: '新建' })
    expect(action.parentElement?.textContent).toContain('全部笔记')
    expect(screen.getByRole('listitem').getAttribute('title')).toBe(name)
    expect(screen.getByRole('list').contains(action)).toBe(false)
    vi.useFakeTimers()
    try {
      view.rerender(<SidebarRoot label="笔记" title="全部笔记" items={tree} collapsed width={56} headerAction={headerAction} />)
      await act(async () => { vi.advanceTimersByTime(150) })
      expect(screen.queryByText('全部笔记')).toBeNull()
      expect(screen.getByRole('button', { name: '新建' })).toBe(action)
      expect(screen.getAllByRole('button')).toEqual([action, screen.getByRole('button', { name })])
      fireEvent.click(action)
      expect(onCreate).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('展开态的行尾动作独立于行按钮，收起时不进入图标轨', () => {
    const onSelect = vi.fn()
    const onRename = vi.fn()
    const notes = [{ id: 'draft', label: '草稿', icon: 'notes', meta: '11月19日', onSelect,
      actions: <Button aria-label="重命名草稿" onClick={onRename} /> }] satisfies SidebarRootItem[]
    const { unmount } = render(<SidebarRoot label="笔记" title="全部笔记" items={notes} collapsed={false} width={280} variant="summary" />)
    const row = within(screen.getByRole('listitem'))
    const note = row.getByRole('button', { name: '草稿' })
    const rename = row.getByRole('button', { name: '重命名草稿' })
    expect(row.getByText('11月19日')).toBeTruthy()
    expect(note.contains(rename)).toBe(false)
    fireEvent.click(rename)
    expect(onRename).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()

    unmount()
    render(<SidebarRoot label="笔记" title="全部笔记" items={notes} collapsed width={56} variant="summary" />)
    expect(screen.queryByRole('button', { name: '重命名草稿' })).toBeNull()
    expect(screen.getByRole('button', { name: '草稿' })).toBeTruthy()
  })
})
