/** 标准对话在导航前撤回工作模式选择，并将失败原样交还会话入口。 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { IApiClient } from 'coding-api-remotes/client'
import { SlotRegistry, type SessionId } from 'coding-client-runtime/client'
import { LocaleRuntime } from 'coding-client-locale/client'
import { TestRemote } from 'coding-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from 'coding-client-ui-settings/client'
import { apply, inject } from '../src/client/index.ts'
import { AgentPresetSeatController, type SeatSessionSummary } from '../src/client/seat-store.ts'
import type { AgentPresetSeatInjected } from '../src/client/AgentPresetSeat.tsx'

const SOURCE = 'work-session' as SessionId
const TARGET = 'standalone-session' as SessionId
const ROSTER = [
  { id: 'standard', trust: 'system' as const, isDefault: false },
  { id: 'minimal', trust: 'system' as const, isDefault: true },
]

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function bench() {
  let current: SeatSessionSummary | undefined
  const list = vi.fn(async () => ({
    rpcId: 'r',
    result: { ok: true as const, value: { presets: ROSTER, authorable: false, hasDocument: false } },
  }))
  const select = vi.fn(async (payload: { sessionId: SessionId; agentPreset: string }) => ({
    rpcId: 'r', result: { ok: true as const, value: { agentPreset: payload.agentPreset } },
  }))
  const settings = vi.fn()
  const note = vi.fn()
  const api = { agentPresets: { list, select }, settings: { update: settings } } as unknown as IApiClient
  const controller = new AgentPresetSeatController(api, () => current, note)
  return { controller, api, list, select, settings, note, move: (next?: SeatSessionSummary) => { current = next } }
}

describe('独立对话的标准模式准备', () => {
  it('取消无会话时暂存的工作模式，只切换明确目标，打开后的通知不再覆盖', async () => {
    const b = bench()
    await b.controller.load()
    b.controller.stage('minimal', true)
    const preparing = b.controller.prepareStandard(TARGET)
    expect(b.controller.store.getSnapshot()).toMatchObject({ busy: true, introduce: false })
    await preparing

    expect(b.select).toHaveBeenCalledExactlyOnceWith({ sessionId: TARGET, agentPreset: 'standard' })
    expect(b.note).toHaveBeenCalledExactlyOnceWith(TARGET, 'standard')
    b.move({ id: TARGET, blank: true, agentPreset: 'standard' })
    await b.controller.apply()
    expect(b.select).toHaveBeenCalledTimes(1)
    expect(b.settings).not.toHaveBeenCalled()
    expect(ROSTER.find(preset => preset.isDefault)?.id).toBe('minimal')
  })

  it('当前工作会话已开始也只准备目标，不重组来源', async () => {
    const b = bench()
    b.move({ id: SOURCE, blank: false, agentPreset: 'minimal' })
    await b.controller.prepareStandard(TARGET)
    expect(b.select).toHaveBeenCalledExactlyOnceWith({ sessionId: TARGET, agentPreset: 'standard' })
    expect(b.note).not.toHaveBeenCalledWith(SOURCE, expect.anything())
  })

  it.each(['成功', '失败'] as const)('先等待旧工作切换%s且去重重入，再为目标设置标准模式', async (outcome) => {
    const b = bench()
    const old = deferred()
    b.move({ id: SOURCE, blank: true, agentPreset: 'standard' })
    b.select.mockImplementationOnce(async (payload) => {
      await old.promise
      if (outcome === '失败') throw new Error('旧请求断开')
      return { rpcId: 'r', result: { ok: true, value: { agentPreset: payload.agentPreset } } }
    })
    const working = b.controller.select('minimal')
    const repeated = b.controller.apply()
    const preparing = b.controller.prepareStandard(TARGET)
    await Promise.resolve()
    expect(b.select).toHaveBeenCalledTimes(1)
    expect(b.list).not.toHaveBeenCalled()
    expect(b.controller.store.getSnapshot().busy).toBe(true)
    await b.controller.select('cordis')
    expect(b.select).toHaveBeenCalledTimes(1)
    old.resolve()
    await Promise.all([working, repeated, preparing])
    expect(b.select.mock.calls.map(([payload]) => payload)).toEqual([
      { sessionId: SOURCE, agentPreset: 'minimal' },
      { sessionId: TARGET, agentPreset: 'standard' },
    ])
    expect(b.note).toHaveBeenLastCalledWith(TARGET, 'standard')
    expect(b.controller.store.getSnapshot()).toMatchObject({ busy: false, current: 'standard', error: null })
    b.move({ id: TARGET, blank: true, agentPreset: 'standard' })
    await b.controller.apply()
    expect(b.select).toHaveBeenCalledTimes(2)
  })

  it('两次准备共用旧在途切换，其回执不会清掉后续明确暂存的工作模式', async () => {
    const b = bench()
    const old = deferred()
    b.move({ id: SOURCE, blank: true, agentPreset: 'standard' })
    b.select.mockImplementationOnce(async (payload) => {
      await old.promise
      return { rpcId: 'r', result: { ok: true, value: { agentPreset: payload.agentPreset } } }
    })
    const working = b.controller.select('minimal')
    const first = b.controller.prepareStandard(TARGET)
    const second = b.controller.prepareStandard(TARGET)
    b.controller.stage('cordis')
    old.resolve()
    await Promise.all([working, first, second])
    expect(b.select.mock.calls.map(([payload]) => payload.agentPreset)).toEqual(['minimal', 'standard', 'standard'])
    expect(b.controller.store.getSnapshot().busy).toBe(false)
    await b.controller.apply()
    expect(b.select).toHaveBeenLastCalledWith({ sessionId: SOURCE, agentPreset: 'cordis' })
  })

  it('准备期间的列表通知与选择器操作不会恢复旧工作模式', async () => {
    const b = bench()
    const roster = deferred()
    b.move({ id: SOURCE, blank: true, agentPreset: 'standard' })
    b.list.mockImplementationOnce(async () => {
      await roster.promise
      return { rpcId: 'r', result: { ok: true, value: { presets: ROSTER, authorable: false, hasDocument: false } } }
    })
    b.controller.stage('minimal')
    const preparing = b.controller.prepareStandard(TARGET)
    await b.controller.select('minimal')
    await b.controller.apply()
    expect(b.select).not.toHaveBeenCalled()
    roster.resolve()
    await preparing
    expect(b.select).toHaveBeenCalledExactlyOnceWith({ sessionId: TARGET, agentPreset: 'standard' })
    b.move({ id: TARGET, blank: true, agentPreset: 'standard' })
    await b.controller.apply()
    expect(b.select).toHaveBeenCalledTimes(1)
  })

  it('空名单部署不选择预设，仍清掉工作入口暂存', async () => {
    const b = bench()
    b.list.mockResolvedValue({
      rpcId: 'r', result: { ok: true, value: { presets: [], authorable: false, hasDocument: false } },
    })
    b.controller.stage('minimal')
    await b.controller.prepareStandard(TARGET)
    b.move({ id: TARGET, blank: true })
    await b.controller.apply()
    expect(b.select).not.toHaveBeenCalled()
    expect(b.note).not.toHaveBeenCalled()
    expect(b.controller.store.getSnapshot()).toMatchObject({ busy: false, current: '', options: [] })
  })

  it.each(['缺失', '损坏'] as const)('非空名单的标准模式%s时拒绝，不退回默认', async (state) => {
    const b = bench()
    const presets = state === '缺失' ? [ROSTER[1]!]
      : [{ ...ROSTER[0]!, broken: '组装不可加载' }, ROSTER[1]!]
    b.list.mockResolvedValue({
      rpcId: 'r', result: { ok: true, value: { presets, authorable: false, hasDocument: false } },
    })
    await expect(b.controller.prepareStandard(TARGET)).rejects.toThrow('标准模式暂不可用')
    expect(b.select).not.toHaveBeenCalled()
    expect(b.note).not.toHaveBeenCalled()
    expect(b.settings).not.toHaveBeenCalled()
  })

  it.each(['名单答复', '名单断开', '切换答复', '切换断开'] as const)('%s失败向入口拒绝，允许明确重试', async (failure) => {
    const b = bench()
    const error = new Error('暂时不可用')
    const rejected = { rpcId: 'r', result: { ok: false, error: { code: 'agent-preset-locked', message: error.message } } }
    if (failure === '名单答复') b.list.mockResolvedValueOnce(rejected as never)
    if (failure === '名单断开') b.list.mockRejectedValueOnce(error)
    if (failure === '切换答复') b.select.mockResolvedValueOnce(rejected as never)
    if (failure === '切换断开') b.select.mockRejectedValueOnce(error)
    await expect(b.controller.prepareStandard(TARGET)).rejects.toThrow(error.message)
    expect(b.note).not.toHaveBeenCalled()
    expect(b.controller.store.getSnapshot()).toMatchObject({ busy: false, error: error.message })
    await b.controller.prepareStandard(TARGET)
    expect(b.note).toHaveBeenCalledExactlyOnceWith(TARGET, 'standard')
    expect(b.settings).not.toHaveBeenCalled()
  })

  it('已开始目标由 Host 拒绝，准备不发布成功摘要', async () => {
    const b = bench()
    b.select.mockResolvedValueOnce({
      rpcId: 'r', result: { ok: false, error: { code: 'agent-preset-locked', message: '会话已经开始' } },
    } as never)
    await expect(b.controller.prepareStandard(TARGET)).rejects.toThrow('会话已经开始')
    expect(b.note).not.toHaveBeenCalled()
  })
})

describe('标准入口的插件事件生命周期', () => {
  it('无需挂载选择器就准备非当前目标，卸载后移除监听且不改默认', async () => {
    const ctx = new Context()
    const b = bench()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    new TestRemote(ctx)
    ctx.provide('connection', { api: b.api } as never)
    await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
    ctx.slots.register({
      name: 'root', children: {
        'settings.general.item': { kind: 'list', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
        conversation: { kind: 'single', scope: 'root' },
      },
    } as never, () => null)
    ctx.slots.register({
      name: 'conversation', children: {
        'conversation.hero.agentPreset': { kind: 'single', scope: 'root' },
        'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)
    const listeners = new Set<() => void>()
    const state = {
      current: undefined as SessionId | undefined,
      byId: {
        [SOURCE]: { id: SOURCE, blank: false, agentPreset: 'minimal' },
        [TARGET]: { id: TARGET, blank: true, agentPreset: 'minimal' },
      },
    }
    ctx.provide('sessions', {
      list: {
        getSnapshot: () => state,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      },
      noteAgentPreset: (id: SessionId, preset: string) => {
        b.note(id, preset)
        state.byId[id]!.agentPreset = preset
        for (const listener of listeners) listener()
      },
    } as never)
    ctx.provide('conversation', {} as never)
    ctx.provide('workspaces', {} as never)
    const fiber = ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'workspaces'], apply })
    await fiber.await()
    const chip = (ctx.slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as () => AgentPresetSeatInjected)()
    await chip.select('minimal')
    state.current = SOURCE
    await ctx.serial('conversation/prepare-standalone', TARGET)
    expect(b.select).toHaveBeenCalledExactlyOnceWith({ sessionId: TARGET, agentPreset: 'standard' })
    expect(state.byId[SOURCE]!.agentPreset).toBe('minimal')
    expect(state.byId[TARGET]!.agentPreset).toBe('standard')
    state.current = TARGET
    for (const listener of listeners) listener()
    await Promise.resolve()
    expect(b.select).toHaveBeenCalledTimes(1)

    b.list.mockRejectedValueOnce(new Error('连接失败'))
    await expect(ctx.serial('conversation/prepare-standalone', TARGET)).rejects.toThrow('连接失败')
    await fiber.dispose()
    const reads = b.list.mock.calls.length
    await ctx.serial('conversation/prepare-standalone', TARGET)
    expect(b.list).toHaveBeenCalledTimes(reads)
    expect(listeners.size).toBe(0)
    expect(b.settings).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
