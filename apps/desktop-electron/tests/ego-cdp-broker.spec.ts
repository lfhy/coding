import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { createEgoCdpBroker, type EgoCdpBroker, type EgoHostedPage, type EgoPageHost } from '../src/ego-cdp-broker.ts'
import type { EgoDownloadEvent } from '../src/ego-page-host.ts'

/** 记录页面事件与命令的假页面；身份必须是稳定对象，broker 用它比较会话归属。 */
function fakePage(contextId: string, index: number, onClose: (targetId: string) => void) {
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  const page = {
    targetId: `target-${index}`, contextId,
    send: vi.fn(async (method: string) => ({ echoed: method })),
    onEvent: (listener: (method: string, params: Record<string, unknown>) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close: vi.fn(() => { onClose(page.targetId) }),
    describe: () => ({ url: 'https://example.test/', title: `page-${index}` }),
    emit: (method: string, params: Record<string, unknown>) => { for (const listener of [...listeners]) listener(method, params) },
    listenerCount: () => listeners.size,
  }
  return page
}

interface FakePage extends EgoHostedPage {
  emit(method: string, params: Record<string, unknown>): void
  listenerCount(): number
}

interface FakeHost extends EgoPageHost {
  pages: Map<string, FakePage>
  downloads: { contextId: string | undefined; settings: { behavior: string; downloadPath?: string } }[]
  emitDownload(event: EgoDownloadEvent): void
  cookies: Map<string, Record<string, unknown>[]>
  createPage: (contextId: string, url: string) => Promise<EgoHostedPage>
}

function createFakeHost(limit = Number.POSITIVE_INFINITY): FakeHost {
  const pages = new Map<string, FakePage>()
  const contexts = new Set<string>(['desktop-default'])
  const cookies = new Map<string, Record<string, unknown>[]>()
  const downloads: FakeHost['downloads'] = []
  const downloadListeners = new Set<(event: EgoDownloadEvent) => void>()
  let counter = 0
  const host: FakeHost = {
    pages, cookies, downloads,
    emitDownload(event: EgoDownloadEvent) { for (const listener of [...downloadListeners]) listener(event) },
    onDownload(listener) {
      downloadListeners.add(listener)
      return () => { downloadListeners.delete(listener) }
    },
    setDownloadBehavior(contextId, settings) {
      downloads.push({ contextId, settings: { behavior: settings.behavior,
        ...settings.downloadPath === undefined ? {} : { downloadPath: settings.downloadPath } } })
    },
    list: () => [...pages.values()],
    find: (targetId: string) => pages.get(targetId),
    defaultContext: () => 'desktop-default',
    createContext: () => { const id = `context-${contexts.size}`; contexts.add(id); return id },
    disposeContext(contextId: string) {
      for (const page of [...pages.values()]) if (page.contextId === contextId) pages.delete(page.targetId)
    },
    async createPage(contextId: string, url: string) {
      if (pages.size >= limit) throw new Error('page limit reached')
      const page = fakePage(contextId, counter++, (targetId) => { pages.delete(targetId) })
      const located = { ...page, describe: () => ({ url, title: `page-${counter}` }) }
      pages.set(page.targetId, located)
      return located
    },
    async getCookies(contextId) {
      return cookies.get(contextId ?? 'desktop-default') ?? []
    },
    async setCookies(contextId, value) {
      cookies.set(contextId, value)
    },
  }
  return host
}

interface Client {
  call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>
  raw(text: string): void
  messages: Record<string, unknown>[]
  close(): void
}

function connect(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false })
    const messages: Record<string, unknown>[] = []
    const pending = new Map<number, (value: Record<string, unknown>) => void>()
    let nextId = 1
    socket.on('message', (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8')
        : Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : Buffer.from(raw).toString('utf8')
      const message = JSON.parse(text) as Record<string, unknown>
      messages.push(message)
      const id = message.id
      if (typeof id === 'number') { pending.get(id)?.(message); pending.delete(id) }
    })
    socket.on('error', reject)
    socket.on('open', () => {
      resolve({
        messages,
        raw: (text) => { socket.send(text) },
        call(method, params = {}, sessionId) {
          const id = nextId++
          return new Promise((settle) => {
            pending.set(id, settle)
            socket.send(JSON.stringify({ id, method, params, ...sessionId === undefined ? {} : { sessionId } }))
          })
        },
        close: () => { socket.close() },
      })
    })
  })
}

const live: { broker: EgoCdpBroker | undefined; clients: Client[] } = { broker: undefined, clients: [] }

