// @vitest-environment jsdom
/** 外侧入口的当前页标记、异步禁用与共享 Toast 反馈。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PageRoute } from 'coding-client-ui-layout/client'
import { IdeNavigationEntry } from '../src/client/IdeNavigationEntry.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function entryProps(openIde: () => Promise<void>, active = false) {
  return {
    openIde,
    t: (key: keyof typeof zh) => zh[key],
    useIdePage: (select: (page: PageRoute | null) => unknown) =>
      select(active ? { kind: 'ide' } as PageRoute : null),
  }
}

describe('代码工作区导航入口', () => {
  it('只渲染图标按钮，并在欢迎页打开时标记当前页', async () => {
    const openIde = vi.fn(async () => {})
    const props = entryProps(openIde)
    const view = render(<IdeNavigationEntry {...(props as unknown as React.ComponentProps<typeof IdeNavigationEntry>)} />)
    const button = screen.getByRole('button', { name: zh.nav })
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-current')).toBeNull()

    view.rerender(<IdeNavigationEntry {...(entryProps(openIde, true) as unknown as React.ComponentProps<typeof IdeNavigationEntry>)} />)
    expect(button.getAttribute('aria-current')).toBe('page')
    fireEvent.click(button)
    await waitFor(() => { expect(openIde).toHaveBeenCalledOnce() })
  })

  it('打开期间禁用入口，结束后恢复点击', async () => {
    let finish!: () => void
    const openIde = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    render(<IdeNavigationEntry {...(entryProps(openIde) as unknown as React.ComponentProps<typeof IdeNavigationEntry>)} />)
    const button = screen.getByRole('button', { name: zh.nav }) as HTMLButtonElement

    fireEvent.click(button)
    expect(button.disabled).toBe(true)
    await act(async () => { finish() })
    expect(button.disabled).toBe(false)
  })

  it('失败显示共享 Toast，连续失败更新提示并在到时后清除', async () => {
    vi.useFakeTimers()
    const openIde = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
    render(<IdeNavigationEntry {...(entryProps(openIde) as unknown as React.ComponentProps<typeof IdeNavigationEntry>)} />)
    const button = screen.getByRole('button', { name: zh.nav }) as HTMLButtonElement

    fireEvent.click(button)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('alert').textContent).toBe(zh.entryError)
    expect(button.disabled).toBe(false)

    fireEvent.click(button)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('alert').textContent).toBe(zh.entryError)
    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
