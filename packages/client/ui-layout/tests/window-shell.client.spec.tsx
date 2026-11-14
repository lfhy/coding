// @vitest-environment jsdom
/** 外层导航只改变布局呈现，原有会话子树和草稿在折叠及返回时保持挂载。 */
import { useEffect, useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from 'coding-session/types'
import type { WindowShellProps } from 'coding-client-ui-layout/src/client/WindowShell.tsx'
import { WindowShell } from 'coding-client-ui-layout/src/client/WindowShell.tsx'
import { createLayoutStore } from 'coding-client-ui-layout/src/client/stores.ts'
import { zh } from 'coding-client-ui-layout/src/client/locales.ts'

const lifecycle = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }))

vi.mock('coding-client-ui-layout/src/client/AppFrame.tsx', () => ({
  AppFrame: function FrameContent() {
    useEffect(() => {
      lifecycle.mount()
      return () => { lifecycle.unmount() }
    }, [])
    return <textarea aria-label="对话草稿" />
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function mountShell(current: SessionId | null = 'shell-session' as SessionId) {
  const instance = createLayoutStore().create()
  const props = {
    actions: instance.actions,
    useStore: selector => selector(useSyncExternalStore(
      listener => instance.subscribe(listener), () => instance.getSnapshot(),
    )),
    useSessions: selector => selector({ current: current ?? undefined } as never),
    t: key => (zh as Record<string, string>)[key] ?? key,
    renderSlot: (key, owner) => key === 'shell.settings'
      ? <button type="button" aria-label="设置" data-compact={'wide' in owner && !owner.wide} />
      : null,
  } as WindowShellProps
  return { instance, ...render(<WindowShell {...props} />) }
}

describe('窗口外壳', () => {
  it('包裹原布局，并在折叠与展开后保留会话草稿和挂载身份', () => {
    const view = mountShell()
    expect(view.getByRole('navigation', { name: '主导航' })).toBeTruthy()
    expect(view.container.querySelector('[data-window-content] textarea')).toBeTruthy()
    expect(view.container.querySelector('header')?.textContent).toBe('')
    expect(view.getByRole('button', { name: '回到对话' }).querySelector('img')).toBeNull()
    expect(view.getByRole('button', { name: '回到对话' }).querySelector('svg')).toBeTruthy()
    expect(view.getByRole('navigation').contains(view.getByRole('button', { name: '设置' }))).toBe(true)
    const draft = view.getByRole('textbox', { name: '对话草稿' }) as HTMLTextAreaElement
    fireEvent.change(draft, { target: { value: '保留这份草稿' } })
    expect(view.getByRole('navigation').querySelectorAll('button')).toHaveLength(2)
    act(() => { view.instance.actions.toggleSidebar() })
    expect(view.instance.getSnapshot().sidebar).toBe(0)
    expect(view.getByRole('button', { name: '设置' }).getAttribute('data-compact')).toBe('true')
    act(() => { view.instance.actions.toggleSidebar() })
    expect(view.instance.getSnapshot().sidebar).toBeGreaterThan(0)
    expect(view.getByRole('textbox', { name: '对话草稿' })).toBe(draft)
    expect(draft.value).toBe('保留这份草稿')
    expect(lifecycle.mount).toHaveBeenCalledOnce()
    expect(lifecycle.unmount).not.toHaveBeenCalled()
  })

  it('内层窄屏展开时，外层仍只保留主页和设置两个入口', () => {
    const view = mountShell()
    const width = view.instance.getSnapshot().sidebar
    act(() => { view.instance.actions.setNarrow(true) })
    act(() => { view.instance.actions.toggleSidebar() })
    expect(view.getByRole('navigation').querySelectorAll('button')).toHaveLength(2)
    expect(view.instance.getSnapshot().sidebar).toBe(width)
    act(() => { view.instance.actions.toggleSidebar() })
    expect(view.instance.getSnapshot().narrowExpanded).toBe(false)
  })

  it('从独立页面回到当前对话，不创建或切换会话', () => {
    const view = mountShell()
    act(() => { view.instance.actions.openPage('gallery', 'shell-session' as SessionId) })
    const back = view.getByRole('button', { name: '回到对话' })
    expect(back.getAttribute('aria-current')).toBeNull()
    fireEvent.click(back)
    expect(view.instance.getSnapshot().page).toBeNull()
    expect(view.instance.getSnapshot().conversationRequest?.sessionId).toBe('shell-session')
    expect(back.getAttribute('aria-current')).toBe('page')
    expect(lifecycle.mount).toHaveBeenCalledOnce()
  })

  it('无会话时也能返回欢迎页，不发出无目标的对话请求', () => {
    const view = mountShell(null)
    fireEvent.click(view.getByRole('button', { name: '回到对话' }))
    expect(view.instance.getSnapshot().conversationRequest).toBeNull()
  })
})
