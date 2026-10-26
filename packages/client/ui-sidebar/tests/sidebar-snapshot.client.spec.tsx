// @vitest-environment jsdom
/**
 * 侧边栏壳层走真实装配路径的本地 DOM 快照：SlotTestRuntime 在自己的 fiber 上挂载本包
 * apply，auto frame 在渲染点提供布局的 owner share，快照只捕获 'sidebar' slot 的输出
 * （CSS Module 类名由运行时序列化器折叠为语义局部名）。子洞（sidebar.workspaces 与
 * sidebar.settings）在这里没有注册者，因此快照固定的是壳层自身的镶边。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { SlotTestRuntime } from 'coding-client-test-runtime'
import { LocaleRuntime } from 'coding-client-locale/client'
import { apply, inject } from 'coding-client-ui-sidebar/client'

afterEach(() => {
  cleanup()
})

/**
 * 通过 slot 测试运行时启动该包：默认 bench 验证未设置偏好时显示中文；
 * `locale: 'en'` 显式选择英文。两种情况均通过同一个 locale face 提供翻译。
 */
async function bench(options: { locale?: 'en' } = {}) {
  const runtime = await SlotTestRuntime.create()
  runtime.provide('layout', { toggleSidebar: vi.fn() })
  const locale = new LocaleRuntime(runtime.ctx)
  if (options.locale === 'en') locale.setLocale('en')
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({ 'sidebar': { kind: 'single', scope: 'root' } })
  await runtime.mount({ inject: [...inject], apply })
  return { runtime, locale }
}

describe('sidebar shell snapshots', () => {
  it('renders only the New chat entry in the welcome header', async () => {
    const { runtime } = await bench({ locale: 'en' })
    const slot = runtime.renderSlot('sidebar', { collapsed: false, width: 300, welcomeActionsVisible: true })
    // 宽侧栏的收起按钮改由浏览区域标题行渲染，壳层自己不带开关。
    expect(slot.view.getByRole('button', { name: 'New chat' })).toBeTruthy()
    expect(slot.view.queryByRole('button', { name: 'Collapse sidebar' })).toBeNull()
    expect(slot.container).toMatchSnapshot()
    await runtime.dispose()
  })

  it('renders the expanded column in the default locale (zh, no setLocale)', async () => {
    const { runtime } = await bench()
    const slot = runtime.renderSlot('sidebar', { collapsed: false, width: 300, welcomeActionsVisible: false })
    // 展开状态下新对话行只剩一个入口。
    expect(slot.view.getAllByRole('button', { name: '新建对话' })).toHaveLength(1)
    expect(slot.container).toMatchSnapshot()
    await runtime.dispose()
  })

  it('renders the expanded column (New chat capsule, empty holes)', async () => {
    const { runtime } = await bench({ locale: 'en' })
    const slot = runtime.renderSlot('sidebar', { collapsed: false, width: 300, welcomeActionsVisible: false })
    expect(slot.view.getAllByRole('button', { name: 'New chat' })).toHaveLength(1)
    expect(slot.container).toMatchSnapshot()
    await runtime.dispose()
  })

  it('renders the collapsed rail after the crossfade settles, in place', async () => {
    const { runtime } = await bench({ locale: 'en' })
    const slot = runtime.renderSlot('sidebar', { collapsed: false, width: 300, welcomeActionsVisible: false })
    const shell = slot.container.firstElementChild
    slot.update({ collapsed: true, width: 56, welcomeActionsVisible: false })
    // 顶部避让行在 150ms 落定后换成 rail，收起按钮变成 rail 里的展开按钮。
    await waitFor(() => {
      expect(slot.view.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
    })
    expect(slot.container).toMatchSnapshot()
    // Same tree position: the owner flip re-rendered the shell in place.
    expect(slot.container.firstElementChild).toBe(shell)
    await runtime.dispose()
  })

  it('a locale switch refreshes mounted copy without re-registration', async () => {
    const { runtime, locale } = await bench()
    const slot = runtime.renderSlot('sidebar', { collapsed: false, width: 300, welcomeActionsVisible: false })
    expect(slot.view.getAllByRole('button', { name: '新建对话' })).toHaveLength(1)
    // 同一 fiber、同一注册：只切 locale 就足以重渲染 outlet。
    act(() => { locale.setLocale('en') })
    expect(slot.view.getAllByRole('button', { name: 'New chat' })).toHaveLength(1)
    expect(slot.view.queryByRole('button', { name: '新建对话' })).toBeNull()
    await runtime.dispose()
  })
})
