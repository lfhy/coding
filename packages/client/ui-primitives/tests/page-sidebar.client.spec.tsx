// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PageSidebar, type PageSidebarItem } from '../src/PageSidebar.tsx'

afterEach(cleanup)

const items: PageSidebarItem[] = [
  { id: 'all', label: '全部', icon: 'files-panel', active: true, onSelect: vi.fn() },
  { id: 'image', label: '图片', icon: 'model-vision', onSelect: vi.fn() },
]
const labels = { collapse: '收起侧栏', expand: '展开侧栏' }

describe('PageSidebar', () => {
  it('展开时呈现标题行与可选中条目，选中项用 aria-current 标记', () => {
    render(<PageSidebar label="资料空间" title="资料空间" items={items} collapsed={false} onToggle={vi.fn()} labels={labels} />)
    expect(screen.getByRole('complementary', { name: '资料空间' })).toBeTruthy()
    expect(screen.getByText('资料空间')).toBeTruthy()
    const all = screen.getByText('全部').closest('button')
    expect(all.getAttribute('aria-current')).toBe('true')
    expect(screen.getByText('图片').closest('button')?.getAttribute('aria-current')).toBeNull()
    fireEvent.click(screen.getByText('图片'))
    expect(items[1]?.onSelect).toHaveBeenCalledOnce()
  })

  it('收起后每条退化为 36px 图标按钮，并保留展开入口', () => {
    const onToggle = vi.fn()
    render(<PageSidebar label="资料空间" title="资料空间" items={items} collapsed onToggle={onToggle} labels={labels} />)
    expect(screen.getByRole('button', { name: '全部' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '图片' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '展开侧栏' }))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('无条目时显示空态说明，而不是空列表', () => {
    render(<PageSidebar label="资料空间" title="资料空间" items={[]} collapsed={false} onToggle={vi.fn()} labels={labels} empty="还没有生成图片" />)
    expect(screen.getByText('还没有生成图片')).toBeTruthy()
  })

  it('缩略图行同时给出图标，收起后仍可识别', () => {
    render(<PageSidebar label="最近生成" title="最近生成" variant="media" collapsed={false} onToggle={vi.fn()} labels={labels}
      items={[{ id: 'a', label: '云海', icon: 'model-vision', media: <img src="blob:x" alt="" /> }]} />)
    expect(screen.getByText('云海').closest('button')?.querySelector('img')).not.toBeNull()
  })
})
