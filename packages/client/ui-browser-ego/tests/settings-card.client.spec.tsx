// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from 'coding-client-runtime/client'
import { LocaleRuntime } from 'coding-client-locale/client'
import { stubSettingsScope } from 'coding-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { EgoBrowserCard, type EgoBrowserCardProps } from '../src/client/settings-card.tsx'
import type { EgoBrowserCardFace, EgoBrowserCardState } from '../src/client/settings-card-controller.ts'
import { EGO_SETTINGS_NS, type EgoBrowserSettings } from '../src/client/settings.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const t = (key: keyof typeof en, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/gu, (match, name: string) => (name in (params ?? {}) ? String(params?.[name]) : match))

/**
 * 挂载本包插件并声明设置页的插件槽位。
 * @returns 设置卡槽位条目、假设置作用域与清理句柄。
 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const settings = stubSettingsScope<EgoBrowserSettings>()
  ctx.provide('settingsScope', { bind: () => settings.scope } as never)
  ctx.provide('sidebarRightTabs', { register: vi.fn(() => vi.fn()) })
  ctx.provide('sidebarRight', { openTabForSession: vi.fn() })
  ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: {} }) } })
  vi.stubGlobal('EventSource', class extends EventTarget {})
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const root = ctx.slots.register({
    name: 'root',
    children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } },
  } as never, () => null)
  const entry = ctx.slots.entries('settings.plugin.item')[0]
  if (entry === undefined) throw new Error('settings card not registered')
  const face = (entry.inject as unknown as () => EgoBrowserCardFace)()
  return { ctx, settings, entry, face, root, fiber }
}

/** 让表单保存链上的多段微任务全部结束。 */
async function flush(): Promise<void> {
  for (let hop = 0; hop < 8; hop += 1) await Promise.resolve()
}

/** 模拟 Host 接受一次写入：镜像作用域同时更新用户层与有效值。 */
function acceptWrites(handle: Awaited<ReturnType<typeof bench>>['settings']): void {
  handle.set.mockImplementation(((field: string, value: unknown) => {
    const snapshot = handle.scope.getSnapshot()
    handle.publish({
      user: { ...(snapshot.user ?? {}), [field]: value },
      value: { ...(snapshot.value ?? {}), [field]: value },
    })
    return Promise.resolve()
  }) as never)
  handle.unset.mockImplementation(((field: string) => {
    const snapshot = handle.scope.getSnapshot()
    const user = Object.fromEntries(Object.entries(snapshot.user ?? {}).filter(([key]) => key !== field))
    const value = Object.fromEntries(Object.entries(snapshot.value ?? {}).filter(([key]) => key !== field))
    handle.publish({ user, value })
    return Promise.resolve()
  }) as never)
}

/** 用给定卡片状态渲染带词典的卡片组件。 */
function mountCard(state: EgoBrowserCardState) {
  const edit = vi.fn()
  const resetField = vi.fn()
  const save = vi.fn()
  const discard = vi.fn()
  const props = { t, useEgoBrowserCard: (choose: (snapshot: EgoBrowserCardState) => unknown) => choose(state),
    edit, resetField, save, discard } as unknown as EgoBrowserCardProps
  return { ...render(<EgoBrowserCard {...props} />), edit, resetField, save, discard }
}

