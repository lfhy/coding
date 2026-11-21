/**
 * 启用开关：配置默认值、服务可见性，以及关闭后直接调用也会失败关闭。
 * 提供方只做替身，不启动 helper、不触碰本机界面。
 */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  ComputerUseService, resolveConfig,
  type BackendActionResult, BackendCursorAction, BackendCursorActivation, BackendHealth, BackendObservation,
  BackendTrackedDragResult, ComputerAppIdentity, ComputerAppSelector, ComputerAppSummary, ComputerUseBackend,
  CursorVisibility,
} from '../src/index.ts'

/** 只记录被调用事实的提供方替身。 */
class FixtureBackend implements ComputerUseBackend {
  readonly name = 'macos-ax' as const
  readonly helperPath = '/fixture/dsh-computer-use-helper'
  readonly calls: string[] = []

  resolveApp(selector: ComputerAppSelector): Promise<ComputerAppIdentity> {
    this.calls.push('resolve-app')
    return Promise.resolve({ bundleId: selector.bundleId ?? 'com.example.fixture', pid: 4242, name: 'Fixture' })
  }

  listApps(): Promise<ComputerAppSummary[]> {
    this.calls.push('list-apps')
    return Promise.resolve([])
  }

  observe(app: ComputerAppIdentity): Promise<BackendObservation> {
    this.calls.push('observe')
    return Promise.resolve({
      app, stateHash: 'fixture', frontmost: true, treeText: '', truncated: false, elements: [],
      permissions: { accessibility: 'granted', screenRecording: 'granted' },
    })
  }

  activateForCursor(app: ComputerAppIdentity): Promise<BackendCursorActivation> {
    return this.observe(app).then(observation => ({ observation, activation: 'already-frontmost' as const }))
  }

  act(): Promise<BackendActionResult> {
    this.calls.push('act')
    return Promise.resolve({ channel: 'accessibility', activation: 'not-requested', pointerInput: false, pointerRouting: 'none' })
  }

  actDragWithCursor(): Promise<BackendTrackedDragResult> {
    return Promise.reject(new Error('fixture backend does not implement drag'))
  }

  visualizeCursor(action: BackendCursorAction): Promise<CursorVisibility> {
    return Promise.resolve({ visible: false, reason: `fixture backend does not draw a cursor for ${action.kind}` })
  }

  dispose(): Promise<void> { return Promise.resolve() }

  health(): Promise<BackendHealth> {
    return Promise.resolve({ helperVersion: '0.0.0-fixture', helperSha256: 'fixture', accessibility: 'granted', screenRecording: 'granted' })
  }

  openSettings(): Promise<void> { return Promise.reject(new Error('fixture backend does not open settings panes')) }
}

/** 可在测试里切换开关的服务：走生产的重配置路径并保留提供方替身。 */
class ToggleService extends ComputerUseService {
  constructor(ctx: Context, backend: FixtureBackend, enabled: boolean) {
    super(ctx, backend, resolveConfig({ enabled }))
  }

  /** 模拟设置提交后的重配置。 */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.reconfigure(new FixtureBackend(), resolveConfig({ enabled }))
  }
}

/** 以类插件形式挂载的服务：Cordis 会执行它的 `[Service.init]`，与生产一致。 */
class FixtureService extends ComputerUseService {
  static inject: string[] = []

  constructor(ctx: Context, config: { enabled: boolean }) {
    super(ctx, backend, resolveConfig(config))
  }

  /** 与生产提供方相同：Cordis 的初始化钩子负责跑一遍带容错的服务初始化。 */
  protected async [Service.init](): Promise<void> {
    await this.initialize()
  }
}

let backend = new FixtureBackend()

const call = (agent: object) => ({ agent: agent as never, workspace: '/fixture', signal: new AbortController().signal })

describe('电脑控制启用开关', () => {
  it('默认启用，关闭只改暴露面', () => {
    expect(resolveConfig({}).enabled).toBe(true)
    expect(resolveConfig({ enabled: false }).enabled).toBe(false)
  })

  it('关闭时拒绝直接调用，重新打开后恢复', async () => {
    const ctx = new Context()
    const backend = new FixtureBackend()
    await ctx.plugin({ apply: (context: Context) => { new ToggleService(context, backend, false) } })
    const service = ctx.computerUse as ToggleService
    expect(service.availability()).toBe(false)
    expect(service.status().enabled).toBe(false)
    await expect(service.listApps(call({}))).rejects.toMatchObject({ code: 'COMPUTER_DISABLED' })
    await expect(service.observe({ app: { bundleId: 'com.example.fixture' } }, call({})))
      .rejects.toMatchObject({ code: 'COMPUTER_DISABLED' })
    await expect(service.act({
      kind: 'click', observationId: 'missing', elementIndex: 0,
    } as never, call({}))).rejects.toMatchObject({ code: 'COMPUTER_DISABLED' })
    expect(backend.calls).toEqual([])

    await service.setEnabled(true)
    expect(service.availability()).toBe(true)
    expect(service.status().enabled).toBe(true)
    expect(await service.listApps(call({}))).toEqual([])
    await ctx.fiber.dispose()
  })

  it('启动时不去探测提供方，第一次真实调用才碰本机界面', async () => {
    backend = new FixtureBackend()
    let healthCalls = 0
    const original = backend.health.bind(backend)
    backend.health = async () => { healthCalls++; return await original() }
    const ctx = new Context()
    const fiber = ctx.plugin(FixtureService, { enabled: true })
    await fiber.await()
    const service = ctx.computerUse
    // 宿主启动只剩租约存储，状态保持"未探测"。
    expect(healthCalls).toBe(0)
    expect(service.status()).toMatchObject({ enabled: true, ready: false, accessibility: 'unavailable' })
    expect(await service.listApps(call({}))).toEqual([])
    // 显式健康检查仍然会问提供方，并记录真实权限状态。
    await service.health(new AbortController().signal)
    expect(healthCalls).toBe(1)
    expect(service.status()).toMatchObject({ ready: true, accessibility: 'granted' })
    await ctx.fiber.dispose()
  })

  it('开关变化通知订阅方，退订后不再收到', async () => {
    const ctx = new Context()
    await ctx.plugin({ apply: (context: Context) => { new ToggleService(context, new FixtureBackend(), true) } })
    const service = ctx.computerUse as ToggleService
    let notified = 0
    const dispose = service.watchAvailability(() => { notified++ })
    await service.setEnabled(false)
    expect(notified).toBe(1)
    dispose()
    await service.setEnabled(true)
    expect(notified).toBe(1)
    await ctx.fiber.dispose()
  })
})
