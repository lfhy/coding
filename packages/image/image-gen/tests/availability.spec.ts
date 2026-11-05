import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from 'coding-credentials'
import SessionStore from 'coding-session'
import { SettingsProvider, type SettingsNamespace } from 'coding-settings'
import { describe, expect, it, vi } from 'vitest'
import ImageGeneration, { IMAGE_GENERATION_NAMESPACE } from '../src/index.ts'

class TestSettings extends SettingsProvider {
  readonly writable = true

  constructor(ctx: Context, private readonly doc: Record<string, unknown>) { super(ctx) }

  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

async function boot(config?: { enabled: boolean; endpoint: string; model: string; apiKeyRef: string; maxEditReferences: number }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  ctx.provide('attachments', {} as never)
  const keys = new Map<string, string>()
  ctx.provide('credentials', {
    resolve: async (ref: string) => keys.has(ref) ? { value: keys.get(ref)!, source: 'test' } : undefined,
  } as never)
  await ctx.plugin(ImageGeneration, config)
  return { ctx, keys, service: ctx.imageGeneration }
}

describe('图像服务可用性通知', () => {
  it('通知设置来源挂载、提交与卸载，并以来源实际值重新判定', async () => {
    const { ctx, service } = await boot()
    let notifications = 0
    const stop = service.watchAvailability(() => { notifications++ })
    expect(await service.status()).toMatchObject({ available: false })
    expect(notifications).toBe(0)

    const settings = ctx.plugin(TestSettings, {
      [IMAGE_GENERATION_NAMESPACE]: {
        enabled: true, endpoint: 'http://127.0.0.1:9/v1', model: 'mock', apiKeyRef: '',
      },
    })
    await settings
    await vi.waitFor(() => { expect(notifications).toBe(1) })
    expect(await service.status()).toMatchObject({ available: true })

    await ctx.settings.update(IMAGE_GENERATION_NAMESPACE, { enabled: false })
    await vi.waitFor(() => { expect(notifications).toBe(2) })
    expect(await service.status()).toMatchObject({ available: false })

    await settings.dispose()
    await vi.waitFor(() => { expect(notifications).toBe(3) })
    expect(await service.status()).toMatchObject({ available: false })
    stop()
    await ctx.fiber.dispose()
  })

  it('只通知当前引用的凭据变化，撤销后不再通知', async () => {
    const { ctx, keys, service } = await boot({
      enabled: true, endpoint: 'http://127.0.0.1:9/v1', model: 'mock', apiKeyRef: 'IMAGE_GEN_API_KEY', maxEditReferences: 1,
    })
    const listener = vi.fn()
    const stop = service.watchAvailability(listener)
    expect(await service.status()).toMatchObject({ available: false })
    ctx.emit('credentials/updated', credentialRef('OTHER_API_KEY'))
    expect(listener).not.toHaveBeenCalled()

    keys.set('IMAGE_GEN_API_KEY', 'secret')
    ctx.emit('credentials/updated', credentialRef('IMAGE_GEN_API_KEY'))
    expect(listener).toHaveBeenCalledOnce()
    expect(await service.status()).toMatchObject({ available: true })
    stop()
    keys.delete('IMAGE_GEN_API_KEY')
    ctx.emit('credentials/updated', credentialRef('IMAGE_GEN_API_KEY'))
    expect(listener).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})
