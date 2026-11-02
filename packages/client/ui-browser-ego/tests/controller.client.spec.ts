import { describe, expect, it, vi } from 'vitest'
import { BrowserEgoController } from '../src/client/controller.ts'

const first = { targetId: 'first', title: 'First', url: 'https://example.com/', active: true,
  viewportW: 400, viewportH: 300, humanCheck: false }
const second = { ...first, targetId: 'second', title: 'Second', active: false }

class FakeStream extends EventTarget {
  closed = false
  constructor(readonly url: string) { super() }
  emit(name: string, payload: unknown): void {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(payload) }))
  }
  close(): void { this.closed = true }
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

function overview(url: string): Response | null {
  if (url.startsWith('/api/ego/status')) {
    return Response.json({ ok: true, running: true, browserConnected: true, spaces: 2 })
  }
  if (url.startsWith('/api/ego/history')) return Response.json({ ok: true, actions: [] })
  return null
}

function fixture(fetcher: Fetcher = vi.fn(async (url: string) => overview(url)
  ?? Response.json({ ok: true, spaces: [first, second] }))) {
  const streams: FakeStream[] = []
  const activities: FakeStream[] = []
  const controller = new BrowserEgoController('session-one', fetcher,
    (url) => { const stream = new FakeStream(url); streams.push(stream); return stream as unknown as EventSource },
    (url) => { const stream = new FakeStream(url); activities.push(stream); return stream as unknown as EventSource })
  return { controller, fetcher, streams, activities }
}

