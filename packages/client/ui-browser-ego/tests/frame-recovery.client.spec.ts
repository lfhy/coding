/** 后台页不接收活动页画面流，单帧失败与后续更新必须由可见视图自己恢复。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserEgoController } from '../src/client/controller.ts'

const foreground = { targetId: 'foreground', title: 'Foreground', url: 'https://example.com/', active: true,
  viewportW: 400, viewportH: 300, humanCheck: false }
const background = { ...foreground, targetId: 'background', title: 'Background', active: false }
const frame = (targetId = 'background', ts = 1, vw = 400) => ({ targetId, data: 'YWJj', vw, vh: 300, ts })

class Stream extends EventTarget {
  emit(name: string, value: unknown): void {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(value) }))
  }
  close(): void {}
}

function fixture(readFrame: (signal?: AbortSignal | null) => Promise<Response>, active = false) {
  const stream = new Stream()
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => url.startsWith('/api/ego/frame?')
    ? await readFrame(init?.signal)
    : Response.json({ ok: true, spaces: [foreground, { ...background, active }] }))
  const controller = new BrowserEgoController('session-one', fetcher,
    () => stream as unknown as EventSource, () => new Stream() as unknown as EventSource)
  controller.show(true, 'background')
  return { controller, stream, fetcher }
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

afterEach(() => { vi.useRealTimers() })

describe('可见页面的自动补帧', () => {
  it('后台页初次取帧失败后自动恢复，并持续更新且不重复初始请求', async () => {
    vi.useFakeTimers()
    let available = false, ts = 1
    const read = vi.fn(async () => available ? Response.json(frame('background', ts++)) : new Response(null, { status: 503 }))
    const { controller, stream } = fixture(read)
    try {
      await settle()
      expect(read).toHaveBeenCalledTimes(1)
      expect(controller.view.getSnapshot().frame).toBeNull()
      available = true
      stream.emit('frame', frame('foreground', 100))
      await vi.advanceTimersByTimeAsync(1000)
      expect(controller.view.getSnapshot().frame?.ts).toBe(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(controller.view.getSnapshot().frame?.ts).toBe(2)
    } finally { controller.dispose() }
  })

  it('不匹配尺寸的单帧不会显示，目录更新后补帧失败也能恢复', async () => {
    vi.useFakeTimers()
    let available = true
    const { controller, stream } = fixture(async () => available
      ? Response.json(frame('background', Date.now(), 600)) : new Response(null, { status: 503 }))
    try {
      await settle()
      expect(controller.view.getSnapshot().frame).toBeNull()
      available = false
      stream.emit('spaces', [foreground, { ...background, viewportW: 600 }])
      await settle()
      expect(controller.view.getSnapshot().frame).toBeNull()
      available = true
      await vi.advanceTimersByTimeAsync(1000)
      expect(controller.view.getSnapshot().frame?.width).toBe(600)
    } finally { controller.dispose() }
  })

  it('活动页缺帧时补帧，收到有效画面后停止额外轮询', async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => new Response(null, { status: 503 }))
    const { controller, stream } = fixture(read, true)
    try {
      await settle()
      await vi.advanceTimersByTimeAsync(1000)
      expect(read).toHaveBeenCalledTimes(2)
      stream.emit('frame', frame())
      await vi.advanceTimersByTimeAsync(2000)
      const calls = read.mock.calls.length
      await vi.advanceTimersByTimeAsync(5000)
      expect(read).toHaveBeenCalledTimes(calls)
      expect(controller.view.getSnapshot().frame?.targetId).toBe('background')
    } finally { controller.dispose() }
  })

  it('慢请求不被目录刷新反复中断，隐藏后取消在途请求和后续补帧', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void
    let signal: AbortSignal | null | undefined
    const read = vi.fn((current?: AbortSignal | null) => {
      signal = current
      return new Promise<Response>((resolve) => { finish = resolve })
    })
    const { controller, stream } = fixture(read)
    try {
      await settle()
      stream.emit('spaces', [foreground, background])
      await controller.refresh()
      await vi.advanceTimersByTimeAsync(3000)
      expect(read).toHaveBeenCalledTimes(1)
      expect(signal?.aborted).toBe(false)
      controller.show(false, 'background')
      expect(signal?.aborted).toBe(true)
      finish(Response.json(frame()))
      await vi.advanceTimersByTimeAsync(5000)
      expect(read).toHaveBeenCalledTimes(1)
      expect(controller.view.getSnapshot().frame).toBeNull()
    } finally { controller.dispose() }
  })

  it('在途补帧被活动页实时帧取代后，迟到响应不覆盖画面或恢复轮询', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void
    let signal: AbortSignal | null | undefined
    const read = vi.fn((current?: AbortSignal | null) => {
      signal = current
      return new Promise<Response>((resolve) => { finish = resolve })
    })
    const { controller, stream } = fixture(read, true)
    try {
      await settle()
      stream.emit('frame', frame('background', 10))
      expect(signal?.aborted).toBe(true)
      finish(Response.json(frame('background', 20)))
      await vi.advanceTimersByTimeAsync(5000)
      expect(controller.view.getSnapshot().frame?.ts).toBe(10)
      expect(read).toHaveBeenCalledTimes(1)
    } finally { controller.dispose() }
  })

  it('后台慢取帧期间的目录事件不提前启动下一次补帧计时', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void
    const read = vi.fn(async () => read.mock.calls.length === 1
      ? Response.json(frame())
      : await new Promise<Response>((resolve) => { finish = resolve }))
    const { controller, stream } = fixture(read)
    try {
      await settle()
      await vi.advanceTimersByTimeAsync(1000)
      expect(read).toHaveBeenCalledTimes(2)
      stream.emit('spaces', [foreground, background])
      await vi.advanceTimersByTimeAsync(500)
      finish(Response.json(frame('background', 2)))
      await settle()
      await vi.advanceTimersByTimeAsync(999)
      expect(read).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(read).toHaveBeenCalledTimes(3)
    } finally { controller.dispose() }
  })

  it('切页、页面移除与销毁都会停止旧页面补帧', async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => new Response(null, { status: 503 }))
    const { controller, stream } = fixture(read)
    try {
      await settle()
      controller.show(true, 'foreground')
      await settle()
      stream.emit('frame', frame('foreground'))
      await vi.advanceTimersByTimeAsync(2000)
      const calls = read.mock.calls.length
      stream.emit('spaces', [])
      await vi.advanceTimersByTimeAsync(5000)
      expect(read).toHaveBeenCalledTimes(calls)
      controller.dispose()
      await vi.advanceTimersByTimeAsync(5000)
      expect(read).toHaveBeenCalledTimes(calls)
    } finally { controller.dispose() }
  })
})
