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