describe('会话画面与人工输入', () => {
  it('只在可见期间连接同一会话的目录和 SSE，隐藏后丢弃旧事件', async () => {
    const { controller, fetcher, streams } = fixture(vi.fn(async (url: string) => url.startsWith('/api/ego/frame?')
      ? new Response(null, { status: 404 }) : Response.json({ ok: true, spaces: [first, second] })))
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().phase).toBe('ready') })
    expect(fetcher).toHaveBeenCalledWith('/api/ego/spaces?sessionId=session-one', expect.any(Object))
    expect(streams[0]?.url).toBe('/api/ego/stream?sessionId=session-one')
    streams[0]?.emit('frame', { targetId: 'other', data: 'YWJj', vw: 400, vh: 300, ts: 1 })
    expect(controller.view.getSnapshot().frame).toBeNull()
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 1 })
    expect(controller.view.getSnapshot().frame?.targetId).toBe('first')
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 0 })
    expect(controller.view.getSnapshot().frame?.ts).toBe(1)
    streams[0]?.emit('spaces', [first, { ...second, active: true }])
    // 活动页变化不抢走用户正在查看的旧页；仍可从服务端请求该页最新画面。
    expect(controller.view.getSnapshot().selectedId).toBe('first')
    expect(controller.view.getSnapshot().frame?.targetId).toBe('first')
    controller.show(false)
    expect(streams[0]?.closed).toBe(true)
    streams[0]?.emit('spaces', [first])
    expect(controller.view.getSnapshot().pages).toEqual([])
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().phase).toBe('ready') })
    expect(streams[1]?.url).toBe('/api/ego/stream?sessionId=session-one')
    controller.show(false)
  })

  it('只读取当前会话画面上的网页悬停，隐藏后忽略晚到响应', async () => {
    let resolveHover: ((response: Response) => void) | undefined
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/ego/hover') return await new Promise<Response>((resolve) => { resolveHover = resolve })
      if (url.startsWith('/api/ego/frame?')) return new Response(null, { status: 404 })
      return overview(url) ?? Response.json({ ok: true, spaces: [first, second] })
    })
    const { controller, streams } = fixture(fetcher)
    controller.show(true, 'first')
    await vi.waitFor(() => { expect(controller.view.getSnapshot().phase).toBe('ready') })
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 1 })
    expect(await controller.hover('second', 5, 10)).toBeNull()
    const reading = controller.hover('first', 5, 10)
    await vi.waitFor(() => { expect(resolveHover).toBeDefined() })
    expect(fetcher).toHaveBeenCalledWith('/api/ego/hover', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'session-one', targetId: 'first', x: 5, y: 10 }),
    }))
    controller.show(false, 'first')
    resolveHover?.(Response.json({ ok: true, targetId: 'first', cursor: 'pointer', title: 'Link', href: 'https://example.com/' }))
    expect(await reading).toBeNull()
  })

  it('多个视图共用会话流，切换页面丢弃旧帧，最后一个视图隐藏才断开', async () => {
    const { controller, streams, activities } = fixture(vi.fn(async (url: string) =>
      url.startsWith('/api/ego/frame?') ? new Response(null, { status: 404 })
        : overview(url) ?? Response.json({ ok: true, spaces: [first, second] })))
    controller.show(true, 'first')
    await vi.waitFor(() => { expect(controller.view.getSnapshot().selectedId).toBe('first') })
    expect(streams).toHaveLength(1)
    expect(activities).toHaveLength(1)
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 1 })
    expect(controller.view.getSnapshot().frame?.targetId).toBe('first')

    controller.show(true, 'second')
    expect(controller.view.getSnapshot().selectedId).toBe('second')
    expect(controller.view.getSnapshot().frame).toBeNull()
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 2 })
    expect(controller.view.getSnapshot().frame).toBeNull()
    streams[0]?.emit('frame', { targetId: 'second', data: 'YWJj', vw: 400, vh: 300, ts: 3 })
    expect(controller.view.getSnapshot().frame?.targetId).toBe('second')
    controller.show(false, 'second')
    expect(controller.view.getSnapshot().selectedId).toBe('first')
    expect(controller.view.getSnapshot().frame).toBeNull()
    expect(streams).toHaveLength(1)
    expect(activities).toHaveLength(1)
    expect(streams[0]?.closed).toBe(false)
    expect(activities[0]?.closed).toBe(false)
    controller.show(false, 'first')
    expect(streams[0]?.closed).toBe(true)
    expect(activities[0]?.closed).toBe(true)
    expect(controller.view.getSnapshot().pages).toEqual([])
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 4 })
    expect(controller.view.getSnapshot().frame).toBeNull()
  })

  it('保持更新 SSE 列表的权威性，并拒绝目标外、画面外或隐藏时人工输入', async () => {
    const { controller, fetcher, streams } = fixture(vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === '/api/ego/input') return Response.json({ ok: true })
      if (url.startsWith('/api/ego/frame?')) return new Response(null, { status: 404 })
      return Response.json({ ok: true, spaces: [first, second] })
    }))
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().phase).toBe('ready') })
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 1 })
    const click = { type: 'mousePressed', x: 12, y: 15, button: 'left', buttons: 1, clickCount: 1 } as const
    expect(await controller.send('other', click)).toBe(false)
    expect(await controller.send('first', { ...click, x: 400 })).toBe(false)
    expect(await controller.send('first', click)).toBe(true)
    expect(fetcher).toHaveBeenCalledWith('/api/ego/input', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'session-one', targetId: 'first', ...click }),
    }))
    expect(await controller.send('first', { ...click, type: 'mouseReleased', buttons: 0 })).toBe(true)
    streams[0]?.emit('spaces', [second])
    expect(controller.view.getSnapshot().frame).toBeNull()
    expect(await controller.send('first', click)).toBe(false)
    controller.show(false)
    expect(await controller.send('first', click)).toBe(false)
  })

  it('连续输入保持画面可聚焦，按顺序投递点击和文字', async () => {
    const pending: Array<() => void> = []
    const sent: string[] = []
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/ego/input') {
        const payload = JSON.parse(init?.body as string) as { type: string; text?: string }
        sent.push(payload.text ?? payload.type)
        return new Promise<Response>((resolve) => { pending.push(() => { resolve(Response.json({ ok: true })) }) })
      }
      return Promise.resolve(url.startsWith('/api/ego/frame?')
        ? new Response(null, { status: 404 }) : overview(url) ?? Response.json({ ok: true, spaces: [first] }))
    })
    const { controller, streams } = fixture(fetcher)
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().selectedId).toBe('first') })
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 1 })
    const down = controller.send('first', { type: 'mousePressed', x: 12, y: 15, button: 'left', buttons: 1, clickCount: 1 })
    const up = controller.send('first', { type: 'mouseReleased', x: 12, y: 15, button: 'left', buttons: 0, clickCount: 1 })
    const text = controller.send('first', { type: 'insertText', text: 'Hi' })
    expect(controller.view.getSnapshot().pending).toBe(false)
    await vi.waitFor(() => { expect(sent).toEqual(['mousePressed']) })
    pending.shift()?.()
    expect(await down).toBe(true)
    await vi.waitFor(() => { expect(sent).toEqual(['mousePressed', 'mouseReleased']) })
    pending.shift()?.()
    expect(await up).toBe(true)
    await vi.waitFor(() => { expect(sent).toEqual(['mousePressed', 'mouseReleased', 'Hi']) })
    pending.shift()?.()
    expect(await text).toBe(true)
    controller.show(false)
  })

  it('换页后取消未投递的旧页按键', async () => {
    let finish!: (value: Response) => void
    const fetcher = vi.fn((url: string) => url === '/api/ego/input'
      ? new Promise<Response>((resolve) => { finish = resolve })
      : Promise.resolve(url.startsWith('/api/ego/frame?')
        ? new Response(null, { status: 404 }) : overview(url) ?? Response.json({ ok: true, spaces: [first, second] })))
    const { controller, streams } = fixture(fetcher)
    controller.show(true, 'first')
    await vi.waitFor(() => { expect(controller.view.getSnapshot().selectedId).toBe('first') })
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 1 })
    const firstInput = controller.send('first', { type: 'insertText', text: 'first' })
    const oldInput = controller.send('first', { type: 'insertText', text: 'old' })
    await vi.waitFor(() => { expect(fetcher.mock.calls.filter(([path]) => path === '/api/ego/input')).toHaveLength(1) })
    controller.show(true, 'second')
    finish(Response.json({ ok: true }))
    expect(await firstInput).toBe(false)
    expect(await oldInput).toBe(false)
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/ego/input')).toHaveLength(1)
    controller.show(false, 'second')
    controller.show(false, 'first')
  })

  it('只允许当前可见且有匹配画面的页面发送白名单按键与文字', async () => {
    const fetcher = vi.fn(async (url: string) => url === '/api/ego/input'
      ? Response.json({ ok: true }) : url.startsWith('/api/ego/frame?')
        ? new Response(null, { status: 404 })
        : overview(url) ?? Response.json({ ok: true, spaces: [first, second] }))
    const { controller, streams } = fixture(fetcher)
    controller.show(true, 'first')
    await vi.waitFor(() => { expect(controller.view.getSnapshot().selectedId).toBe('first') })
    const key = { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 } as const
    expect(await controller.send('first', key)).toBe(false)
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/ego/input')).toHaveLength(0)
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 1 })
    for (const invalid of [
      { ...key, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
      { ...key, key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82 },
      { ...key, code: 'NumpadEnter' },
      { ...key, windowsVirtualKeyCode: 256 },
    ]) expect(await controller.send('first', invalid)).toBe(false)
    expect(await controller.send('first', { type: 'insertText', text: '' })).toBe(false)
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/ego/input')).toHaveLength(0)
    expect(await controller.send('first', key)).toBe(true)
    expect(await controller.send('first', { ...key, type: 'keyUp' })).toBe(true)
    expect(await controller.send('first', { type: 'insertText', text: '你好' })).toBe(true)
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/ego/input')).toHaveLength(3)
    expect(fetcher).toHaveBeenCalledWith('/api/ego/input', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ sessionId: 'session-one', targetId: 'first', ...key }),
    }))

    controller.show(true, 'second')
    expect(await controller.send('first', key)).toBe(false)
    expect(await controller.send('second', key)).toBe(false)
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 2 })
    expect(await controller.send('second', key)).toBe(false)
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/ego/input')).toHaveLength(3)
    controller.show(false, 'second')
    controller.show(false, 'first')
    expect(await controller.send('first', key)).toBe(false)
  })

  it('页面视口变更后拒绝旧帧坐标与按键，直到新尺寸画面到达', async () => {
    const fetcher = vi.fn(async (url: string) => url === '/api/ego/input'
      ? Response.json({ ok: true }) : url.startsWith('/api/ego/frame?')
        ? new Response(null, { status: 404 })
        : overview(url) ?? Response.json({ ok: true, spaces: [first] }))
    const { controller, streams } = fixture(fetcher)
    controller.show(true, 'first')
    await vi.waitFor(() => { expect(controller.view.getSnapshot().selectedId).toBe('first') })
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 1 })
    streams[0]?.emit('spaces', [{ ...first, viewportW: 600 }])
    expect(await controller.send('first', { type: 'insertText', text: 'a' })).toBe(false)
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/ego/input')).toHaveLength(0)
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 600, vh: 300, ts: 2 })
    expect(await controller.send('first', { type: 'insertText', text: 'a' })).toBe(true)
    controller.show(false, 'first')
  })

  it('忽略比实时流更旧的目录结果并保留最新画面', async () => {
    let resolve!: (value: Response) => void
    const fetcher = vi.fn((url: string) => {
      if (url.startsWith('/api/ego/frame?')) return Promise.resolve(new Response(null, { status: 404 }))
      if (url.startsWith('/api/ego/spaces')) return new Promise<Response>((done) => { resolve = done })
      return Promise.resolve(new Response(null, { status: 503 }))
    })
    const { controller, streams } = fixture(fetcher)
    controller.show(true)
    streams[0]?.emit('spaces', [first])
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 1 })
    resolve(Response.json({ ok: true, spaces: [second] }))
    await vi.waitFor(() => { expect(controller.view.getSnapshot().frame?.targetId).toBe('first') })
    expect(controller.view.getSnapshot().pages.map(page => page.targetId)).toEqual(['first'])
    controller.show(false)
  })

  it('手动选择非活动页并刷新单帧，拒绝迟到的旧页与隐藏画面', async () => {
    const replies: Array<(value: Response) => void> = []
    const fetcher = vi.fn((url: string, _init?: RequestInit) => url.startsWith('/api/ego/frame?')
      ? new Promise<Response>((done) => { replies.push(done) })
      : Promise.resolve(overview(url) ?? Response.json({ ok: true, spaces: [first, second] })))
    const { controller, streams } = fixture(fetcher)
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().pages).toHaveLength(2) })
    controller.select('second')
    expect(controller.view.getSnapshot().selectedId).toBe('second')
    expect(controller.view.getSnapshot().frame).toBeNull()
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith('/api/ego/frame?sessionId=session-one&targetId=second', expect.any(Object))
    })
    const firstReply = replies.at(-1)
    controller.select('first')
    firstReply?.(Response.json({ targetId: 'second', data: 'YWJj', vw: 400, vh: 300, ts: 3 }))
    await Promise.resolve()
    expect(controller.view.getSnapshot().frame?.targetId).not.toBe('second')
    controller.select('second')
    const selectedReply = replies.at(-1)
    selectedReply?.(Response.json({ targetId: 'second', data: 'YWJj', vw: 400, vh: 300, ts: 4 }))
    await vi.waitFor(() => { expect(controller.view.getSnapshot().frame?.targetId).toBe('second') })
    await controller.refresh()
    expect(fetcher).toHaveBeenCalledWith('/api/ego/frame?sessionId=session-one&targetId=second', expect.any(Object))
    const pending = replies.at(-1)
    controller.show(false)
    pending?.(Response.json({ targetId: 'second', data: 'YWJj', vw: 400, vh: 300, ts: 5 }))
    expect(controller.view.getSnapshot().frame).toBeNull()
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 6 })
    expect(controller.view.getSnapshot().pages).toEqual([])
  })

  it('拒绝跨页旧帧及视口不匹配的流和单帧，不让它们覆盖当前画面', async () => {
    const fetcher = vi.fn(async (url: string) => url.startsWith('/api/ego/frame?')
      ? Response.json({ targetId: 'second', data: 'YWJj', vw: 401, vh: 300, ts: 10 })
      : overview(url) ?? Response.json({ ok: true, spaces: [first, second] }))
    const { controller, streams } = fixture(fetcher)
    controller.show(true, 'first')
    await vi.waitFor(() => { expect(controller.view.getSnapshot().selectedId).toBe('first') })
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 1 })
    controller.show(true, 'second')
    expect(controller.view.getSnapshot().frame).toBeNull()
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith('/api/ego/frame?sessionId=session-one&targetId=second', expect.any(Object))
    })
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 11 })
    streams[0]?.emit('frame', { targetId: 'second', data: 'YWJj', vw: 401, vh: 300, ts: 12 })
    expect(controller.view.getSnapshot().frame).toBeNull()
    streams[0]?.emit('frame', { targetId: 'second', data: 'YWJj', vw: 400, vh: 301, ts: 13 })
    expect(controller.view.getSnapshot().frame).toBeNull()
    streams[0]?.emit('frame', { targetId: 'second', data: 'YWJj', vw: 400, vh: 300, ts: 2 })
    expect(controller.view.getSnapshot().frame?.ts).toBe(2)
    await controller.refresh()
    expect(controller.view.getSnapshot().frame?.ts).toBe(2)
    controller.show(false, 'second')
    controller.show(false, 'first')
  })

  it('只向本会话目录中的目标 POST 地址、后退、前进与刷新', async () => {
    const fetcher = vi.fn(async (url: string) => url === '/api/ego/navigation'
      ? Response.json({ ok: true }) : url.startsWith('/api/ego/frame?')
        ? new Response(null, { status: 404 })
        : overview(url) ?? Response.json({ ok: true, spaces: [first, second] }))
    const { controller } = fixture(fetcher)
    expect(await controller.navigate('first', 'reload')).toBe(false)
    controller.show(true, 'second')
    await vi.waitFor(() => { expect(controller.view.getSnapshot().selectedId).toBe('second') })
    const url = 'https://example.org/path?from=address'
    for (const [action, address] of [['navigate', url], ['back', undefined], ['forward', undefined],
      ['reload', undefined]] as const) {
      expect(await controller.navigate('second', action, address)).toBe(true)
      expect(fetcher).toHaveBeenCalledWith('/api/ego/navigation', expect.objectContaining({
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-one', targetId: 'second', action,
          ...(address === undefined ? {} : { url: address }) }),
      }))
    }
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/ego/navigation')).toHaveLength(4)
    expect(controller.view.getSnapshot().pending).toBe(false)
    controller.show(false, 'second')
  })

  it('拒绝未知、非法与跨会话目标，不能无目标导航已有页面', async () => {
    const fetcher = vi.fn(async (url: string) => url.startsWith('/api/ego/frame?')
      ? new Response(null, { status: 404 })
      : overview(url) ?? Response.json({ ok: true, spaces: [first] }))
    const { controller } = fixture(fetcher)
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().phase).toBe('ready') })
    for (const targetId of ['other-session-page', 'bad id', '']) {
      expect(await controller.navigate(targetId, 'navigate', 'https://example.org/')).toBe(false)
      expect(await controller.navigate(targetId, 'back')).toBe(false)
    }
    expect(await controller.navigate(undefined, 'navigate', 'https://example.org/')).toBe(false)
    expect(await controller.navigate(undefined, 'reload')).toBe(false)
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/ego/navigation')).toHaveLength(0)
    controller.show(false)
    expect(await controller.navigate('first', 'reload')).toBe(false)
  })

  it('空白会话仅向 Host 发送无 targetId 的新建导航，不能无目标前进后退或刷新', async () => {
    const fetcher = vi.fn(async (url: string) => url === '/api/ego/navigation'
      ? Response.json({ ok: true })
      : overview(url) ?? Response.json({ ok: true, spaces: [] }))
    const { controller } = fixture(fetcher)
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().phase).toBe('ready') })
    for (const action of ['back', 'forward', 'reload'] as const) {
      expect(await controller.navigate(undefined, action)).toBe(false)
    }
    expect(await controller.navigate('missing', 'navigate', 'https://example.org/')).toBe(false)
    expect(await controller.navigate(undefined, 'navigate', 'https://example.org/')).toBe(true)
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/ego/navigation')).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledWith('/api/ego/navigation', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ sessionId: 'session-one', action: 'navigate', url: 'https://example.org/' }),
    }))
    controller.show(false)
  })

  it('Host 拒绝非法地址或失败的历史导航时返回失败并解除等待', async () => {
    const fetcher = vi.fn(async (url: string) => url === '/api/ego/navigation'
      ? new Response(null, { status: 400 }) : url.startsWith('/api/ego/frame?')
        ? new Response(null, { status: 404 })
        : overview(url) ?? Response.json({ ok: true, spaces: [first] }))
    const { controller } = fixture(fetcher)
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().phase).toBe('ready') })
    expect(await controller.navigate('first', 'navigate', 'javascript:alert(1)')).toBe(false)
    expect(await controller.navigate('first', 'back')).toBe(false)
    expect(controller.view.getSnapshot().pending).toBe(false)
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/ego/navigation')).toHaveLength(2)
    controller.show(false)
  })

  it('读取运行状态与最近动作，状态不可用时保持中性', async () => {
    const { controller } = fixture(vi.fn(async (url: string) => {
      if (url.startsWith('/api/ego/status')) {
        return Response.json({ ok: true, running: false, browserConnected: false, spaces: 2 })
      }
      if (url.startsWith('/api/ego/history')) return Response.json({ ok: true, actions: [
        { tool: 'browser_navigate', at: 10 }, { tool: 'ego_captcha', at: 20 }, { tool: 'raw_unknown', at: 30 },
      ] })
      if (url.startsWith('/api/ego/frame?')) return new Response(null, { status: 404 })
      return Response.json({ ok: true, spaces: [first, second] })
    }))
    controller.show(true)
    await vi.waitFor(() => {
      expect(controller.view.getSnapshot().actions).toHaveLength(3)
      expect(controller.view.getSnapshot().status).not.toBeNull()
    })
    expect(controller.view.getSnapshot().status).toEqual({ running: false, browserConnected: false })
    expect(controller.view.getSnapshot().actions).toEqual([
      { kind: 'navigate', at: 10 }, { kind: 'verify', at: 20 }, { kind: 'other', at: 30 },
    ])
    controller.show(false)
  })

  it('状态接口不可用时只保留空状态', async () => {
    const { controller } = fixture(vi.fn(async (url: string) => {
      if (url.startsWith('/api/ego/status')) return new Response(null, { status: 503 })
      if (url.startsWith('/api/ego/history')) return new Response(null, { status: 503 })
      if (url.startsWith('/api/ego/frame?')) return new Response(null, { status: 404 })
      return Response.json({ ok: true, spaces: [first] })
    }))
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().phase).toBe('ready') })
    expect(controller.view.getSnapshot().status).toBeNull()
    expect(controller.view.getSnapshot().actions).toEqual([])
    controller.show(false)
  })

  it('关闭页面成功后刷新目录，失败或未知目标不改动列表', async () => {
    let spacesCalls = 0
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/ego/close') return Response.json({ ok: true })
      if (url.startsWith('/api/ego/frame?')) return new Response(null, { status: 404 })
      const status = overview(url)
      if (status !== null) return status
      spacesCalls += 1
      return Response.json({ ok: true, spaces: spacesCalls === 1 ? [first, second] : [first] })
    })
    const { controller } = fixture(fetcher)
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().pages).toHaveLength(2) })
    expect(await controller.close('second')).toBe(true)
    expect(fetcher).toHaveBeenCalledWith('/api/ego/close', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ sessionId: 'session-one', targetId: 'second' }),
    }))
    expect(controller.view.getSnapshot().pages.map(page => page.targetId)).toEqual(['first'])
    expect(controller.view.getSnapshot().closing).toBeNull()
    expect(await controller.close('missing')).toBe(false)
    controller.show(false)
  })

  it('关闭失败时保留页面并结束关闭状态', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/ego/close') return Response.json({ ok: false }, { status: 503 })
      if (url.startsWith('/api/ego/frame?')) return new Response(null, { status: 404 })
      return overview(url) ?? Response.json({ ok: true, spaces: [first, second] })
    })
    const { controller } = fixture(fetcher)
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().pages).toHaveLength(2) })
    expect(await controller.close('second')).toBe(false)
    expect(controller.view.getSnapshot().pages).toHaveLength(2)
    expect(controller.view.getSnapshot().closing).toBeNull()
    controller.show(false)
  })

  it('只在面板可见时请求打开浏览器窗口，并只发送本会话身份', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/ego/window') return Response.json({ ok: true })
      if (url.startsWith('/api/ego/frame?')) return new Response(null, { status: 404 })
      return overview(url) ?? Response.json({ ok: true, spaces: [first] })
    })
    const { controller } = fixture(fetcher)
    expect(await controller.raiseWindow()).toBe(false)
    expect(fetcher).not.toHaveBeenCalledWith('/api/ego/window', expect.anything())
    controller.show(true)
    expect(await controller.raiseWindow()).toBe(true)
    expect(fetcher).toHaveBeenCalledWith('/api/ego/window', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ sessionId: 'session-one' }),
    }))
    controller.show(false)
  })

  it('读取视频后端状态，隐藏后回到不可用', async () => {
    const mime = 'video/mp4; codecs="avc1.42E01E"'
    const { controller } = fixture(vi.fn(async (url: string) => {
      if (url === '/api/ego/video/status') return Response.json({ ok: true, backend: 'ffmpeg', mime })
      if (url.startsWith('/api/ego/frame?')) return new Response(null, { status: 404 })
      return overview(url) ?? Response.json({ ok: true, spaces: [first, second] })
    }))
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().video.available).toBe(true) })
    expect(controller.view.getSnapshot().video.mime).toBe(mime)
    controller.show(false)
    expect(controller.view.getSnapshot().video).toEqual({ available: false, mime: null })
  })

  it('视频后端没有 JPEG 帧时仍按页面视口发送点击与滚动', async () => {
    const mime = 'video/mp4; codecs="avc1.42E01E"'
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/ego/video/status') return Response.json({ ok: true, backend: 'ffmpeg', mime })
      if (url.startsWith('/api/ego/frame?')) return new Response(null, { status: 404 })
      if (url === '/api/ego/input') return Response.json({ ok: true })
      return overview(url) ?? Response.json({ ok: true, spaces: [first, second] })
    })
    const { controller } = fixture(fetcher)
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().video.available).toBe(true) })
    expect(controller.view.getSnapshot().frame).toBeNull()
    expect(await controller.send('first', { type: 'mousePressed', x: 12, y: 15, button: 'left', buttons: 1, clickCount: 1 })).toBe(true)
    expect(await controller.send('first', { type: 'mouseWheel', x: 12, y: 15, deltaX: 0, deltaY: 120 })).toBe(true)
    expect(fetcher).toHaveBeenCalledWith('/api/ego/input', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'session-one', targetId: 'first', type: 'mousePressed',
        x: 12, y: 15, button: 'left', buttons: 1, clickCount: 1 }),
    }))
    expect(await controller.send('first', { type: 'mousePressed', x: 400, y: 15, button: 'left', buttons: 1, clickCount: 1 })).toBe(false)
    controller.show(false)
  })

  it('视频状态不可用时保持不可用投影，单帧画面不受影响', async () => {
    const { controller, streams } = fixture(vi.fn(async (url: string) => {
      if (url === '/api/ego/video/status') return new Response(null, { status: 503 })
      if (url.startsWith('/api/ego/frame?')) return new Response(null, { status: 404 })
      return overview(url) ?? Response.json({ ok: true, spaces: [first] })
    }))
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().phase).toBe('ready') })
    expect(controller.view.getSnapshot().video).toEqual({ available: false, mime: null })
    streams[0]?.emit('frame', { targetId: 'first', data: 'YWJj', vw: 400, vh: 300, ts: 1 })
    expect(controller.view.getSnapshot().frame?.targetId).toBe('first')
    controller.show(false)
  })

  it('只把本会话的活动追加到最近动作，隐藏后停止监听', async () => {
    const { controller, activities } = fixture(vi.fn(async (url: string) => {
      if (url.startsWith('/api/ego/frame?')) return new Response(null, { status: 404 })
      return overview(url) ?? Response.json({ ok: true, spaces: [first, second] })
    }))
    controller.show(true)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().phase).toBe('ready') })
    expect(activities[0]?.url).toBe('/api/ego/activity')
    activities[0]?.emit('tool-call', { count: 1, sessionId: 'other', tool: 'browser_click', at: 5 })
    expect(controller.view.getSnapshot().actions).toEqual([])
    activities[0]?.emit('tool-call', { count: 2, sessionId: 'session-one', tool: 'ego_click', at: 6 })
    activities[0]?.emit('tool-call', { count: 3, sessionId: 'session-one', tool: 'browser_click', at: 6 })
    expect(controller.view.getSnapshot().actions).toEqual([{ kind: 'click', at: 6 }])
    activities[0]?.emit('tool-call', { count: 4, sessionId: 'session-one', data: 'frame' })
    expect(controller.view.getSnapshot().actions).toHaveLength(1)
    controller.show(false)
    expect(activities[0]?.closed).toBe(true)
    expect(controller.view.getSnapshot().actions).toEqual([])
  })
})
