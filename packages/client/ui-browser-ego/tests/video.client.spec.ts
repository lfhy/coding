// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMsePlayer, EGO_VIDEO_ROUTE } from '../src/client/video.ts'

const mime = 'video/mp4; codecs="avc1.42E01E"'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** 一个不触发 jsdom 未实现告警的视频元素桩。 */
function videoElement(): HTMLVideoElement {
  const video = document.createElement('video')
  video.play = vi.fn(async () => {})
  video.pause = vi.fn()
  video.load = vi.fn()
  return video
}

/** 只记录分片追加的 SourceBuffer 桩。 */
class FakeSourceBuffer extends EventTarget {
  updating = false
  mode = 'segments'
  appendBuffer = vi.fn((_chunk: BufferSource) => {})
  remove = vi.fn()
}

/** 需要显式 open 的 MediaSource 桩，让测试控制 sourceopen 时机。 */
class FakeMediaSource extends EventTarget {
  static readonly instances: FakeMediaSource[] = []
  static isTypeSupported = vi.fn(() => true)
  readyState = 'closed'
  readonly buffer = new FakeSourceBuffer()
  addSourceBuffer = vi.fn(() => this.buffer)
  endOfStream = vi.fn()

  constructor() {
    super()
    FakeMediaSource.instances.push(this)
  }

  open(): void {
    this.readyState = 'open'
    this.dispatchEvent(new Event('sourceopen'))
  }
}

/** 安装媒体源与对象地址桩，返回撤销记录。 */
function installMedia() {
  vi.stubGlobal('MediaSource', FakeMediaSource)
  const createObjectURL = vi.fn(() => 'blob:ego-video')
  const revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
  return { createObjectURL, revokeObjectURL }
}

describe('视频后端播放器', () => {
  it('浏览器不支持该流格式时只报告一次失败，返回空操作', () => {
    const failures = vi.fn()
    const stop = createMsePlayer({ video: videoElement(), mime, onFailure: failures })
    expect(failures).toHaveBeenCalledOnce()
    stop()
    stop()
    expect(failures).toHaveBeenCalledOnce()
  })

  it('从同源视频路由读取分片并追加，释放时中止请求并解除媒体源', async () => {
    installMedia()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3]))
        controller.close()
      },
    })
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status: 200 }))
    const video = videoElement()
    const failures = vi.fn()
    const stop = createMsePlayer({ video, mime, fetcher, onFailure: failures })
    const source = FakeMediaSource.instances.at(-1)
    if (source === undefined) throw new Error('media source not created')
    expect(video.src).toBe('blob:ego-video')
    source.open()
    await vi.waitFor(() => { expect(source.buffer.appendBuffer).toHaveBeenCalled() })
    const [requestedUrl, init] = fetcher.mock.calls[0] ?? []
    expect(requestedUrl).toBe(EGO_VIDEO_ROUTE)
    expect(init?.cache).toBe('no-store')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const signal = init?.signal
    expect(signal?.aborted).toBe(false)
    stop()
    expect(signal?.aborted).toBe(true)
    expect(video.getAttribute('src')).toBeNull()
    expect(source.endOfStream).toHaveBeenCalled()
  })

  it('视频流不可用时报告失败，供面板回退单帧', async () => {
    installMedia()
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 503 }))
    const failures = vi.fn()
    const stop = createMsePlayer({ video: videoElement(), mime, fetcher, onFailure: failures })
    FakeMediaSource.instances.at(-1)?.open()
    await vi.waitFor(() => { expect(failures).toHaveBeenCalledOnce() })
    stop()
    expect(failures).toHaveBeenCalledOnce()
  })
})
