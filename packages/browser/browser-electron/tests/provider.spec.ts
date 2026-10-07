import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { BrowserUseError } from '@deepseek-ai/dsh-browser'
import type { BrowserSessionState } from '@deepseek-ai/dsh-browser'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import ElectronBrowserUse from '../src/index.ts'
import { decodeBridgePng, parseBridgeEvent, parseBridgeRequest, parseBridgeResponse } from '../src/protocol.ts'
import type { BridgeRequest } from '../src/protocol.ts'

const token = 'f'.repeat(64)
const id = SessionId('desktop-browser')
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
const observation = { tabId: 'tab-1', generation: 'page-1', revision: 1, url: 'about:blank', title: '',
  snapshot: '', viewport: { width: 1280, height: 720 }, cursor: null }
const state: BrowserSessionState = { operationActive: false, browserGeneration: 'browser-1', stateRevision: 1,
  viewport: observation.viewport, tabs: [{ id: observation.tabId as BrowserSessionState['tabs'][number]['id'],
    generation: observation.generation, url: observation.url, title: '', canGoBack: false, canGoForward: false }],
  activeTabId: observation.tabId as BrowserSessionState['activeTabId'], observation: observation as BrowserSessionState['observation'],
  hasFrame: true }

let cleanup: (() => Promise<void>) | undefined

