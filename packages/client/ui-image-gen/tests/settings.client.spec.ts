import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from 'coding-client-test-runtime'
import { ImageSettingsController, decodeImageSettings, imageServiceReady, localEndpoint, validEndpoint, validKeyRef, type ImageSettings } from '../src/client/settings.ts'

function setup(settings: ImageSettings = { enabled: false, endpoint: '', model: '', apiKeyRef: 'IMAGE_GEN_API_KEY' }) {
  const scope = stubSettingsScope<ImageSettings>()
  scope.publish({ status: 'ready', writable: true, value: settings, base: settings, user: {}, revision: 1 })
  const credentials: Record<string, { configured: boolean; writable: boolean }> = {
    IMAGE_GEN_API_KEY: { configured: false, writable: true },
  }
  const describe = vi.fn(async () => ({ rpcId: '1' as never, result: { ok: true as const, value: {
    credentials,
  } } }))
  const set = vi.fn(async () => ({ rpcId: '2' as never, result: { ok: true as const, value: {} } }))
  const controller = new ImageSettingsController(scope.scope, { credentials: { describe, set } } as never)
  return { scope, credentials, describe, set, controller }
}

describe('图像生成设置', () => {
  it('拒绝坏字段，并允许本机无鉴权的 HTTP 服务', () => {
    expect(decodeImageSettings({ enabled: true, endpoint: 'http://localhost:5000', model: 'image', apiKeyRef: '' }))
      .toEqual({ enabled: true, endpoint: 'http://localhost:5000', model: 'image', apiKeyRef: '' })
    expect(decodeImageSettings({ enabled: 'yes', endpoint: '', model: '', apiKeyRef: '' })).toBeUndefined()
    expect(decodeImageSettings({ enabled: true, endpoint: 'http://localhost/v1', model: 'image', apiKeyRef: '',
      sizes: { '1:1': { '2K': '2048x2048' } }, maxEditReferences: 2 })).toMatchObject({
      sizes: { '1:1': { '2K': '2048x2048' } }, maxEditReferences: 2,
    })
    expect(decodeImageSettings({ enabled: true, endpoint: '', model: '', apiKeyRef: '', sizes: { '1:1': [] } })).toBeUndefined()
    expect(validEndpoint('https://images.example/v1')).toBe(true)
    expect(validEndpoint('http://127.0.0.1:9000/v1')).toBe(true)
    expect(validEndpoint('http://localhost:9000/v1')).toBe(true)
    expect(validEndpoint('http://[::1]:9000/v1')).toBe(true)
    expect(validEndpoint('http://remote.example/v1')).toBe(false)
    expect(validEndpoint('https://10.0.0.2/v1')).toBe(false)
    expect(validEndpoint('https://intranet/v1')).toBe(false)
    expect(validEndpoint('https://person:key@images.example')).toBe(false)
    expect(localEndpoint('http://localhost:9000/v1')).toBe(true)
    expect(localEndpoint('https://images.example/v1')).toBe(false)
    expect(localEndpoint('http://remote.example/v1')).toBe(false)
    expect(validKeyRef('')).toBe(true)
    expect(validKeyRef('IMAGE_GEN_API_KEY')).toBe(true)
    expect(validKeyRef('secret/value')).toBe(false)
  })

  it('缺少模型或凭据时不能启用，已输入字段仍可单独保存', async () => {
    const { scope, controller } = setup()
    scope.set.mockImplementation((field, value) => {
      scope.publish({ value: { ...scope.scope.getSnapshot().value!, [field]: value as string | boolean }, revision: 2 })
    })
    await expect(controller.save({ enabled: true })).resolves.toEqual({ ok: false, keySaved: false })
    expect(scope.set).not.toHaveBeenCalledWith('enabled', true)
    expect(controller.view.getSnapshot().section.value?.enabled).toBe(false)
    await expect(controller.save({ endpoint: 'https://images.example/v1' })).resolves.toEqual({ ok: true, keySaved: false })
    expect(scope.set).toHaveBeenCalledWith('endpoint', 'https://images.example/v1')
    controller.dispose()
  })

  it('空引用不读写凭据；密钥明文不进入任何共享快照', async () => {
    const { scope, controller, describe, set } = setup()
    await vi.waitFor(() => { expect(controller.view.getSnapshot().credential.status).toBe('ready') })
    scope.set.mockImplementation((field, value) => {
      scope.publish({ value: { ...scope.scope.getSnapshot().value!, [field]: value as string | boolean }, revision: 2 })
    })
    await expect(controller.save({ apiKeyRef: '' })).resolves.toEqual({ ok: true, keySaved: false })
    expect(controller.view.getSnapshot().credential).toMatchObject({ ref: '', configured: true, writable: false })
    expect(describe).toHaveBeenCalledTimes(1)
    expect(set).not.toHaveBeenCalled()
    await expect(controller.save({}, 'a-secret-value')).resolves.toEqual({ ok: false, keySaved: false })
    expect(JSON.stringify(controller.view.getSnapshot())).not.toContain('a-secret-value')
    controller.dispose()
  })

  it('非空引用只发布配置状态，卸载后不再应用迟到的响应', async () => {
    const { controller, credentials, set } = setup()
    await vi.waitFor(() => { expect(controller.view.getSnapshot().credential.status).toBe('ready') })
    set.mockImplementation(async () => {
      credentials.IMAGE_GEN_API_KEY = { configured: true, writable: true }
      return { rpcId: '2' as never, result: { ok: true as const, value: {} } }
    })
    await expect(controller.save({}, 'top-secret')).resolves.toEqual({ ok: true, keySaved: true })
    expect(set).toHaveBeenCalledWith({ ref: 'IMAGE_GEN_API_KEY', value: 'top-secret' })
    expect(JSON.stringify(controller.view.getSnapshot())).not.toContain('top-secret')
    controller.dispose()
  })

  it('保留自定义引用并拒绝空密钥写入', async () => {
    const { controller, credentials, describe, set } = setup({ enabled: false, endpoint: 'https://images.example', model: 'paint', apiKeyRef: 'CUSTOM_KEY' })
    credentials.CUSTOM_KEY = { configured: true, writable: true }
    await controller.refreshCredential()
    expect(describe).toHaveBeenLastCalledWith({ refs: ['CUSTOM_KEY'] })
    await expect(controller.save({}, '')).resolves.toEqual({ ok: true, keySaved: false })
    expect(set).not.toHaveBeenCalled()
    await expect(controller.save({}, 'custom-secret')).resolves.toEqual({ ok: true, keySaved: true })
    expect(set).toHaveBeenCalledWith({ ref: 'CUSTOM_KEY', value: 'custom-secret' })
    expect(JSON.stringify(controller.view.getSnapshot())).not.toContain('custom-secret')
    controller.dispose()
  })

  it('设置命名空间只读时，即便凭据可写也拒绝密钥写入', async () => {
    const { controller, scope, set } = setup()
    await vi.waitFor(() => { expect(controller.view.getSnapshot().credential.status).toBe('ready') })
    scope.publish({ writable: false })
    await expect(controller.save({}, 'not-written')).resolves.toEqual({ ok: false, keySaved: false })
    expect(set).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('一键提交只将密钥发往凭据服务，成功后才持久化启用状态', async () => {
    const { controller, scope, credentials, set } = setup()
    const order: string[] = []
    scope.set.mockImplementation((field, value) => {
      order.push(String(field))
      scope.publish({ value: { ...scope.scope.getSnapshot().value!, [field]: value as string | boolean }, revision: 2 })
    })
    set.mockImplementation(async () => {
      order.push('credentials.set')
      credentials.IMAGE_GEN_API_KEY = { configured: true, writable: true }
      return { rpcId: '2' as never, result: { ok: true as const, value: {} } }
    })
    await expect(controller.save({ endpoint: 'https://images.example/v1', model: 'paint', enabled: true }, 'top-secret'))
      .resolves.toEqual({ ok: true, keySaved: true })
    expect(order).toEqual(['endpoint', 'model', 'credentials.set', 'enabled'])
    expect(scope.set.mock.calls).toEqual([
      ['endpoint', 'https://images.example/v1'], ['model', 'paint'], ['enabled', true],
    ])
    expect(set).toHaveBeenCalledWith({ ref: 'IMAGE_GEN_API_KEY', value: 'top-secret' })
    expect(imageServiceReady(controller.view.getSnapshot())).toBe(true)
    expect(JSON.stringify(controller.view.getSnapshot())).not.toContain('top-secret')
    controller.dispose()
  })

  it('已启用服务更换尺寸表和参考图上限时先停用，成功后恢复', async () => {
    const { controller, scope } = setup({ enabled: true, endpoint: 'http://localhost:8080/v1',
      model: 'paint', apiKeyRef: '', sizes: {}, maxEditReferences: 1 })
    const order: string[] = []
    scope.set.mockImplementation((field, value) => {
      order.push(String(field))
      scope.publish({ value: { ...scope.scope.getSnapshot().value!, [field]: value as ImageSettings[keyof ImageSettings] }, revision: 2 })
    })
    const changes = { sizes: { '16:9': { '2K': '2048x1152' } }, maxEditReferences: 2 }
    await expect(controller.save(changes)).resolves.toEqual({ ok: true, keySaved: false })
    expect(order).toEqual(['enabled', 'sizes', 'maxEditReferences', 'enabled'])
    expect(scope.scope.getSnapshot().value).toMatchObject({ ...changes, enabled: true })
    controller.dispose()
  })

  it('凭据失败保留未启用状态，重试跳过已成功写入的字段', async () => {
    const { controller, scope, credentials, set } = setup()
    scope.set.mockImplementation((field, value) => {
      scope.publish({ value: { ...scope.scope.getSnapshot().value!, [field]: value as string | boolean }, revision: 2 })
    })
    set.mockResolvedValueOnce({ rpcId: '2' as never, result: { ok: false as const, error: { message: 'failed' } } } as never)
    const changes = { endpoint: 'https://images.example/v1', model: 'paint', enabled: true }
    await expect(controller.save(changes, 'top-secret')).resolves.toEqual({ ok: false, keySaved: false })
    expect(scope.scope.getSnapshot().value).toMatchObject({ endpoint: changes.endpoint, model: changes.model, enabled: false })
    expect(controller.view.getSnapshot().failed).toBe(true)
    credentials.IMAGE_GEN_API_KEY = { configured: true, writable: true }
    await expect(controller.save(changes, 'top-secret')).resolves.toEqual({ ok: true, keySaved: true })
    expect(scope.set.mock.calls).toEqual([
      ['endpoint', changes.endpoint], ['model', changes.model], ['enabled', true],
    ])
    expect(set).toHaveBeenCalledTimes(2)
    expect(controller.view.getSnapshot().failed).toBe(false)
    controller.dispose()
  })

  it('从本机无鉴权切回默认引用时先写引用，再写密钥与启用状态', async () => {
    const { controller, scope, credentials, set } = setup({ enabled: false, endpoint: 'http://localhost:8000/v1', model: 'paint', apiKeyRef: '' })
    const order: string[] = []
    scope.set.mockImplementation((field, value) => {
      order.push(String(field))
      scope.publish({ value: { ...scope.scope.getSnapshot().value!, [field]: value as string | boolean }, revision: 2 })
    })
    set.mockImplementation(async () => {
      order.push('credentials.set')
      credentials.IMAGE_GEN_API_KEY = { configured: true, writable: true }
      return { rpcId: '2' as never, result: { ok: true as const, value: {} } }
    })
    await expect(controller.save({ apiKeyRef: 'IMAGE_GEN_API_KEY', enabled: true }, 'top-secret'))
      .resolves.toEqual({ ok: true, keySaved: true })
    expect(order).toEqual(['apiKeyRef', 'credentials.set', 'enabled'])
    expect(set).toHaveBeenCalledWith({ ref: 'IMAGE_GEN_API_KEY', value: 'top-secret' })
    controller.dispose()
  })

  it('已启用服务更换地址时先停用，密钥失败后保持停用并可重试', async () => {
    const { controller, scope, credentials, set } = setup({
      enabled: true, endpoint: 'https://old.example/v1', model: 'paint', apiKeyRef: 'IMAGE_GEN_API_KEY',
    })
    const order: string[] = []
    scope.set.mockImplementation((field, value) => {
      order.push(`${field}:${String(value)}`)
      scope.publish({ value: { ...scope.scope.getSnapshot().value!, [field]: value as string | boolean }, revision: 2 })
    })
    set.mockResolvedValueOnce({ rpcId: '2' as never, result: { ok: false as const, error: { message: 'failed' } } } as never)
    const changes = { endpoint: 'https://new.example/v1', enabled: true }
    await expect(controller.save(changes, 'new-secret')).resolves.toEqual({ ok: false, keySaved: false })
    expect(order).toEqual(['enabled:false', 'endpoint:https://new.example/v1'])
    expect(scope.scope.getSnapshot().value?.enabled).toBe(false)
    credentials.IMAGE_GEN_API_KEY = { configured: true, writable: true }
    await expect(controller.save(changes, 'new-secret')).resolves.toEqual({ ok: true, keySaved: true })
    expect(order).toEqual(['enabled:false', 'endpoint:https://new.example/v1', 'enabled:true'])
    expect(set).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('密钥已写入而最终启用失败时只重试启用，不重复写密钥', async () => {
    const { controller, scope, credentials, set } = setup()
    scope.set.mockImplementation((field, value) => {
      if (field === 'enabled' && scope.set.mock.calls.filter(([name]) => name === 'enabled').length === 1) throw new Error('revision conflict')
      scope.publish({ value: { ...scope.scope.getSnapshot().value!, [field]: value as string | boolean }, revision: 2 })
    })
    set.mockImplementation(async () => {
      credentials.IMAGE_GEN_API_KEY = { configured: true, writable: true }
      return { rpcId: '2' as never, result: { ok: true as const, value: {} } }
    })
    const changes = { endpoint: 'https://images.example/v1', enabled: true }
    await expect(controller.save(changes, 'new-secret')).resolves.toEqual({ ok: false, keySaved: true })
    await expect(controller.save(changes, '')).resolves.toEqual({ ok: true, keySaved: false })
    expect(scope.set.mock.calls).toEqual([
      ['endpoint', changes.endpoint], ['enabled', true], ['enabled', true],
    ])
    expect(set).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('凭据写入已确认但状态未就绪时不启用，重试只检查状态', async () => {
    const { controller, scope, credentials, set } = setup()
    scope.set.mockImplementation((field, value) => {
      scope.publish({ value: { ...scope.scope.getSnapshot().value!, [field]: value as string | boolean }, revision: 2 })
    })
    const changes = { endpoint: 'https://images.example/v1', model: 'paint', enabled: true }
    await expect(controller.save(changes, 'accepted-secret')).resolves.toEqual({ ok: false, keySaved: true })
    expect(scope.scope.getSnapshot().value?.enabled).toBe(false)
    expect(set).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(controller.view.getSnapshot())).not.toContain('accepted-secret')
    credentials.IMAGE_GEN_API_KEY = { configured: true, writable: true }
    await expect(controller.save(changes, '')).resolves.toEqual({ ok: true, keySaved: false })
    expect(set).toHaveBeenCalledTimes(1)
    expect(imageServiceReady(controller.view.getSnapshot())).toBe(true)
    controller.dispose()
  })
})
