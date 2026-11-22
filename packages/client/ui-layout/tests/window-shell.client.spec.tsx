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
import type { ThemeSnapshot } from 'coding-client-ui-theme/client'

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

type ColorScheme = ThemeSnapshot['active']['colorScheme']

function mountShell(current: SessionId | null = 'shell-session' as SessionId, systemScheme: ColorScheme = 'light') {
  const instance = createLayoutStore().create()
  let theme: ThemeSnapshot = {
    preference: 'system',
    active: { id: systemScheme, colorScheme: systemScheme, tokens: {} },
    themes: [],
    revision: 1,
  }
  const themeListeners = new Set<() => void>()
  const publishTheme = (preference: string, colorScheme: ColorScheme) => {
    const id = preference === 'system' ? colorScheme : preference
    theme = { ...theme, preference, active: { ...theme.active, id, colorScheme }, revision: theme.revision + 1 }
    for (const listener of themeListeners) listener()
  }
  const props = {
    actions: instance.actions,
    useStore: selector => selector(useSyncExternalStore(
      listener => instance.subscribe(listener), () => instance.getSnapshot(),
    )),
    useSessions: selector => selector({ current: current ?? undefined } as never),
    useTheme: selector => selector(useSyncExternalStore(
      (listener) => { themeListeners.add(listener); return () => { themeListeners.delete(listener) } }, () => theme,
    )),
    setTheme: (id: Parameters<WindowShellProps['setTheme']>[0]) => { publishTheme(id, id === 'system' ? systemScheme : id) },
    t: key => (zh as Record<string, string>)[key] ?? key,
    renderSlot: (key, owner) => {
      if (key === 'shell.settings') return <button type="button" aria-label="设置" data-compact={'wide' in owner && !owner.wide} />
      if (key === 'shell.navigation.entry') return <button type="button" aria-label="画图" data-nav-entry />
      return null
    },
  } as WindowShellProps
  return {
    instance,
    getTheme: () => theme,
    publishTheme,
    setSystemScheme: (scheme: ColorScheme) => {
      systemScheme = scheme
      if (theme.preference === 'system') publishTheme('system', scheme)
    },
    ...render(<WindowShell {...props} />),
  }
}