describe('Agent 浏览器设置卡', () => {
  it('按 ego-browser 命名空间注册为设置页的一项，并注入一张卡快照', async () => {
    const { entry, face } = await bench()
    expect(entry.options.key).toBe(EGO_SETTINGS_NS)
    expect(entry.component).toBe(EgoBrowserCard)
    expect(Object.keys(face.hooks)).toEqual(['egoBrowserCard'])
    expect(face.hooks.egoBrowserCard.getSnapshot().available).toBe(false)
  })

  it('读取 Host 的有效值，保存时只写入用户改动的字段', async () => {
    const { settings, face } = await bench()
    acceptWrites(settings)
    act(() => {
      settings.publish({
        status: 'ready', writable: true, base: {}, user: {},
        value: { captureBackend: 'cdp', cdpFps: 8, disableFrameRelay: false },
      })
    })
    let state = face.hooks.egoBrowserCard.getSnapshot()
    expect(state.available).toBe(true)
    expect(state.fields.captureBackend.text).toBe('cdp')
    expect(state.fields.cdpFps.text).toBe('8')
    expect(state.fields.cdpFps.overridden).toBe(false)
    expect(state.dirty).toBe(false)

    act(() => { face.edit('cdpFps', '12') })
    state = face.hooks.egoBrowserCard.getSnapshot()
    expect(state.dirty).toBe(true)
    expect(state.fields.cdpFps.overridden).toBe(true)

    await act(async () => { face.save(); await flush() })
    expect(settings.set).toHaveBeenCalledTimes(1)
    expect(settings.set).toHaveBeenCalledWith('cdpFps', 12)
    state = face.hooks.egoBrowserCard.getSnapshot()
    expect(state.dirty).toBe(false)
    expect(state.failed).toBe(false)
    expect(state.fields.cdpFps.text).toBe('12')
  })

  it('越界或非数字草稿阻止保存，保留草稿供修正', async () => {
    const { settings, face } = await bench()
    acceptWrites(settings)
    act(() => {
      settings.publish({ status: 'ready', writable: true, base: {}, user: {}, value: { cdpFps: 8 } })
    })
    act(() => { face.edit('cdpFps', '99') })
    const state = face.hooks.egoBrowserCard.getSnapshot()
    expect(state.invalid).toBe(true)
    expect(state.dirty).toBe(true)
    await act(async () => { face.save(); await flush() })
    expect(settings.set).not.toHaveBeenCalled()
    expect(face.hooks.egoBrowserCard.getSnapshot().fields.cdpFps.invalid).toBe(true)
  })

  it('恢复默认清空用户层，落盘后草稿与覆盖标记一起消失', async () => {
    const { settings, face } = await bench()
    acceptWrites(settings)
    act(() => {
      settings.publish({ status: 'ready', writable: true, base: {}, user: { cdpQuality: 70 }, value: { cdpQuality: 70 } })
    })
    expect(face.hooks.egoBrowserCard.getSnapshot().fields.cdpQuality.overridden).toBe(true)
    act(() => { face.resetField('cdpQuality') })
    await act(async () => { face.save(); await flush() })
    expect(settings.unset).toHaveBeenCalledWith('cdpQuality')
    const state = face.hooks.egoBrowserCard.getSnapshot()
    expect(state.fields.cdpQuality.overridden).toBe(false)
    expect(state.dirty).toBe(false)
  })

  it('只读部署只说明状态并禁用全部控件与保存', async () => {
    const { settings, face } = await bench()
    act(() => {
      settings.publish({ status: 'ready', writable: false, base: {}, user: {}, value: { captureBackend: 'auto' } })
    })
    const state = face.hooks.egoBrowserCard.getSnapshot()
    expect(state.writable).toBe(false)
    const card = mountCard(state)
    fireEvent.click(screen.getByRole('button', { name: 'Show settings: Agent Browser' }))
    expect(screen.getByText('This deployment stores settings as read-only.')).toBeTruthy()
    expect(screen.getByLabelText('Capture method')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
    expect(screen.queryByText(/ego-browser|api\/|JSON/u)).toBeNull()
    card.unmount()
  })

  it('选择视频后端时提示 ffmpeg 依赖，字段标签不写死本机路径', async () => {
    const { settings, face } = await bench()
    act(() => {
      settings.publish({
        status: 'ready', writable: true, base: {}, user: {},
        value: { captureBackend: 'ffmpeg', ffmpegPath: '', chromePath: '' },
      })
    })
    const card = mountCard(face.hooks.egoBrowserCard.getSnapshot())
    fireEvent.click(screen.getByRole('button', { name: 'Show settings: Agent Browser' }))
    expect(screen.getByLabelText('Capture method')).toHaveProperty('value', 'ffmpeg')
    expect(screen.getByRole('note').textContent).toContain('needs ffmpeg')
    expect(screen.getByLabelText('Browser executable path')).toBeTruthy()
    expect(screen.getByLabelText('Video tool path')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\/Users\/|\/usr\/|C:\\\\/u)
    card.unmount()
  })

  it('未服务该命名空间时不渲染任何内容', async () => {
    const { settings, face } = await bench()
    act(() => { settings.publish({ status: 'unavailable', writable: false }) })
    const card = mountCard(face.hooks.egoBrowserCard.getSnapshot())
    expect(card.container.textContent).toBe('')
    card.unmount()
  })
})
