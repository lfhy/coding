import { describe, expect, it } from 'vitest'
import { stubSettingsScope } from 'coding-client-test-runtime'
import {
  ComputerUseSettingsController, DEFAULT_SETTINGS, collectChanges, decodeComputerUseSettings, decodeGrant,
  numberText, numberValue, numericTextOf, validArtifactRoot, validBundleId, validGrants, validNumeric,
  type ComputerUseAccess, type ComputerUseRemote, type ComputerUseSettings,
} from '../src/client/settings.ts'

/** 远端替身：默认返回一份已授权的结论。 */
function remoteStub(overrides: Partial<ComputerUseRemote> = {}): ComputerUseRemote & { calls: string[] } {
  const calls: string[] = []
  const access: ComputerUseAccess = {
    enabled: true, platform: 'darwin', provider: 'macos-ax', ready: true, helperVersion: '1.2.3',
    accessibility: 'granted', screenRecording: 'denied',
  }
  return {
    calls,
    status: async () => { calls.push('status'); return { ok: true as const, value: access } },
    check: async () => { calls.push('check'); return { ok: true as const, value: access } },
    openPermissionSettings: async (kind) => { calls.push(`open:${kind}`); return { ok: true as const, value: undefined } },
    requestPermission: async (kind) => { calls.push(`request:${kind}`); return { ok: true as const, value: access } },
    ...overrides,
  }
}

const stored: ComputerUseSettings = {
  ...DEFAULT_SETTINGS,
  enabled: true,
  grants: [{ bundleId: 'com.apple.Notes', read: true, control: false }],
}

/** 让保存测试的替身发布 Host 确认后的用户层；失败测试可保留旧快照。 */
function writingScope() {
  const scope = stubSettingsScope<ComputerUseSettings>()
  scope.set.mockImplementation((field: string, value: unknown) => {
    const current = scope.scope.getSnapshot()
    scope.publish({ user: { ...current.user as object, [field]: value }, value: { ...stored, ...current.value, [field]: value } })
  })
  return scope
}

