import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import { MAX_BRIDGE_FRAME_BYTES } from '@deepseek-ai/dsh-browser-electron/protocol'
import { createBrowserBridge, type BrowserBridge } from '../src/browser-bridge.ts'
import type { BrowserGuestManager } from '../src/browser-guest.ts'

const bridges: BrowserBridge[] = []
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.dispose())) })

function manager(): BrowserGuestManager {
  return {
    prepare: vi.fn(async () => ({ kind: 'none' as const })),
    execute: vi.fn(async () => { throw new Error('unconfigured execute') }),
    control: vi.fn(async () => null),
    close: vi.fn(async () => null),
    lease: vi.fn(async () => null),
    release: vi.fn(async () => null),
    present: vi.fn(),
    dispose: vi.fn(async () => undefined),
  }
}

async function connect(url: string, token: string): Promise<WebSocket> {
  const client = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } })
  await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
  return client
}

function closed(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise((resolve) => { client.once('close', () => { resolve() }) })
}

function json(data: RawData): unknown {
  const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
  return JSON.parse(bytes.toString('utf8')) as unknown
}

describe('desktop browser private bridge', () => {
  it('只接受精确回环路径、bearer，并且一个 epoch 只认领一次连接', async () => {
    const bridge = await createBrowserBridge()
    bridges.push(bridge)
    const owner = manager()
    bridge.attach(owner)
    expect(bridge.origin).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/browser-bridge$/)
    expect(bridge.token).toMatch(/^[a-f0-9]{64}$/)
    await expect(connect(bridge.origin, '0'.repeat(64))).rejects.toThrow()
    await expect(connect(`${bridge.origin}/wrong`, bridge.token)).rejects.toThrow()
    const client = await connect(bridge.origin, bridge.token)
    await expect(connect(bridge.origin, bridge.token)).rejects.toThrow()
    const response = new Promise<unknown>((resolve) => { client.once('message', (data) => { resolve(json(data)) }) })
    client.send(JSON.stringify({ v: 1, id: 'request-1', method: 'prepare', sessionId: 'session-1' }))
    await expect(response).resolves.toEqual({ v: 1, id: 'request-1', ok: true, value: { kind: 'none' } })
    const leased = new Promise<unknown>((resolve) => { client.once('message', (data) => { resolve(json(data)) }) })
    client.send(JSON.stringify({ v: 1, id: 'request-2', method: 'lease', sessionId: 'session-1' }))
    await expect(leased).resolves.toEqual({ v: 1, id: 'request-2', ok: true, value: null })
    client.close()
    await closed(client)
    await vi.waitFor(() => { expect(vi.mocked(owner).close.mock.calls).toEqual([['session-1']]) })
    expect(vi.mocked(owner).release.mock.calls).toEqual([['session-1']])
    await expect(connect(bridge.origin, bridge.token)).rejects.toThrow()
  })

  it('拒绝超限和未知方法，且不将任意命令送进 guest', async () => {
    const bridge = await createBrowserBridge()
    bridges.push(bridge)
    const owner = manager()
    bridge.attach(owner)
    const client = await connect(bridge.origin, bridge.token)
    client.send(JSON.stringify({ v: 1, id: 'bad', method: 'evaluate', sessionId: 'session-1', command: { script: '1' } }))
    await closed(client)
    expect(vi.mocked(owner).execute.mock.calls).toHaveLength(0)
    expect(vi.mocked(owner).control.mock.calls).toHaveLength(0)
    const next = await createBrowserBridge()
    bridges.push(next)
    const nextOwner = manager()
    next.attach(nextOwner)
    const oversized = await connect(next.origin, next.token)
    oversized.send('x'.repeat(MAX_BRIDGE_FRAME_BYTES + 1))
    await closed(oversized)
    expect(vi.mocked(nextOwner).execute.mock.calls).toHaveLength(0)
  })

  it('状态事件保持有界 wire shape，且不包含令牌', async () => {
    const bridge = await createBrowserBridge()
    bridges.push(bridge)
    const client = await connect(bridge.origin, bridge.token)
    const event = new Promise<unknown>((resolve) => { client.once('message', (data) => { resolve(json(data)) }) })
    bridge.publish('session-1', null)
    await expect(event).resolves.toEqual({ v: 1, type: 'state', sessionId: 'session-1', state: null })
    client.close()
    await closed(client)
  })

  it('同一操作的状态事件先于响应，断线后旧请求不能重新认领 epoch', async () => {
    const bridge = await createBrowserBridge()
    bridges.push(bridge)
    const owner = manager()
    vi.mocked(owner).control.mockImplementationOnce(async (sessionId) => {
      bridge.publish(sessionId, null)
      return null
    })
    bridge.attach(owner)
    const client = await connect(bridge.origin, bridge.token)
    const frames: unknown[] = []
    const two = new Promise<void>((resolve) => {
      client.on('message', (data) => { frames.push(json(data)); if (frames.length === 2) resolve() })
    })
    client.send(JSON.stringify({ v: 1, id: 'control-1', method: 'control', sessionId: 'session-1',
      command: { kind: 'ensure-tab' } }))
    await two
    expect(frames).toEqual([
      { v: 1, type: 'state', sessionId: 'session-1', state: null },
      { v: 1, id: 'control-1', ok: true, value: null },
    ])
    client.close()
    await closed(client)
    await expect(connect(bridge.origin, bridge.token)).rejects.toThrow()
  })
})
