// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { HeroSidebarToggle } from '../src/client/HeroSidebarToggle.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

it('欢迎页按实际侧栏状态显示操作名称，并使用布局的同一开关', () => {
  const toggleSidebar = vi.fn()
  const props = { sidebarCollapsed: true, toggleSidebar, t: makeTranslate(zh) } as unknown as
    React.ComponentProps<typeof HeroSidebarToggle>
  const view = render(<HeroSidebarToggle {...props} />)
  const open = view.getByRole('button', { name: '打开侧边栏' })
  expect(open.getAttribute('title')).toBe('打开侧边栏')
  fireEvent.click(open)
  expect(toggleSidebar).toHaveBeenCalledOnce()

  view.rerender(<HeroSidebarToggle {...props} sidebarCollapsed={false} />)
  expect(view.getByRole('button', { name: '收起侧边栏' })).toBeTruthy()
})