describe('电脑操作设置分节', () => {
  it('收窄 Host 分节并归一化授权', () => {
    expect(decodeComputerUseSettings(stored)).toEqual(stored)
    expect(decodeComputerUseSettings({ ...stored, helper: {}, cuaDriver: { session: 'x' } })).toEqual({
      ...stored, helper: {}, cuaDriver: { session: 'x' },
    })
    // 控制隐含读取：与宿主归一化保持一致。
    expect(decodeGrant({ bundleId: 'com.apple.Safari', control: true })).toEqual({
      bundleId: 'com.apple.Safari', read: true, control: true,
    })
    expect(decodeGrant({ bundleId: 'app', read: 'yes' })).toBeUndefined()
    expect(decodeGrant({ bundleId: 'app', control: 'yes' })).toBeUndefined()
    expect(decodeGrant({ bundleId: 'app' })).toEqual({ bundleId: 'app', read: false, control: false })
    expect(decodeGrant('app')).toBeUndefined()
  })

  it('坏形状整节拒收，镜像保留上一次值', () => {
    expect(decodeComputerUseSettings(undefined)).toBeUndefined()
    expect(decodeComputerUseSettings({ ...stored, enabled: 'yes' })).toBeUndefined()
    expect(decodeComputerUseSettings({ ...stored, provider: 'vm' })).toBeUndefined()
    expect(decodeComputerUseSettings({ ...stored, helper: undefined })).toBeUndefined()
    expect(decodeComputerUseSettings({ ...stored, cuaDriver: [] })).toBeUndefined()
    expect(decodeComputerUseSettings({ ...stored, interaction: null })).toBeUndefined()
    expect(decodeComputerUseSettings({ ...stored, grants: [{ bundleId: 1 }] })).toBeUndefined()
    expect(decodeComputerUseSettings({ ...stored, helper: { path: 3 } })).toBeUndefined()
    expect(decodeComputerUseSettings({ ...stored, cuaDriver: { bin: 3, session: 'x' } })).toBeUndefined()
    expect(decodeComputerUseSettings({ ...stored, helper: { allowSourceBuild: 'yes' } })).toBeUndefined()
    expect(decodeComputerUseSettings({ ...stored, observationTtlMs: '0' })).toBeUndefined()
    expect(decodeComputerUseSettings({ ...stored, actionTimeoutMs: '0' })).toBeUndefined()
    expect(decodeComputerUseSettings({ ...stored, grants: 'all' })).toBeUndefined()
    expect(decodeComputerUseSettings({ ...stored, cuaDriver: { session: 5 } })).toBeUndefined()
    // 可选字段缺省时整节仍成立，且不带空字符串的路径。
    expect(decodeComputerUseSettings({
      ...stored,
      helper: { path: '  ', allowSourceBuild: true },
      cuaDriver: { bin: '/opt/cua' },
    })).toEqual({
      ...stored,
      helper: { allowSourceBuild: true },
      cuaDriver: { bin: '/opt/cua' },
    })
    expect(decodeComputerUseSettings({ ...stored, helper: { path: ' /opt/helper ' } })?.helper)
      .toEqual({ path: '/opt/helper' })
    // 未知策略值回落到默认，而不是让整节失效。
    expect(decodeComputerUseSettings({ ...stored, interaction: { focusPolicy: 'raise', pointerInputPolicy: 'all' } })
      ?.interaction).toEqual({ focusPolicy: 'preserve', keyboardPolicy: 'preserve', pointerInputPolicy: 'targeted', cursorVisualization: 'visible' })
  })

  it('校验应用标识、授权列表、截图目录与数值范围', () => {
    expect(validBundleId('com.apple.Notes')).toBe(true)
    expect(validBundleId('  ')).toBe(false)
    expect(validBundleId('com.*')).toBe(false)
    expect(validBundleId('com.apple Notes')).toBe(false)
    expect(validBundleId('a'.repeat(256))).toBe(false)
    expect(validGrants([{ bundleId: 'a', read: true, control: false }])).toBe(true)
    expect(validGrants([{ bundleId: 'a', read: true, control: false }, { bundleId: 'a', read: false, control: false }])).toBe(false)
    expect(validGrants([{ bundleId: '', read: true, control: false }])).toBe(false)
    expect(validArtifactRoot('.dsh-computer-use/artifacts')).toBe(true)
    expect(validArtifactRoot('')).toBe(false)
    expect(validArtifactRoot('/tmp/shots')).toBe(false)
    expect(validArtifactRoot('shots/../secret')).toBe(false)
    expect(validNumeric('observationTtlMs', 0)).toBe(true)
    expect(validNumeric('observationTtlMs', 500)).toBe(false)
    expect(validNumeric('confirmationTtlMs', 0)).toBe(false)
    expect(validNumeric('confirmationTtlMs', 900_001)).toBe(false)
    expect(validNumeric('actionTimeoutMs', 1000)).toBe(true)
    expect(validNumeric('actionTimeoutMs', 999.5)).toBe(false)
  })

  it('在秒与毫秒之间换算，非法输入不产生数值', () => {
    expect(numberText('observationTtlMs', 90_000)).toBe('90')
    expect(numberText('actionTimeoutMs', 15_000)).toBe('15000')
    expect(numericTextOf(stored)).toEqual({ observationTtlMs: '0', confirmationTtlMs: '300', actionTimeoutMs: '15000' })
    expect(numberValue('confirmationTtlMs', '300')).toBe(300_000)
    expect(numberValue('confirmationTtlMs', '0')).toBeUndefined()
    expect(numberValue('actionTimeoutMs', '1e4')).toBeUndefined()
    expect(numberValue('observationTtlMs', ' 60 ')).toBe(60_000)
    expect(numberValue('observationTtlMs', '9999999')).toBeUndefined()
  })

  it('只收敛与已存值不同的字段，非法草稿不产生改动', () => {
    const numbers = numericTextOf(stored)
    expect(collectChanges(stored, stored, numbers)).toEqual({})
    expect(collectChanges(stored, { ...stored, enabled: false }, numbers)).toEqual({ enabled: false })
    expect(collectChanges(stored, { ...stored, provider: 'cua-driver', cuaDriver: { bin: '/bin/cua' } }, numbers))
      .toEqual({ provider: 'cua-driver', cuaDriver: { bin: '/bin/cua', session: 'dsh-computer-use' } })
    // 已存值与草稿都没有会话名时不下发空字段。
    const headless = { ...stored, provider: 'cua-driver' as const, cuaDriver: {} }
    expect(collectChanges(headless, { ...headless, cuaDriver: { bin: '/bin/cua' } }, numericTextOf(headless)))
      .toEqual({ cuaDriver: { bin: '/bin/cua' } })
    // 内置后端下驱动路径不写入，避免把未使用的后端配置带上线路。
    expect(collectChanges(stored, { ...stored, cuaDriver: { bin: '/bin/cua' } }, numbers)).toEqual({})
    expect(collectChanges(stored, {
      ...stored,
      interaction: { ...stored.interaction, focusPolicy: 'activate' },
      allowAllApps: true,
      artifactRoot: '  shots  ',
      observationTtlMs: 60_000,
    }, { ...numbers, observationTtlMs: '60' })).toEqual({
      interaction: { ...stored.interaction, focusPolicy: 'activate' },
      allowAllApps: true,
      artifactRoot: 'shots',
      observationTtlMs: 60_000,
    })
    expect(collectChanges(stored, { ...stored, grants: [] }, numbers)).toEqual({ grants: [] })
    expect(collectChanges(stored, { ...stored, artifactRoot: '../escape' }, numbers)).toBeUndefined()
    expect(collectChanges(stored, { ...stored, grants: [{ bundleId: '*', read: true, control: false }] }, numbers))
      .toBeUndefined()
    expect(collectChanges(stored, stored, { ...numbers, actionTimeoutMs: 'x' })).toBeUndefined()
  })
})

