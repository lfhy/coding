// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputerUseSection, type ComputerUseSectionProps } from '../src/client/ComputerUseSection.tsx'
import {
  DEFAULT_SETTINGS, type ComputerUseAccess, type ComputerUseAccessView, type ComputerUseSettings,
  type ComputerUseSettingsView,
} from '../src/client/settings.ts'
import { zh } from '../src/client/locales.ts'

const t = (key: keyof typeof zh, params?: Record<string, unknown>) =>
  (zh[key] as string).replace(/\{(\w+)\}/gu, (match, name: string) =>
    (params !== undefined && name in params ? String(params[name]) : match))

/** 按应用授权列表：与页面顶部的权限结论列表区分开。 */
const grantRows = () => within(screen.getByRole('list', { name: '按应用授权' })).getAllByRole('listitem')
afterEach(() => { cleanup() })

const stored: ComputerUseSettings = {
  ...DEFAULT_SETTINGS,
  grants: [{ bundleId: 'com.apple.Notes', read: true, control: false }],
}

/**
 * 渲染分区：视图快照与保存动作直接注入，不经过渲染器。
 * @param view - 分节快照与保存状态。
 * @param save - 保存动作替身。
 * @returns 渲染结果。
 */
function renderSection(
  view: ComputerUseSettingsView,
  save = vi.fn(async () => true),
  access: ComputerUseAccessView = { status: 'ready', checking: false, value: grantedAccess },
) {
  const check = vi.fn(async () => {})
  const openPermissionSettings = vi.fn(async () => true)
  const requestPermission = vi.fn(async () => true)
  const props = {
    close: () => {},
    t,
    save,
    check,
    openPermissionSettings,
    requestPermission,
    useComputerUseSettings: (pick: (value: ComputerUseSettingsView) => unknown) => pick(view),
    useComputerUseAccess: (pick: (value: ComputerUseAccessView) => unknown) => pick(access),
  } as unknown as ComputerUseSectionProps
  return { save, check, openPermissionSettings, requestPermission, ...render(<ComputerUseSection {...props} />) }
}

/** 一份已授权的结论：辅助功能给了、屏幕录制没给。 */
const grantedAccess: ComputerUseAccess = {
  enabled: true, platform: 'darwin', provider: 'macos-ax', ready: true, helperVersion: '1.2.3',
  accessibility: 'granted', screenRecording: 'denied',
}

/** 一份可用的已保存分节。 */
function ready(value: ComputerUseSettings = stored, override: Partial<ComputerUseSettingsView> = {}) {
  return {
    section: { status: 'ready' as const, writable: true, value, base: value, user: {}, revision: 1, mode: 'host' as const },
    saving: false,
    failed: false,
    ...override,
  }
}

