// @vitest-environment jsdom
/** 文件页分类图标的语义颜色与选中状态分别由页面和共享侧栏承载。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { FilesPage, type FilesPageProps } from '../src/client/FilesPage.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

describe('文件管理分类侧栏', () => {
  it('所有类别在选中前就各自带颜色，侧栏折叠后也沿用颜色', async () => {
    const base = {
      list: vi.fn(async () => ({ items: [], total: 0 })),
      closePage: vi.fn(), toggleSidebar: vi.fn(),
      t: (key: keyof typeof zh) => zh[key],
      sidebarCollapsed: false, sidebarWidth: 280,
    }
    const view = render(<FilesPage {...(base as unknown as FilesPageProps)} />)
    const sidebar = within(screen.getByRole('complementary', { name: '资料空间' }))
    const expected = [
      ['全部', 'amber'], ['图片', 'green'], ['幻灯片', 'violet'],
      ['文档', 'blue'], ['其他', 'amber'],
    ] as const
    for (const [name, tone] of expected) {
      const item = sidebar.getByText(name).closest('[role="listitem"]')
      expect(item?.getAttribute('data-icon-tone')).toBe(tone)
      expect(item?.getAttribute('aria-current')).toBe(name === '全部' ? 'true' : null)
    }
    view.rerender(<FilesPage {...({ ...base, sidebarCollapsed: true, sidebarWidth: 56 } as unknown as FilesPageProps)} />)
    await waitFor(() => { expect(sidebar.getByRole('button', { name: '全部' })).toBeTruthy() })
    for (const [name, tone] of expected) {
      expect(sidebar.getByRole('button', { name }).getAttribute('data-icon-tone')).toBe(tone)
    }
  })
})
