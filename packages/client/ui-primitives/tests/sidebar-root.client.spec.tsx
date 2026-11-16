// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
})