async function fixture(respond?: (request: BridgeRequest, socket: WebSocket) => void,
  rejectToken = false): Promise<{
  provider: ElectronBrowserUse
  socket: () => WebSocket | undefined
  messages: BridgeRequest[]
  ctx: Context
}> {
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  const peers = new Set<WebSocket>()
  const messages: BridgeRequest[] = []
  server.on('upgrade', (req, stream, head) => {
    if (rejectToken || req.url !== '/browser-bridge' || req.headers.authorization !== `Bearer ${token}`) {
      stream.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return
    }
    wss.handleUpgrade(req, stream, head, (socket) => {
      peers.add(socket)
      socket.on('close', () => { peers.delete(socket) })
      socket.on('message', (frame) => {
        const request = parseBridgeRequest(JSON.parse(Buffer.from(frame as Buffer).toString('utf8')) as unknown)
        messages.push(request)
        respond?.(request, socket)
      })
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  process.env.DSH_DESKTOP_BROWSER_BRIDGE_ORIGIN = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/browser-bridge`
  process.env.DSH_DESKTOP_BROWSER_BRIDGE_TOKEN = token
  const ctx = new Context()
  const fiber = ctx.plugin(ElectronBrowserUse, {
    originEnv: 'DSH_DESKTOP_BROWSER_BRIDGE_ORIGIN', tokenEnv: 'DSH_DESKTOP_BROWSER_BRIDGE_TOKEN',
  })
  await fiber.await()
  cleanup = async () => {
    await ctx.fiber.dispose()
    for (const peer of peers) peer.terminate()
    await new Promise<void>((resolve) => { wss.close(() => { resolve() }) })
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    delete process.env.DSH_DESKTOP_BROWSER_BRIDGE_ORIGIN
    delete process.env.DSH_DESKTOP_BROWSER_BRIDGE_TOKEN
  }
  return { provider: ctx.browserUse as ElectronBrowserUse, socket: () => [...peers][0], messages, ctx }
}

afterEach(async () => { await cleanup?.(); cleanup = undefined })

describe('desktop browser bridge', () => {
  it('rejects unauthenticated startup without exposing the token in errors', async () => {
    const { provider } = await fixture(undefined, true)
    await expect(provider.acquireOperation(id, new AbortController().signal)).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect(provider.state(id)).toBeUndefined()
  })

  it('validates complete wire messages and bounded PNG decoding', () => {
    expect(parseBridgeRequest({ v: 1, id: 'open', method: 'control', sessionId: id,
      command: { kind: 'open-url', url: 'https://example.com/' } }).command).toEqual({
      kind: 'open-url', url: 'https://example.com/',
    })
    for (const command of [{ kind: 'open-url' }, { kind: 'open-url', url: '' },
      { kind: 'open-url', url: 'https://example.com/', tabId: 'unexpected' }]) {
      expect(() => parseBridgeRequest({ v: 1, id: 'open', method: 'control', sessionId: id, command })).toThrow()
    }
    expect(() => parseBridgeRequest({ v: 1, id: 'open', method: 'execute', sessionId: id,
      command: { kind: 'open-url', url: 'https://example.com/' } })).toThrow()
    expect(() => parseBridgeRequest({ v: 1, id: 'x', method: 'execute', sessionId: id,
      command: { kind: 'click', ref: 'r', revision: -1 } })).toThrow()
    expect(() => parseBridgeResponse({ v: 1, id: 'x', ok: true, value: { observation, png: 'broken' } }, 'execute')).toThrow()
    expect(() => parseBridgeEvent({ v: 1, type: 'state', sessionId: id, state,
      capture: { observation: { ...observation, revision: 2 }, png } })).toThrow()
    expect(decodeBridgePng(png)).toHaveLength(8)
    expect(() => decodeBridgePng('a'.repeat(3_000_000))).toThrow()
  })

  it('receives exact result after lease and revokes cached frame on spontaneous navigation', async () => {
    const { provider, socket, messages } = await fixture((request, peer) => {
      if (request.method === 'lease' || request.method === 'release' || request.method === 'close') {
        peer.send(JSON.stringify({ v: 1, id: request.id, ok: true, value: null })); return
      }
      if (request.method === 'prepare') {
        peer.send(JSON.stringify({ v: 1, id: request.id, ok: true, value: { kind: 'tab',
          browserGeneration: 'browser-1', stateRevision: 1, tabId: 'tab-1', generation: 'page-1', url: 'about:blank' } })); return
      }
      peer.send(JSON.stringify({ v: 1, type: 'state', sessionId: id, state, capture: { observation, png } }))
      peer.send(JSON.stringify({ v: 1, id: request.id, ok: true, value: { observation, png } }))
    })
    const release = await provider.acquireOperation(id, new AbortController().signal)
    const target = await provider.prepareTarget(id, new AbortController().signal)
    const result = await provider.execute(id, { kind: 'navigate', url: 'https://example.com' },
      new AbortController().signal, target)
    expect(result.observation).toEqual(observation)
    expect(provider.latest(id)?.png).toHaveLength(8)
    expect(messages.find(message => message.method === 'execute')?.expectedTarget).toEqual(target)
    socket()?.send(JSON.stringify({ v: 1, type: 'state', sessionId: id, state: { ...state, operationActive: true } }))
    await vi.waitFor(() => { expect(provider.latest(id)?.png).toHaveLength(8) })
    socket()?.send(JSON.stringify({ v: 1, type: 'state', sessionId: id,
      state: { ...state, stateRevision: 2, hasFrame: false, observation: null } }))
    await vi.waitFor(() => { expect(provider.latest(id)).toBeUndefined() })
    expect(provider.state(id)?.stateRevision).toBe(2)
    release()
    await provider.closeSession(id)
    expect(messages.map(message => message.method)).toEqual(['lease', 'prepare', 'execute', 'release', 'close'])
    expect(provider.state(id)).toBeUndefined()
  })

  it('runs a human guard before sending control and fails closed on cancellation', async () => {
    const { provider, messages } = await fixture((request, peer) => {
      if (request.method === 'control') return
      peer.send(JSON.stringify({ v: 1, id: request.id, ok: true, value: null }))
    })
    await expect(provider.control(id, { kind: 'ensure-tab' }, new AbortController().signal,
      async () => { throw new BrowserUseError('guard rejected', 'BROWSER_DENIED') })).rejects.toMatchObject({ code: 'BROWSER_DENIED' })
    expect(messages).toHaveLength(0)
    const controller = new AbortController()
    const pending = provider.control(id, { kind: 'ensure-tab' }, controller.signal)
    await vi.waitFor(() => { expect(messages).toHaveLength(1) })
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    await expect(provider.control(id, { kind: 'ensure-tab' }, new AbortController().signal)).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
  })

  it('invalidates all sessions on malformed frame or disconnect', async () => {
    const { provider, socket, messages } = await fixture()
    const pending = provider.control(id, { kind: 'ensure-tab' }, new AbortController().signal)
    await vi.waitFor(() => { expect(messages).toHaveLength(1) })
    socket()?.send('{broken')
    await expect(pending).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect(provider.state(id)).toBeUndefined()
  })

  it('fails closed on an out-of-order state revision', async () => {
    const { provider, socket, messages } = await fixture((request, peer) => {
      peer.send(JSON.stringify({ v: 1, type: 'state', sessionId: id, state, capture: { observation, png } }))
      peer.send(JSON.stringify({ v: 1, id: request.id, ok: true, value: state }))
    })
    await provider.control(id, { kind: 'ensure-tab' }, new AbortController().signal)
    await vi.waitFor(() => { expect(messages).toHaveLength(1) })
    expect(provider.state(id)?.stateRevision).toBe(1)
    socket()?.send(JSON.stringify({ v: 1, type: 'state', sessionId: id, state: { ...state, stateRevision: 3 } }))
    await vi.waitFor(() => { expect(provider.state(id)?.stateRevision).toBe(3) })
    socket()?.send(JSON.stringify({ v: 1, type: 'state', sessionId: id, state: { ...state, stateRevision: 0 } }))
    await vi.waitFor(() => { expect(provider.state(id)).toBeUndefined() })
    await expect(provider.closeSession(id)).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
  })

  it('returns the newer same-tab event state when it arrives before a successful control response', async () => {
    const newer: BrowserSessionState = { ...state, stateRevision: 2, hasFrame: false,
      observation: { ...state.observation!, revision: 2, title: 'Updated', snapshot: 'Updated DOM' },
      tabs: [{ ...state.tabs[0]!, title: 'Updated' }] }
    const { provider } = await fixture((request, peer) => {
      peer.send(JSON.stringify({ v: 1, type: 'state', sessionId: id, state: newer }))
      peer.send(JSON.stringify({ v: 1, id: request.id, ok: true, value: state }))
    })
    await expect(provider.control(id, { kind: 'navigate', url: 'https://example.com/' },
      new AbortController().signal)).resolves.toEqual(newer)
    expect(provider.state(id)).toEqual(newer)
    expect(provider.latest(id)).toBeUndefined()
  })

  it('acknowledges open-url only with its new tab when a newer event precedes the response', async () => {
    const openedTab = { ...state.tabs[0]!, id: 'tab-2' as BrowserSessionState['tabs'][number]['id'],
      generation: 'page-2', url: 'https://example.com/' }
    const openedObservation = { ...observation, tabId: openedTab.id, generation: openedTab.generation,
      url: openedTab.url }
    const opened: BrowserSessionState = { ...state, stateRevision: 2, tabs: [...state.tabs, openedTab],
      activeTabId: openedTab.id, observation: openedObservation }
    const newer: BrowserSessionState = { ...opened, stateRevision: 3, hasFrame: false,
      observation: { ...openedObservation, revision: 2, title: 'New title' } }
    const { provider } = await fixture((request, peer) => {
      if (request.command?.kind === 'open-url') {
        peer.send(JSON.stringify({ v: 1, type: 'state', sessionId: id, state: newer }))
        peer.send(JSON.stringify({ v: 1, id: request.id, ok: true, value: opened }))
      } else {
        peer.send(JSON.stringify({ v: 1, type: 'state', sessionId: id, state }))
        peer.send(JSON.stringify({ v: 1, id: request.id, ok: true, value: state }))
      }
    })
    await provider.control(id, { kind: 'ensure-tab' }, new AbortController().signal)
    await expect(provider.control(id, { kind: 'open-url', url: openedTab.url },
      new AbortController().signal)).resolves.toEqual(newer)
    expect(provider.state(id)).toEqual(newer)
  })

  it('does not acknowledge an unrelated active tab as the result of open-url', async () => {
    const openedTab = { ...state.tabs[0]!, id: 'tab-2' as BrowserSessionState['tabs'][number]['id'] }
    const otherTab = { ...state.tabs[0]!, id: 'tab-3' as BrowserSessionState['tabs'][number]['id'] }
    const opened: BrowserSessionState = { ...state, stateRevision: 2, tabs: [...state.tabs, openedTab, otherTab],
      activeTabId: openedTab.id, observation: { ...observation, tabId: openedTab.id } }
    const newer: BrowserSessionState = { ...opened, stateRevision: 3, activeTabId: otherTab.id,
      observation: { ...observation, tabId: otherTab.id } }
    const { provider } = await fixture((request, peer) => {
      peer.send(JSON.stringify({ v: 1, type: 'state', sessionId: id, state: newer }))
      peer.send(JSON.stringify({ v: 1, id: request.id, ok: true, value: opened }))
    })
    await expect(provider.control(id, { kind: 'open-url', url: 'https://example.com/' },
      new AbortController().signal)).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(provider.state(id)).toEqual(newer)
  })

  it('does not resurrect a session closed before a successful control response', async () => {
    const { provider } = await fixture((request, peer) => {
      peer.send(JSON.stringify({ v: 1, type: 'state', sessionId: id, state: null }))
      peer.send(JSON.stringify({ v: 1, id: request.id, ok: true, value: state }))
    })
    await expect(provider.control(id, { kind: 'ensure-tab' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(provider.state(id)).toBeUndefined()
  })

  it('rejects a response from a replaced browser generation', async () => {
    const replacement: BrowserSessionState = { ...state, browserGeneration: 'browser-2', stateRevision: 2 }
    const { provider } = await fixture((request, peer) => {
      peer.send(JSON.stringify({ v: 1, type: 'state', sessionId: id, state: replacement }))
      peer.send(JSON.stringify({ v: 1, id: request.id, ok: true, value: state }))
    })
    await expect(provider.control(id, { kind: 'ensure-tab' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    expect(provider.state(id)).toEqual(replacement)
  })

  it('rejects a pending operation when the main process disconnects', async () => {
    const { provider, socket, messages } = await fixture()
    const pending = provider.control(id, { kind: 'ensure-tab' }, new AbortController().signal)
    await vi.waitFor(() => { expect(messages).toHaveLength(1) })
    socket()?.terminate()
    await expect(pending).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect(provider.state(id)).toBeUndefined()
  })
})