async function start(host: FakeHost) {
  const broker = await createEgoCdpBroker(host)
  live.broker = broker
  const client = await connect(broker.url)
  live.clients.push(client)
  return { broker, client }
}

afterEach(async () => {
  for (const client of live.clients) client.close()
  live.clients = []
  await live.broker?.close()
  live.broker = undefined
})

describe('桌面 Agent 页面的虚拟 CDP 端点', () => {
  it('按会话建立页面、会话与关闭，并把命令转发到页面自身', async () => {
    const host = createFakeHost()
    const { client } = await start(host)
    const context = await client.call('Target.createBrowserContext')
    const browserContextId = context.result as { browserContextId: string }
    expect(browserContextId.browserContextId).toBe('context-1')
    const created = await client.call('Target.createTarget',
      { url: 'https://example.test/a', browserContextId: browserContextId.browserContextId })
    const { targetId } = created.result as { targetId: string }
    const targets = await client.call('Target.getTargets')
    const infos = (targets.result as {
      targetInfos: { targetId: string; url: string; browserContextId: string; attached: boolean }[]
    }).targetInfos
    expect(infos).toEqual([{ targetId, type: 'page', title: 'page-1', url: 'https://example.test/a',
      attached: false, browserContextId: browserContextId.browserContextId }])
    const attached = await client.call('Target.attachToTarget', { targetId, flatten: true })
    const { sessionId } = attached.result as { sessionId: string }
    expect(sessionId).toHaveLength(32)
    const forwarded = await client.call('Runtime.evaluate', { expression: '1 + 1' }, sessionId)
    expect(forwarded.result).toEqual({ echoed: 'Runtime.evaluate' })
    expect(forwarded.sessionId).toBe(sessionId)
    const closed = await client.call('Target.closeTarget', { targetId })
    expect(closed).toMatchObject({ result: { success: true } })
    expect(host.pages.size).toBe(0)
    const after = await client.call('Target.getTargets')
    expect((after.result as { targetInfos: unknown[] }).targetInfos).toEqual([])
  })

  it('页面事件只回传给建立过会话的连接', async () => {
    const host = createFakeHost()
    const { client } = await start(host)
    const created = await client.call('Target.createTarget', { url: 'about:blank' })
    const { targetId } = created.result as { targetId: string }
    const attached = await client.call('Target.attachToTarget', { targetId, flatten: true })
    const { sessionId } = attached.result as { sessionId: string }
    host.pages.get(targetId)!.emit('Page.loadEventFired', { timestamp: 1 })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    const event = client.messages.at(-1)
    expect(event).toEqual({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId })
    await client.call('Target.detachFromTarget', { sessionId })
    host.pages.get(targetId)!.emit('Page.loadEventFired', { timestamp: 2 })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(client.messages.at(-1)?.method).toBeUndefined()
    expect(host.pages.get(targetId)!.listenerCount()).toBe(0)
  })

  it('Cookie 读写落在上下文而不是页面上', async () => {
    const host = createFakeHost()
    const { client } = await start(host)
    const empty = await client.call('Storage.getCookies')
    expect(empty.result).toEqual({ cookies: [] })
    const written = await client.call('Storage.setCookies', { browserContextId: 'context-9', cookies: [{ name: 'sid', value: 'x' }] })
    expect(written.result).toEqual({})
    expect(host.cookies.get('context-9')).toEqual([{ name: 'sid', value: 'x' }])
    const invalid = await client.call('Storage.setCookies', { cookies: 'nope' })
    expect((invalid.error as { code: number }).code).toBe(-32602)
  })

  it('拒绝未知方法、未知会话与非法参数', async () => {
    const host = createFakeHost()
    const { client } = await start(host)
    const unknown = await client.call('Target.createBrowserContextX')
    expect((unknown.error as { message: string }).message).toContain('unsupported browser method')
    const missing = await client.call('Runtime.evaluate', { expression: '1' }, 'a'.repeat(32))
    expect((missing.error as { message: string }).message).toBe('unknown session id')
    const created = await client.call('Target.createTarget', { url: 'javascript:alert(1)' })
    expect((created.error as { message: string }).message).toBe('unsupported target url')
    const missingTarget = await client.call('Target.attachToTarget', { targetId: 'nope' })
    expect((missingTarget.error as { message: string }).message).toBe('no such target')
    const noTargetId = await client.call('Target.attachToTarget', {})
    expect((noTargetId.error as { message: string }).message).toBe('invalid targetId')
    const attach = await client.call('Target.createTarget', { url: 'about:blank' })
    const attached = await client.call('Target.attachToTarget', { targetId: (attach.result as { targetId: string }).targetId })
    expect((attached.error as { message: string }).message).toBe('flatten is required')
    const closeMissing = await client.call('Target.closeTarget', { targetId: 'nope' })
    expect((closeMissing.error as { message: string }).message).toBe('no such target')
    const weird = await client.call('Browser.getWindowForTarget', { targetId: 'x' })
    expect(weird.result).toEqual({ windowId: 1, bounds: { left: 0, top: 0, width: 0, height: 0, windowState: 'normal' } })
    expect((await client.call('Browser.setWindowBounds', { windowId: 1 })).result).toEqual({})
    expect((await client.call('Target.setDiscoverTargets', { discover: true })).result).toEqual({})
    expect((await client.call('Target.activateTarget', { targetId: (attach.result as { targetId: string }).targetId })).result).toEqual({})
  })

  it('非法消息断开连接，页面数超过上限时拒绝建页', async () => {
    const host = createFakeHost(1)
    const { client } = await start(host)
    await client.call('Target.createTarget', { url: 'about:blank' })
    const rejected = await client.call('Target.createContextLater')
    expect((rejected.error as { code: number }).code).toBe(-32601)
    const overflow = await client.call('Target.createTarget', { url: 'about:blank' })
    expect((overflow.error as { message: string }).message).toBe('page limit reached')
    client.raw('not json')
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    const last = client.messages.at(-1) as { id: number; error: { message: string } }
    expect(last.id).toBe(0)
    expect(last.error.message).toBe('invalid CDP message')
  })

  it('只有携带路径令牌的回环连接才能建立', async () => {
    const host = createFakeHost()
    const { broker } = await start(host)
    const wrong = broker.url.replace('/ego-cdp/', '/ego-cdp/').replace(/[a-f0-9]{8}$/u, 'deadbeef')
    await expect(new Promise((resolve, reject) => {
      const socket = new WebSocket(wrong)
      socket.on('open', () => { resolve('open') })
      socket.on('error', reject)
    })).rejects.toThrow(/403/u)
  })
})