describe('窗口外壳', () => {
  it('包裹原布局，并在折叠与展开后保留会话草稿和挂载身份', () => {
    const view = mountShell()
    expect(view.getByRole('navigation', { name: '主导航' })).toBeTruthy()
    expect(view.container.querySelector('[data-window-content] textarea')).toBeTruthy()
    // 外壳不再自带顶栏：内层顶到窗口上沿，只留导航列顶部的窗口拖拽垫片。
    expect(view.container.querySelector('header')).toBeNull()
    expect(view.container.querySelector('[data-window-shell] > [data-window-drag-region]')).toBeTruthy()
    // 交通灯由系统绘制：外壳不再垫装饰托盘，侧栏自己用安全区避让按钮。
    expect(view.getByRole('button', { name: '回到对话' }).querySelector('img')).toBeNull()
    expect(view.getByRole('button', { name: '回到对话' }).querySelector('svg')).toBeTruthy()
    expect(view.getByRole('navigation').contains(view.getByRole('button', { name: '设置' }))).toBe(true)
    // 中部入口排在主页图标之后；桌面开关与设置同在底部控件组。
    const labels = Array.from(view.getByRole('navigation').querySelectorAll('button'))
      .map(button => button.getAttribute('aria-label'))
    expect(labels).toEqual(['回到对话', '画图', '收起侧边栏', '切换深色主题', '设置'])
    expect(view.getByRole('button', { name: '收起侧边栏' }).parentElement?.parentElement?.parentElement
      ?.contains(view.getByRole('button', { name: '设置' }))).toBe(true)
    const draft = view.getByRole('textbox', { name: '对话草稿' }) as HTMLTextAreaElement
    fireEvent.change(draft, { target: { value: '保留这份草稿' } })
    expect(view.getByRole('navigation').querySelectorAll('button')).toHaveLength(5)
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

  it.each([
    { scheme: 'light', opposite: 'dark', firstLabel: '切换深色主题', secondLabel: '切换浅色主题' },
    { scheme: 'dark', opposite: 'light', firstLabel: '切换浅色主题', secondLabel: '切换深色主题' },
  ] as const)('从跟随系统（$scheme）先切相反色，再切回同色的固定主题，最后回到跟随系统', ({
    scheme, opposite, firstLabel, secondLabel,
  }) => {
    const view = mountShell(undefined, scheme)
    const nextButton = (name: string) => view.getByRole('button', { name })
    const toggle = nextButton(firstLabel)
    const icons = [toggle.querySelector('svg')?.innerHTML]
    fireEvent.click(toggle)
    expect(view.getTheme().preference).toBe(opposite)
    icons.push(nextButton(secondLabel).querySelector('svg')?.innerHTML)
    fireEvent.click(nextButton(secondLabel))
    expect(view.getTheme().preference).toBe(scheme)
    icons.push(nextButton('跟随系统配色').querySelector('svg')?.innerHTML)
    expect(icons.every(Boolean)).toBe(true)
    expect(new Set(icons).size).toBe(3)
    fireEvent.click(nextButton('跟随系统配色'))
    expect(view.getTheme()).toMatchObject({ preference: 'system', active: { colorScheme: scheme } })
    expect(nextButton(firstLabel)).toBe(toggle)
  })

  it('系统换色不会跳过第二个固定档位，回到跟随后立即应用新的系统配色', () => {
    const view = mountShell()
    fireEvent.click(view.getByRole('button', { name: '切换深色主题' }))
    act(() => { view.setSystemScheme('dark') })
    fireEvent.click(view.getByRole('button', { name: '切换浅色主题' }))
    expect(view.getTheme()).toMatchObject({ preference: 'light', active: { colorScheme: 'light' } })
    fireEvent.click(view.getByRole('button', { name: '跟随系统配色' }))
    expect(view.getTheme()).toMatchObject({ preference: 'system', active: { colorScheme: 'dark' } })
    act(() => { view.setSystemScheme('light') })
    expect(view.getByRole('button', { name: '切换深色主题' })).toBeTruthy()
  })

  it('设置改选主题后丢弃旧的循环位置，自定义主题仍先切成相反色', () => {
    const view = mountShell()
    fireEvent.click(view.getByRole('button', { name: '切换深色主题' }))
    fireEvent.click(view.getByRole('button', { name: '切换浅色主题' }))
    expect(view.getByRole('button', { name: '跟随系统配色' })).toBeTruthy()
    act(() => { view.publishTheme('custom', 'dark') })
    fireEvent.click(view.getByRole('button', { name: '切换浅色主题' }))
    expect(view.getTheme().preference).toBe('light')
    expect(view.getByRole('button', { name: '切换深色主题' })).toBeTruthy()
  })

  it('内层窄屏展开时，外层导航入口不随内层侧栏变化', () => {
    const view = mountShell()
    const width = view.instance.getSnapshot().sidebar
    act(() => { view.instance.actions.setNarrow(true) })
    act(() => { view.instance.actions.toggleSidebar() })
    expect(view.getByRole('navigation').querySelectorAll('button')).toHaveLength(5)
    expect(view.instance.getSnapshot().sidebar).toBe(width)
    act(() => { view.instance.actions.toggleSidebar() })
    expect(view.instance.getSnapshot().narrowExpanded).toBe(false)
  })

  it('窗口开关在三个页面使用同一侧栏状态，窄屏只临时展开', () => {
    const view = mountShell()
    const collapse = view.getByRole('button', { name: '收起侧边栏' })
    expect(collapse.closest('[data-window-shell]')).toBeTruthy()
    const expandedIcon = collapse.querySelector('svg path')?.getAttribute('d')
    fireEvent.click(collapse)
    const collapsedIcon = view.getByRole('button', { name: '展开侧边栏' }).querySelector('svg path')?.getAttribute('d')
    expect(collapsedIcon).not.toBe(expandedIcon)
    expect(view.instance.getSnapshot().sidebar).toBe(0)
    act(() => { view.instance.actions.openPage('files', 'shell-session' as SessionId) })
    fireEvent.click(view.getByRole('button', { name: '展开侧边栏' }))
    expect(view.instance.getSnapshot().sidebar).toBe(280)
    act(() => { view.instance.actions.openPage('image-gallery', 'shell-session' as SessionId) })
    expect(view.getByRole('button', { name: '收起侧边栏' })).toBeTruthy()
    act(() => { view.instance.actions.setNarrow(true) })
    expect(view.getByRole('button', { name: '展开侧边栏' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '展开侧边栏' }))
    expect(view.instance.getSnapshot()).toMatchObject({ sidebar: 280, narrowExpanded: true })
    expect(view.getByRole('button', { name: '收起侧边栏' })).toBeTruthy()
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

  it('跨会话画图后通过主页归还原对话而不是画图会话', () => {
    const view = mountShell('image-session' as SessionId)
    act(() => {
      view.instance.actions.openPage('image-gallery', 'image-session' as SessionId, 'working-session' as SessionId)
    })
    fireEvent.click(view.getByRole('button', { name: '回到对话' }))
    expect(view.instance.getSnapshot().page).toBeNull()
    expect(view.instance.getSnapshot().conversationReturn).toMatchObject({
      from: 'image-session', sessionId: 'working-session',
    })
    expect(view.instance.getSnapshot().conversationRequest).toBeNull()
  })

  it('无会话时也能返回欢迎页，不发出无目标的对话请求', () => {
    const view = mountShell(null)
    fireEvent.click(view.getByRole('button', { name: '回到对话' }))
    expect(view.instance.getSnapshot().conversationRequest).toBeNull()
  })
})
