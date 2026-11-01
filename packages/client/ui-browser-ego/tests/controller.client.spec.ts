import { describe, expect, it, vi } from 'vitest'
import { BrowserEgoController } from '../src/client/controller.ts'

const first = { targetId: 'first', title: 'First', url: 'https://example.com/', active: true,
  viewportW: 400, viewportH: 300 }
const second = { ...first, targetId: 'second', title: 'Second', active: false }

class FakeStream extends EventTarget {
  closed = false
  constructor(readonly url: string) { super() }
  emit(name: string, payload: unknown): void {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(payload) }))
  }
  close(): void { this.closed = true }
}

function fixture(fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, spaces: [first, second] }))) {
  const streams: FakeStream[] = []
  const controller = new BrowserEgoController('session-one', fetcher,
    (url) => { const stream = new FakeStream(url); streams.push(stream); return stream as unknown as EventSource })
  return { controller, fetcher, streams }
}

describe('会话画面与人工输入', () => {
  it('只在可见期间连接同一会话的目录和 SSE，隐藏后丢弃旧事件', async () => {
    const { controller, fetcher, streams } = fixture(vi.fn(async url => url.startsWith('/api/ego/frame?')
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
    const { controller, fetcher, streams } = fixture(vi.fn(async (url, _init) => {
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
    const fetcher = vi.fn((url: string, _init?: RequestInit) => url.startsWith('/api/ego/frame?')
      ? Promise.resolve(new Response(null, { status: 404 }))
      : new Promise<Response>((done) => { resolve = done }))
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
      : Promise.resolve(Response.json({ ok: true, spaces: [first, second] })))
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
})
