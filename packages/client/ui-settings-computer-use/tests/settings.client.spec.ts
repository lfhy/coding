import { describe, expect, it } from 'vitest'
import { stubSettingsScope } from 'coding-client-test-runtime'
import {
  ComputerUseSettingsController, DEFAULT_SETTINGS, collectChanges, decodeComputerUseSettings, decodeGrant,
  numberText, numberValue, numericTextOf, validArtifactRoot, validBundleId, validGrants, validNumeric,
  type ComputerUseSettings,
} from '../src/client/settings.ts'

const stored: ComputerUseSettings = {
  ...DEFAULT_SETTINGS,
  enabled: true,
  grants: [{ bundleId: 'com.apple.Notes', read: true, control: false }],
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
    const scope = stubSettingsScope<ComputerUseSettings>()
    const controller = new ComputerUseSettingsController(scope.scope)
    expect(controller.view.getSnapshot().section.status).toBe('loading')
    scope.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    expect(controller.view.getSnapshot().section.value).toEqual(stored)

    expect(await controller.inject().save({ enabled: false, grants: [] })).toBe(true)
    expect(scope.set.mock.calls).toEqual([['enabled', false], ['grants', []]])
    // 草稿里显式 undefined 的字段不写入线路。
    expect(await controller.save({ enabled: undefined } as unknown as Partial<ComputerUseSettings>)).toBe(true)
    expect(scope.set).toHaveBeenCalledTimes(2)
    const options = controller.inject()
    expect(options.hooks.computerUseSettings.getSnapshot().section.value).toEqual(stored)
    expect(controller.view.getSnapshot()).toMatchObject({ saving: false, failed: false })
    controller.dispose()
    expect(scope.listenerCount()).toBe(0)
  })

  it('不可写或写入失败时保留草稿并标记失败', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    const controller = new ComputerUseSettingsController(scope.scope)
    expect(await controller.save({ enabled: false })).toBe(false)
    scope.publish({ status: 'ready', writable: false, value: stored, base: stored, user: {}, revision: 1 })
    expect(await controller.save({ enabled: false })).toBe(false)
    scope.publish({ writable: true })
    scope.set.mockRejectedValueOnce(new Error('revision conflict'))
    expect(await controller.save({ enabled: false })).toBe(false)
    expect(controller.view.getSnapshot().failed).toBe(true)
    expect(scope.set).toHaveBeenCalledTimes(1)
    // 卸载后的失败不再改写视图，保存中也停在上一次状态。
    scope.set.mockRejectedValueOnce(new Error('late failure'))
    controller.dispose()
    expect(await controller.save({ enabled: false })).toBe(false)
    expect(controller.view.getSnapshot()).toMatchObject({ saving: true, failed: false })
  })

  it('并发保存以最新一次为准，被超越的一次不发布结果', async () => {
    const scope = stubSettingsScope<ComputerUseSettings>()
    const controller = new ComputerUseSettingsController(scope.scope)
    scope.publish({ status: 'ready', writable: true, value: stored, base: stored, user: {}, revision: 1 })
    const first = controller.save({ enabled: false })
    const second = controller.save({ grants: [] })
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(scope.set.mock.calls).toEqual([['enabled', false], ['grants', []]])
    controller.dispose()
  })
})