describe('电脑操作设置控制器', () => {
  it('读取期发布快照，保存按字段串行写入', async () => {
    const scope = writingScope()
    const controller = new ComputerUseSettingsController(scope.scope, remoteStub())
    expect(controller.view.getSnapshot().section.status).toBe('loading')
    scope.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    expect(controller.view.getSnapshot().section.value).toEqual(stored)

    expect(await controller.inject().save({ enabled: false, grants: [] })).toBe(true)
    expect(scope.set.mock.calls).toEqual([['enabled', false], ['grants', []]])
    // 草稿里显式 undefined 的字段不写入线路。
    expect(await controller.save({ enabled: undefined } as unknown as Partial<ComputerUseSettings>)).toBe(true)
    expect(scope.set).toHaveBeenCalledTimes(2)
    const options = controller.inject()
    expect(Object.keys(options.hooks).sort()).toEqual(['computerUseAccess', 'computerUseSettings'])
    expect(options.hooks.computerUseSettings.getSnapshot().section.value).toEqual({ ...stored, enabled: false, grants: [] })
    expect(controller.view.getSnapshot()).toMatchObject({ saving: false, failed: false })
    controller.dispose()
    expect(scope.listenerCount()).toBe(0)
  })

  it('不可写或写入失败时保留草稿并标记失败', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    const controller = new ComputerUseSettingsController(scope.scope, remoteStub())
    expect(await controller.save({ enabled: false })).toBe(false)
    scope.publish({ status: 'ready', writable: false, value: stored, base: stored, user: {}, revision: 1 })
    expect(await controller.save({ enabled: false })).toBe(false)
    scope.publish({ writable: true })
    scope.set.mockRejectedValueOnce(new Error('revision conflict'))
    expect(await controller.save({ enabled: false })).toBe(false)
    expect(controller.view.getSnapshot().failed).toBe(true)
    expect(scope.set).toHaveBeenCalledTimes(1)
    controller.dispose()
    expect(await controller.save({ enabled: false })).toBe(false)
    expect(scope.set).toHaveBeenCalledTimes(1)
    expect(controller.view.getSnapshot()).toMatchObject({ saving: false, failed: true })
  })

  it('并发保存以最新一次为准，被超越的一次不发布结果', async () => {
    const scope = writingScope()
    const controller = new ComputerUseSettingsController(scope.scope, remoteStub())
    scope.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    const first = controller.save({ enabled: false })
    const second = controller.save({ grants: [] })
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(scope.set.mock.calls).toEqual([['enabled', false], ['grants', []]])
    controller.dispose()
  })

  it('Host 恢复到旧文档时，不把未保存的开关当成已生效', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    const before = { ...stored, enabled: false }
    scope.publish({ status: 'ready', writable: true, value: before, user: { grants: stored.grants }, revision: 1 })
    const controller = new ComputerUseSettingsController(scope.scope, remoteStub())
    expect(await controller.save({ enabled: true, grants: [] })).toBe(false)
    expect(scope.set.mock.calls).toEqual([['enabled', true]])
    expect(controller.view.getSnapshot()).toMatchObject({ failed: true, saving: false, section: { value: before } })
    controller.dispose()
  })

  it('读取授权结论、执行显式检查并转发打开面板', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    scope.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    const remote = remoteStub()
    const controller = new ComputerUseSettingsController(scope.scope, remote)
    // 首次读取是构造函数发起的异步请求。
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.access.getSnapshot()).toMatchObject({
      status: 'ready',
      value: { accessibility: 'granted', screenRecording: 'denied', helperVersion: '1.2.3' },
    })
    await controller.check()
    expect(remote.calls).toEqual(['status', 'check'])
    expect(controller.access.getSnapshot()).toMatchObject({ checking: false, status: 'ready' })
    expect(await controller.openPermissionSettings('screen-recording')).toBe(true)
    expect(remote.calls.at(-1)).toBe('open:screen-recording')
    controller.dispose()
  })

  it('卸载后不发布晚到的状态，并发检查合并为一次', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    scope.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    let release: (() => void) | undefined
    const remote = remoteStub({
      status: async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return { ok: false as const, error: {} }
      },
    })
    const controller = new ComputerUseSettingsController(scope.scope, remote)
    controller.dispose()
    release?.()
    await Promise.resolve()
    await Promise.resolve()
    // 卸载后仍是首次读取状态，迟到的结果被丢弃。
    expect(controller.access.getSnapshot().status).toBe('loading')

    const scope2 = stubSettingsScope<ComputerUseSettings>()
    scope2.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    const slow = remoteStub()
    const controller2 = new ComputerUseSettingsController(scope2.scope, slow)
    await Promise.resolve()
    await Promise.resolve()
    const first = controller2.check()
    const second = controller2.check()
    await Promise.all([first, second])
    expect(slow.calls.filter(call => call === 'check')).toHaveLength(1)
    expect(controller2.access.getSnapshot()).toMatchObject({ checking: false, status: 'ready' })
    controller2.dispose()
  })

  it('检查途中卸载时不再发布忙状态', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    scope.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    let release: (() => void) | undefined
    const remote = remoteStub({
      check: async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return { ok: true as const, value: {
          enabled: true, platform: 'darwin', provider: 'macos-ax' as const, ready: true,
          accessibility: 'granted' as const, screenRecording: 'granted' as const,
        } }
      },
    })
    const controller = new ComputerUseSettingsController(scope.scope, remote)
    await Promise.resolve()
    await Promise.resolve()
    const pending = controller.check()
    controller.dispose()
    release?.()
    await pending
    // 卸载后停在检查中，不再把结果或结束状态写回视图。
    expect(controller.access.getSnapshot()).toMatchObject({ checking: true, status: 'ready' })
  })

  it('把注入面的检查与打开面板转发给远端', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    scope.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    const remote = remoteStub()
    const controller = new ComputerUseSettingsController(scope.scope, remote)
    const face = controller.inject()
    await face.check()
    expect(remote.calls).toContain('check')
    expect(await face.openPermissionSettings('accessibility')).toBe(true)
    expect(remote.calls.at(-1)).toBe('open:accessibility')
    controller.dispose()
  })

  it('申请权限后把系统给出的结论写回快照', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    scope.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    const remote = remoteStub({
      requestPermission: async (kind) => {
        remote.calls.push(`request:${kind}`)
        return { ok: true as const, value: {
          enabled: true, platform: 'darwin', provider: 'macos-ax' as const, ready: true,
          accessibility: 'granted' as const, screenRecording: 'not-determined' as const,
        } }
      },
    })
    const controller = new ComputerUseSettingsController(scope.scope, remote)
    await Promise.resolve()
    await Promise.resolve()
    expect(await controller.requestPermission('accessibility')).toBe(true)
    expect(remote.calls).toContain('request:accessibility')
    expect(controller.access.getSnapshot()).toMatchObject({
      checking: false, status: 'ready', value: { accessibility: 'granted', screenRecording: 'not-determined' },
    })
    controller.dispose()
  })

  it('申请被远端拒绝时保留原快照并结束忙状态', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    scope.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    const remote = remoteStub({ requestPermission: async () => ({ ok: false as const, error: {} }) })
    const controller = new ComputerUseSettingsController(scope.scope, remote)
    await Promise.resolve()
    await Promise.resolve()
    const before = controller.access.getSnapshot().value
    expect(await controller.requestPermission('screen-recording')).toBe(false)
    expect(controller.access.getSnapshot()).toMatchObject({ checking: false })
    expect(controller.access.getSnapshot().value).toEqual(before)
    controller.dispose()
  })

  it('申请途中卸载时丢弃结果，注入面转发申请请求', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    scope.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    let release: (() => void) | undefined
    const remote = remoteStub({
      requestPermission: async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return { ok: false as const, error: {} }
      },
    })
    const controller = new ComputerUseSettingsController(scope.scope, remote)
    await Promise.resolve()
    await Promise.resolve()
    const pending = controller.requestPermission('accessibility')
    await Promise.resolve()
    controller.dispose()
    release?.()
    expect(await pending).toBe(false)
    // 卸载后停在申请中，结束状态不再写回。
    expect(controller.access.getSnapshot().checking).toBe(true)

    const scope2 = stubSettingsScope<ComputerUseSettings>()
    scope2.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    const remote2 = remoteStub()
    const controller2 = new ComputerUseSettingsController(scope2.scope, remote2)
    await Promise.resolve()
    await Promise.resolve()
    expect(await controller2.inject().requestPermission('screen-recording')).toBe(true)
    expect(remote2.calls).toContain('request:screen-recording')
    controller2.dispose()
  })

  it('关闭时聚焦不探测；成功打开权限面板或启用后才复检', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    const remote = remoteStub()
    const controller = new ComputerUseSettingsController(scope.scope, remote)
    await controller.recheckOnFocus()
    scope.publish({ status: 'ready', value: { ...stored, enabled: false } })
    await controller.recheckOnFocus()
    expect(remote.calls).toEqual(['status'])
    expect(await controller.openPermissionSettings('accessibility')).toBe(true)
    await controller.recheckOnFocus()
    await controller.recheckOnFocus()
    expect(remote.calls).toEqual(['status', 'open:accessibility', 'check'])
    scope.publish({ value: stored })
    await controller.recheckOnFocus()
    expect(remote.calls.at(-1)).toBe('check')
    expect(remote.calls.filter(call => call === 'check')).toHaveLength(2)
    controller.dispose()
  })

  it('申请返回前收到多个聚焦事件，不废弃申请且在结算后只检查一次', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    scope.publish({ status: 'ready', value: { ...stored, enabled: false } })
    const pending = Promise.withResolvers<Awaited<ReturnType<ComputerUseRemote['requestPermission']>>>()
    const remote = remoteStub({ requestPermission: () => pending.promise })
    const controller = new ComputerUseSettingsController(scope.scope, remote)
    const result = await remote.status()
    const request = controller.requestPermission('screen-recording')
    const focus1 = controller.recheckOnFocus()
    const focus2 = controller.recheckOnFocus()
    expect(controller.access.getSnapshot().checking).toBe(true)
    expect(remote.calls).not.toContain('check')
    pending.resolve(result)
    await expect(request).resolves.toBe(true)
    await Promise.all([focus1, focus2])
    expect(remote.calls.filter(call => call === 'check')).toHaveLength(1)
    expect(controller.access.getSnapshot()).toMatchObject({ checking: false, status: 'ready' })
    controller.dispose()
  })

  it('检查返回失败时把状态标成错误', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    scope.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    const remote = remoteStub({ check: async () => ({ ok: false as const, error: {} }) })
    const controller = new ComputerUseSettingsController(scope.scope, remote)
    await Promise.resolve()
    await Promise.resolve()
    await controller.check()
    expect(controller.access.getSnapshot()).toMatchObject({ status: 'error', checking: false })
    expect(controller.access.getSnapshot().value).toBeUndefined()
    controller.dispose()
  })

  it('读取失败标成错误，检查失败保留原因并恢复按钮状态', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    scope.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    const remote = remoteStub({
      status: async () => ({ ok: false as const, error: {} }),
      check: async () => ({
        ok: true as const,
        value: { enabled: true, platform: 'darwin', provider: 'macos-ax' as const, ready: false,
          accessibility: 'denied' as const, screenRecording: 'unavailable' as const,
          lastError: 'external driver is not installed' },
      }),
      openPermissionSettings: async () => ({ ok: false as const, error: {} }),
    })
    const controller = new ComputerUseSettingsController(scope.scope, remote)
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.access.getSnapshot().status).toBe('error')
    await controller.check()
    expect(controller.access.getSnapshot()).toMatchObject({
      status: 'ready',
      checking: false,
      value: { ready: false, accessibility: 'denied', lastError: 'external driver is not installed' },
    })
    expect(await controller.openPermissionSettings('accessibility')).toBe(false)
    controller.dispose()
  })
})
