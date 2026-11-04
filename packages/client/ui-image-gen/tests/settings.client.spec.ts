import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from 'coding-client-test-runtime'
import { ImageSettingsController, decodeImageSettings, validEndpoint, validKeyRef, type ImageSettings } from '../src/client/settings.ts'

function setup(settings: ImageSettings = { enabled: false, endpoint: '', model: '', apiKeyRef: 'IMAGE_GEN_API_KEY' }) {
  const scope = stubSettingsScope<ImageSettings>()
  scope.publish({ status: 'ready', writable: true, value: settings, base: settings, user: {}, revision: 1 })
  const describe = vi.fn(async () => ({ rpcId: '1' as never, result: { ok: true as const, value: {
    credentials: { IMAGE_GEN_API_KEY: { configured: false, writable: true } },
  } } }))
  const set = vi.fn(async () => ({ rpcId: '2' as never, result: { ok: true as const, value: {} } }))
  const controller = new ImageSettingsController(scope.scope, { credentials: { describe, set } } as never)
  return { scope, describe, set, controller }
}

describe('图像生成设置', () => {
  it('拒绝坏字段，并允许本机无鉴权的 HTTP 服务', () => {
    expect(decodeImageSettings({ enabled: true, endpoint: 'http://localhost:5000', model: 'image', apiKeyRef: '' }))
      .toEqual({ enabled: true, endpoint: 'http://localhost:5000', model: 'image', apiKeyRef: '' })
    expect(decodeImageSettings({ enabled: 'yes', endpoint: '', model: '', apiKeyRef: '' })).toBeUndefined()
    expect(validEndpoint('https://images.example/v1')).toBe(true)
    expect(validEndpoint('http://127.0.0.1:9000/v1')).toBe(true)
    expect(validEndpoint('http://localhost:9000/v1')).toBe(true)
    expect(validEndpoint('http://[::1]:9000/v1')).toBe(true)
    expect(validEndpoint('http://remote.example/v1')).toBe(false)
    expect(validEndpoint('https://10.0.0.2/v1')).toBe(false)
    expect(validEndpoint('https://intranet/v1')).toBe(false)
    expect(validEndpoint('https://person:key@images.example')).toBe(false)
    expect(validKeyRef('')).toBe(true)
    expect(validKeyRef('IMAGE_GEN_API_KEY')).toBe(true)
    expect(validKeyRef('secret/value')).toBe(false)
  })

  it('允许开关与配置逐字段持久化，缺少模型不妨碍保存开关', async () => {
    const { scope, controller } = setup()
    scope.set.mockImplementation((field, value) => {
      scope.publish({ value: { ...scope.scope.getSnapshot().value!, [field]: value as string | boolean }, revision: 2 })
    })
    await expect(controller.save({ enabled: true })).resolves.toBe(true)
    expect(scope.set).toHaveBeenCalledWith('enabled', true)
    expect(controller.view.getSnapshot().section.value?.enabled).toBe(true)
    controller.dispose()
  })

  it('空引用不读写凭据；密钥明文不进入任何共享快照', async () => {
    const { scope, controller, describe, set } = setup()
    await vi.waitFor(() => { expect(controller.view.getSnapshot().credential.status).toBe('ready') })
    scope.set.mockImplementation((field, value) => {
      scope.publish({ value: { ...scope.scope.getSnapshot().value!, [field]: value as string | boolean }, revision: 2 })
    })
    await expect(controller.save({ apiKeyRef: '' })).resolves.toBe(true)
    expect(controller.view.getSnapshot().credential).toMatchObject({ ref: '', configured: true, writable: false })
    expect(describe).toHaveBeenCalledTimes(1)
    expect(set).not.toHaveBeenCalled()
    await expect(controller.saveKey('a-secret-value')).resolves.toBe(false)
    expect(JSON.stringify(controller.view.getSnapshot())).not.toContain('a-secret-value')
    controller.dispose()
  })

  it('非空引用只发布配置状态，卸载后不再应用迟到的响应', async () => {
    const { controller, describe, set } = setup()
    await vi.waitFor(() => { expect(controller.view.getSnapshot().credential.status).toBe('ready') })
    describe.mockImplementation(async () => ({ rpcId: '1' as never, result: { ok: true as const, value: {
      credentials: { IMAGE_GEN_API_KEY: { configured: true, writable: true } },
    } } }))
    await expect(controller.saveKey('top-secret')).resolves.toBe(true)
    expect(set).toHaveBeenCalledWith({ ref: 'IMAGE_GEN_API_KEY', value: 'top-secret' })
    expect(JSON.stringify(controller.view.getSnapshot())).not.toContain('top-secret')
    controller.dispose()
  })
})