describe('电脑操作设置分区', () => {
  it('读取中与不可用时只给状态文案', () => {
    renderSection({ section: { status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' }, saving: false, failed: false })
    expect(screen.getByText('正在读取设置…')).toBeTruthy()
    cleanup()
    renderSection({ section: { status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'memory' }, saving: false, failed: false })
    expect(screen.getByText(/只在本地 macOS 宿主上可用/)).toBeTruthy()
  })

  it('状态带反映开关，关掉后保存 enabled: false', () => {
    const { save } = renderSection(ready())
    expect(screen.getByText('已启用')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('允许 Agent 操作本机应用'))
    expect(screen.getByText('已关闭')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).toHaveBeenCalledWith({ enabled: false })
  })

  it('切到外部驱动时收起光标项，并保存驱动路径', () => {
    const { save } = renderSection(ready())
    const cursor = screen.getByLabelText('显示操作光标')
    expect(cursor).toHaveProperty('checked', true)
    fireEvent.click(screen.getByRole('radio', { name: /外部驱动/ }))
    expect(screen.getByRole('radio', { name: /外部驱动/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('显示操作光标')).toHaveProperty('checked', false)
    expect(screen.getByLabelText('显示操作光标').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/外部驱动不提供操作光标/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('驱动路径'), { target: { value: '/opt/cua-driver' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).toHaveBeenCalledWith({
      provider: 'cua-driver',
      interaction: { ...stored.interaction, cursorVisualization: 'hidden' },
      cuaDriver: { bin: '/opt/cua-driver', session: 'dsh-computer-use' },
    })
  })

  it('新增、调整与移除按应用授权，重复或非法标识不可添加', () => {
    const { save } = renderSection(ready())
    const add = screen.getByRole('button', { name: '添加应用' })
    expect(add).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('应用标识'), { target: { value: 'com.apple.Notes' } })
    expect(add).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('应用标识'), { target: { value: 'com.apple.Safari' } })
    expect(add).toHaveProperty('disabled', false)
    fireEvent.click(add)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).toHaveBeenCalledWith({ grants: [
      { bundleId: 'com.apple.Notes', read: true, control: false },
      { bundleId: 'com.apple.Safari', read: true, control: false },
    ] })
  })

  it('控制包含读取，读取在已控制时不可单独关闭', () => {
    const { save } = renderSection(ready({ ...stored, grants: [{ bundleId: 'com.apple.Notes', read: false, control: false }] }))
    const row = grantRows()[0] as HTMLElement
    fireEvent.click(within(row).getByLabelText('控制'))
    expect(within(row).getByLabelText('读取')).toHaveProperty('checked', true)
    expect(within(row).getByLabelText('读取').hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(row).getByLabelText('控制'))
    expect(within(row).getByLabelText('读取')).toHaveProperty('checked', true)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).toHaveBeenLastCalledWith({ grants: [{ bundleId: 'com.apple.Notes', read: true, control: false }] })
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(screen.getByText('还没有按应用授权；下面的应用会在第一次操作时逐个询问。')).toBeTruthy()
  })

  it('交互策略逐项切换，允许所有应用单独落盘', () => {
    const { save } = renderSection(ready())
    fireEvent.click(screen.getByLabelText('点击前把目标应用带到前台'))
    fireEvent.click(screen.getByLabelText('键盘输入前把目标应用带到前台'))
    fireEvent.click(screen.getByLabelText('关闭坐标输入'))
    fireEvent.click(screen.getByLabelText('允许所有运行中的应用'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).toHaveBeenCalledWith({
      interaction: {
        focusPolicy: 'activate',
        keyboardPolicy: 'activate',
        pointerInputPolicy: 'deny',
        cursorVisualization: 'visible',
      },
      allowAllApps: true,
    })
  })

  it('数值与截图目录不合法时拒绝保存并给出原因', () => {
    const { save } = renderSection(ready())
    fireEvent.change(screen.getByLabelText('观察有效期（秒）'), { target: { value: 'abc' } })
    expect(screen.getByText(/1 至 86400 的整数秒/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('观察有效期（秒）'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('确认有效期（秒）'), { target: { value: '901' } })
    expect(screen.getByText(/1 至 900 的整数秒/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('确认有效期（秒）'), { target: { value: '600' } })
    fireEvent.change(screen.getByLabelText('单次动作超时（毫秒）'), { target: { value: '999' } })
    expect(screen.getByText(/1000 至 120000 的整数毫秒/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('单次动作超时（毫秒）'), { target: { value: '30000' } })
    fireEvent.change(screen.getByLabelText('截图目录'), { target: { value: '../out' } })
    expect(screen.getByText(/会话工作区内的相对路径/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('截图目录'), { target: { value: 'shots' } })
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).toHaveBeenCalledWith({ confirmationTtlMs: 600_000, actionTimeoutMs: 30_000, artifactRoot: 'shots' })
  })

  it('已存授权里出现重复或非法标识时提示并阻止保存', () => {
    const save = vi.fn(async () => true)
    renderSection(ready({ ...stored, grants: [
      { bundleId: 'com.apple.Notes', read: true, control: false },
      { bundleId: 'com.apple.Notes', read: true, control: false },
    ] }), save)
    expect(screen.getByText('请填写精确的应用标识，不能包含空格、通配符或重复项。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)
  })

  it('多行授权只改选中的一行', () => {
    const { save } = renderSection(ready({ ...stored, grants: [
      { bundleId: 'com.apple.Notes', read: true, control: false },
      { bundleId: 'com.apple.Safari', read: true, control: false },
    ] }))
    const rows = grantRows()
    fireEvent.click(within(rows[1] as HTMLElement).getByLabelText('读取'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).toHaveBeenCalledWith({ grants: [
      { bundleId: 'com.apple.Notes', read: true, control: false },
      { bundleId: 'com.apple.Safari', read: false, control: false },
    ] })
  })

  it('交互策略可以从开启回到默认，读取开关可单独关闭', () => {
    const { save } = renderSection(ready())
    fireEvent.click(screen.getByLabelText('点击前把目标应用带到前台'))
    fireEvent.click(screen.getByLabelText('点击前把目标应用带到前台'))
    fireEvent.click(screen.getByLabelText('键盘输入前把目标应用带到前台'))
    fireEvent.click(screen.getByLabelText('键盘输入前把目标应用带到前台'))
    fireEvent.click(screen.getByLabelText('关闭坐标输入'))
    fireEvent.click(screen.getByLabelText('关闭坐标输入'))
    fireEvent.click(screen.getByLabelText('显示操作光标'))
    fireEvent.click(screen.getByLabelText('显示操作光标'))
    const row = grantRows()[0] as HTMLElement
    fireEvent.click(within(row).getByLabelText('读取'))
    expect(within(row).getByLabelText('读取')).toHaveProperty('checked', false)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).toHaveBeenCalledWith({ grants: [{ bundleId: 'com.apple.Notes', read: false, control: false }] })
  })

  it('切回内置后端时保留光标设置，驱动路径随草稿清空', () => {
    const { save } = renderSection(ready())
    fireEvent.click(screen.getByRole('radio', { name: /外部驱动/ }))
    fireEvent.change(screen.getByLabelText('驱动路径'), { target: { value: '/opt/cua' } })
    fireEvent.click(screen.getByRole('radio', { name: /内置辅助功能/ }))
    expect(screen.queryByLabelText('驱动路径')).toBeNull()
    // 切回内置后端不会擅自恢复光标，用户可再次打开。
    expect(screen.getByLabelText('显示操作光标')).toHaveProperty('checked', false)
    fireEvent.click(screen.getByLabelText('显示操作光标'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    // 回到原值后没有可写字段：不发起保存，草稿直接清空。
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '放弃修改' })).toHaveProperty('disabled', true)
  })

  it('放弃修改回到已存值，改动回去后保存不写入任何字段', () => {
    const { save } = renderSection(ready())
    fireEvent.click(screen.getByLabelText('允许 Agent 操作本机应用'))
    fireEvent.click(screen.getByLabelText('允许 Agent 操作本机应用'))
    expect(screen.getByRole('button', { name: '放弃修改' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '放弃修改' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByLabelText('允许 Agent 操作本机应用'))
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))
    expect(screen.getByLabelText('允许 Agent 操作本机应用')).toHaveProperty('checked', true)
  })

  it('保存成功后清空草稿，失败或只读时分别提示', async () => {
    const save = vi.fn(async () => true)
    const failed = renderSection(ready(), save)
    fireEvent.click(screen.getByLabelText('允许 Agent 操作本机应用'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '放弃修改' })).toHaveProperty('disabled', true) })
    failed.unmount()
    renderSection(ready(), vi.fn(async () => false))
    fireEvent.click(screen.getByLabelText('允许 Agent 操作本机应用'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    cleanup()
    renderSection(ready(stored, { failed: true, saving: true }))
    expect(screen.getByText(/未能完成保存/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存中…' })).toHaveProperty('disabled', true)
    cleanup()
    renderSection({ ...ready(), section: { ...ready().section, writable: false } })
    expect(screen.getByText('本部署的设置为只读。')).toBeTruthy()
    expect(screen.getByLabelText('允许 Agent 操作本机应用').hasAttribute('disabled')).toBe(true)
  })

  it('列出辅助功能、屏幕录制与本机组件状态，并转发两个面板入口', () => {
    const { check, openPermissionSettings } = renderSection(ready())
    expect(screen.getByText('已授权')).toBeTruthy()
    expect(screen.getByText('未授权')).toBeTruthy()
    expect(screen.getByText('就绪（1.2.3）')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
    expect(check).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '打开辅助功能设置' }))
    fireEvent.click(screen.getByRole('button', { name: '打开屏幕录制设置' }))
    expect(openPermissionSettings.mock.calls).toEqual([['accessibility'], ['screen-recording']])
  })

  it('未授权的权限行给出申请入口，已授权的不出现按钮', () => {
    const { requestPermission } = renderSection(ready())
    const rows = within(screen.getByRole('list', { name: '授权与运行状态' })).getAllByRole('listitem')
    // 辅助功能已授权：没有申请按钮；屏幕录制未授权：有。
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: '申请权限' })).toBeNull()
    const request = within(rows[1] as HTMLElement).getByRole('button', { name: '申请权限' })
    fireEvent.click(request)
    expect(requestPermission).toHaveBeenCalledWith('screen-recording')
    expect(screen.getByText(/打开对应的系统设置页/)).toBeTruthy()
  })

  it('申请失败时提示改用打开设置', async () => {
    const { requestPermission } = renderSection(ready())
    requestPermission.mockResolvedValueOnce(false)
    const rows = within(screen.getByRole('list', { name: '授权与运行状态' })).getAllByRole('listitem')
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: '申请权限' }))
    await waitFor(() => { expect(screen.getByText(/请改用「打开设置」手动授权/)).toBeTruthy() })
  })

  it('检查中禁用入口，读取失败与最近错误各自成段', () => {
    const { helperVersion: _dropped, ...grantedWithoutVersion } = grantedAccess
    renderSection(ready(), undefined, { status: 'ready', checking: true, value: {
      ...grantedWithoutVersion, ready: false, accessibility: 'not-determined',
      screenRecording: 'unavailable', lastError: '本机组件尚未构建',
    } })
    expect(screen.getByRole('button', { name: '检查中…' })).toHaveProperty('disabled', true)
    expect(screen.getByText('未决定')).toBeTruthy()
    expect(screen.getByText('无法读取')).toBeTruthy()
    expect(screen.getByText('未就绪，第一次调用时才启动')).toBeTruthy()
    expect(screen.getByText(/本机组件尚未构建/)).toBeTruthy()
    cleanup()
    renderSection(ready(), undefined, { status: 'loading', checking: false })
    expect(screen.getByText('正在读取状态…')).toBeTruthy()
    cleanup()
    renderSection(ready(), undefined, { status: 'error', checking: false })
    expect(screen.getByText('无法读取状态，请重试。')).toBeTruthy()
  })

  it('组件就绪但没有版本号时给出占位而不是空白', () => {
    const { helperVersion: _unused, ...withoutVersion } = grantedAccess
    renderSection(ready(), undefined, { status: 'ready', checking: false, value: withoutVersion })
    expect(screen.getByText('就绪（—）')).toBeTruthy()
  })

  it('打不开系统设置时提示手动前往', async () => {
    const { openPermissionSettings } = renderSection(ready(), undefined, {
      status: 'ready', checking: false, value: grantedAccess,
    })
    openPermissionSettings.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: '打开辅助功能设置' }))
    // 打开设置失败与申请失败共用同一行提示：都要求用户手动前往系统设置。
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('手动授权') })
  })
})
