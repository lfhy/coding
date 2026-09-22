// @vitest-environment jsdom
// 客户端接线测试覆盖 root 的单次注册、服务生命周期和主题呈现器。

import { Context } from '@deepseek-ai/cordis'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply as themeApply, inject as themeInject, ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject, LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { AppFrameInjected } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import type { PanelActions } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-layout'
import * as invariant from '@deepseek-ai/dsh-client-ui-layout/invariant'

beforeEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((node) => { node.remove() })
})

async function bench() {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotRegistry)
  // 主题设置需要连接与设置 scope；这里提供内存态浏览器依赖。
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  // Appearance 设置行通过这两个依赖绑定持久 scope。
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: themeInject, apply: themeApply }).await()
  await slotsFiber.await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

describe('ui-layout client apply', () => {
  it('declares its service dependencies', () => {
    expect(inject).toEqual(['slots', 'theme'])
  })

  it('provides ctx.layout and declares legacy plus workbench child slots', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.get('layout')).toBeInstanceOf(LayoutController)
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('conversation')).toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(slots.spec('details')).toEqual({ kind: 'single', scope: 'session' })
    expect(slots.spec('workbench')).toEqual({ kind: 'single', scope: 'session' })
    expect(slots.spec('workbench.bottom')).toEqual({ kind: 'single', scope: 'session' })
    expect(slots.spec('shell.overlay')).toEqual({ kind: 'list', scope: 'root' })
  })

  it('injects the AppFrame projection callbacks and attaches the layout actions', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const actions = {
      setSidebar: vi.fn(), setDetails: vi.fn(), setWorkbench: vi.fn(), setWorkbenchBottom: vi.fn(),
      toggleSidebar: vi.fn(), setNarrow: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn(),
      openWorkbench: vi.fn(), closeWorkbench: vi.fn(), toggleWorkbench: vi.fn(),
      toggleWorkbenchFullscreen: vi.fn(), toggleWorkbenchBottom: vi.fn(),
      toggleWorkbenchFiles: vi.fn(),
      retainWorkbenchSessions: vi.fn(),
    } satisfies PanelActions
    const injected = (slots.entries('root')[0]!.inject as unknown as (
      actions: PanelActions,
    ) => AppFrameInjected)(actions)
    expect(typeof injected.publishWorkbench).toBe('function')
    expect(typeof injected.retainWorkbenchViews).toBe('function')
    const layout = ctx.get('layout') as LayoutController
    layout.toggleSidebar()
    layout.openWorkbench('layout-session' as SessionId)
    expect(actions.toggleSidebar).toHaveBeenCalledOnce()
    expect(actions.openWorkbench).toHaveBeenCalledOnce()
  })

  it('theme presenter applies the initial snapshot, follows theme/change, and unwinds on dispose', async () => {
    const { ctx } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // jsdom 没有 matchMedia，system 初始解析为 light。
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    const themeColorMeta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    expect(themeColorMeta).not.toBeNull()
    const theme = ctx.get('theme') as ThemeRuntime
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(document.head.querySelector('meta[name="theme-color"]')).toBe(themeColorMeta)
    await fiber.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    expect(themeColorMeta?.isConnected).toBe(false)
    // 监听器已卸载，后续主题变化不会再写入 document。
    theme.setTheme('light')
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
  })

  it('teardown unwinds the service, the root registration, and the child declarations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(ctx.get('layout')).toBeUndefined()
    expect(slots.entries('root')).toHaveLength(0)
    expect(slots.spec('sidebar')).toBeUndefined()
    expect(slots.spec('workbench')).toBeUndefined()
    expect(slots.spec('workbench.bottom')).toBeUndefined()
    // runtime 自己声明的 root 在 entry 卸载后仍然存在。
    expect(slots.spec('root')).toEqual({ kind: 'single', scope: 'root' })
  })
})

describe('node half + invariant companion', () => {
  it('node apply is an intentional no-op (loader-managed lifecycle only)', () => {
    nodeApply()
    expect(true).toBe(true) // 不抛错就是 host 空实现的约定。
  })

  it('invariant companion registers under the package name', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const ctx = { invariants: { register } } as never
    // /invariant 类型位于构建产物；这里收窄 API，避免 lint 依赖预构建。
    const dispose = await (invariant as { apply: (ctx: never) => Promise<() => void> }).apply(ctx)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-client-ui-layout', expect.any(Function))
    // 声明的空 installer 必须可安全调用。
    expect(() => { (register.mock.calls[0]![1] as (c: never) => void)(undefined as never) }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})