describe('桌面下载', () => {
  it('浏览器级与页面级下载设置都落到页面宿主，并把下载翻译成页面事件', async () => {
    const host = createFakeHost()
    const { client } = await start(host)
    await client.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp/downloads', eventsEnabled: true })
    expect(host.downloads.at(-1)).toEqual({
      contextId: undefined, settings: { behavior: 'allow', downloadPath: '/tmp/downloads' },
    })
    const created = await client.call('Target.createTarget', { url: 'about:blank' })
    const attached = await client.call('Target.attachToTarget',
      { targetId: (created.result as { targetId: string }).targetId, flatten: true })
    const sessionId = (attached.result as { sessionId: string }).sessionId
    await client.call('Page.setDownloadBehavior', { behavior: 'deny', downloadPath: '/tmp/denied' }, sessionId)
    expect(host.downloads.at(-1)).toEqual({
      contextId: 'desktop-default', settings: { behavior: 'deny', downloadPath: '/tmp/denied' },
    })
    const record = { id: 'guid-1', contextId: 'desktop-default', filename: 'file.zip',
      path: '/tmp/file.zip', url: 'https://example.test/file.zip', state: 'progressing' as const,
      receivedBytes: 0, totalBytes: 8, startedAt: 1 }
    host.emitDownload({ kind: 'begin', record })
    host.emitDownload({ kind: 'progress', record: { ...record, state: 'completed', receivedBytes: 4 } })
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    const events = client.messages.filter(message => message.method === 'Page.downloadWillBegin'
      || message.method === 'Page.downloadProgress')
    expect(events).toEqual([
      { method: 'Page.downloadWillBegin', params: { frameId: 'guid-1', guid: 'guid-1',
        url: 'https://example.test/file.zip', suggestedFilename: 'file.zip' } },
      { method: 'Page.downloadProgress', params: { guid: 'guid-1', totalBytes: 8, receivedBytes: 4,
        state: 'completed' } },
    ])
  })

  it('其它上下文的下载不会发给本连接', async () => {
    const host = createFakeHost()
    const { client } = await start(host)
    const created = await client.call('Target.createTarget', { url: 'about:blank' })
    await client.call('Target.attachToTarget',
      { targetId: (created.result as { targetId: string }).targetId, flatten: true })
    host.emitDownload({ kind: 'begin', record: { id: 'guid-2', contextId: 'other-context',
      filename: 'other.bin', path: '/tmp/other.bin', url: 'https://example.test/other',
      state: 'progressing', receivedBytes: 0, totalBytes: 1, startedAt: 1 } })
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(client.messages.some(message => message.method === 'Page.downloadWillBegin')).toBe(false)
  })
})
