import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from 'coding-session'
import UserQuestionService from 'coding-user-questions'
import type { SessionHeader, SessionId } from 'coding-session'
import { createApiProxy } from 'coding-host-apiproxy'
import { RpcId } from 'coding-host-apiproxy/api/rpc'

const sid = (id: string): SessionId => id as SessionId
const request = () => ({ rpcId: RpcId('repair-metadata'), payload: {} })
const meta = (id: string): SessionHeader => ({ version: 0, id: sid(id), createdAt: 1, cwd: '/project' })

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return { ctx, api }
}

describe('session.rebuildMetadata', () => {
  it('isolates four corrupt logs while rebuilding 519 cold sessions and skipping live sessions', async () => {
    const { ctx, api } = await setup()
    const healthy = Array.from({ length: 519 }, (_, index) => meta(`healthy-${index}`))
    const corrupt = Array.from({ length: 4 }, (_, index) => meta(`corrupt-${index}`))
    const live = ctx.sessions.create(sid('live'), { meta: { cwd: '/project' } })
    const before = [...live.events]
    const list = vi.fn(async () => [healthy[0]!, ...corrupt, ...healthy.slice(1), live.header])
    const rebuild = vi.fn(async (id: SessionId) => {
      if (id.startsWith('corrupt')) throw new Error('/private/session.jsonl contains secret message')
    })
    const readFrom = vi.fn()
    const append = vi.fn()
    ctx.provide('sessionPersistence', { list, readFrom, append } as never)
    ctx.provide('sessionProjectionCache', { rebuild } as never)
    const signal = new AbortController().signal

    const response = await api.sessions.rebuildMetadata(request(), signal)

    expect(response.rpcId).toBe('repair-metadata')
    expect(response.result).toEqual({
      ok: true,
      value: {
        total: 524,
        rebuilt: 519,
        skippedLive: 1,
        failures: corrupt.map(header => ({ sessionId: header.id, message: '无法从持久日志重建该会话元数据' })),
      },
    })
    expect(list).toHaveBeenCalledWith(signal)
    expect(rebuild).toHaveBeenCalledTimes(523)
    expect(rebuild).toHaveBeenLastCalledWith(healthy.at(-1)!.id, signal)
    expect(rebuild).not.toHaveBeenCalledWith(live.id, expect.anything())
    expect(readFrom).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(live.events).toEqual(before)
    expect(JSON.stringify(response)).not.toMatch(/private|secret/)
  })

  it('rechecks live attachment before each cold rebuild', async () => {
    const { ctx, api } = await setup()
    ctx.provide('sessionPersistence', { list: async () => [meta('first'), meta('attached-later')] } as never)
    const rebuild = vi.fn(async () => {
      ctx.sessions.create(sid('attached-later'), { meta: { cwd: '/project' } })
    })
    ctx.provide('sessionProjectionCache', { rebuild } as never)
    expect((await api.sessions.rebuildMetadata(request(), new AbortController().signal)).result).toEqual({
      ok: true, value: { total: 2, rebuilt: 1, skippedLive: 1, failures: [] },
    })
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  it('counts a session that attaches during rebuild as skipped, not corrupt', async () => {
    const { ctx, api } = await setup()
    const id = sid('attached-during-rebuild')
    ctx.provide('sessionPersistence', { list: async () => [meta(id)] } as never)
    ctx.provide('sessionProjectionCache', { rebuild: async () => {
      ctx.sessions.create(id, { meta: { cwd: '/project' } })
      throw new Error('cannot rebuild metadata for live session')
    } } as never)
    expect((await api.sessions.rebuildMetadata(request(), new AbortController().signal)).result).toEqual({
      ok: true, value: { total: 1, rebuilt: 0, skippedLive: 1, failures: [] },
    })
  })

  it('stops on caller cancellation instead of treating it as a corrupt session', async () => {
    const { ctx, api } = await setup()
    const controller = new AbortController()
    ctx.provide('sessionPersistence', { list: async () => [meta('first'), meta('second')] } as never)
    const rebuild = vi.fn(async () => { controller.abort(); throw new Error('aborted') })
    ctx.provide('sessionProjectionCache', { rebuild } as never)
    expect((await api.sessions.rebuildMetadata(request(), controller.signal)).result).toMatchObject({
      ok: false, error: { code: 'cancelled' },
    })
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  it('returns a safe unavailable error when required services are absent', async () => {
    const { api } = await setup()
    expect((await api.sessions.rebuildMetadata(request(), new AbortController().signal)).result).toMatchObject({
      ok: false, error: { code: 'internal', message: '会话元数据修复需要持久化与投影缓存服务' },
    })
  })

  it('does not expose list errors or start work after cancellation', async () => {
    const { ctx, api } = await setup()
    const list = vi.fn(async () => { throw new Error('/private/log secret') })
    const rebuild = vi.fn()
    ctx.provide('sessionPersistence', { list } as never)
    ctx.provide('sessionProjectionCache', { rebuild } as never)
    const response = await api.sessions.rebuildMetadata(request(), new AbortController().signal)
    expect(response.result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(JSON.stringify(response)).not.toMatch(/private|secret/)
    const controller = new AbortController()
    controller.abort()
    expect((await api.sessions.rebuildMetadata(request(), controller.signal)).result).toMatchObject({
      ok: false, error: { code: 'cancelled' },
    })
    expect(list).toHaveBeenCalledTimes(1)
    expect(rebuild).not.toHaveBeenCalled()
  })
})
