/**
 * 面板的视频后端播放：用 MSE 消费同源 fMP4 流，失败时只报告一次，由面板回退单帧。
 *
 * 播放器不解释状态接口，也不发输入；它只持有一条流请求与一个 SourceBuffer 队列，
 * 释放时同时中止请求、丢弃队列并解除媒体源，避免隐藏或切换页面后继续拉流。
 */

/** 同源视频路由；面板只经此路径取流，不拼接任何地址。 */
export const EGO_VIDEO_ROUTE = '/api/ego/video'

/** 队列上限：超过后暂停读取，让 SourceBuffer 追上，避免无限占内存。 */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024

/** 播放位置最多落后缓冲末尾多少秒；直播画面不保留长时间历史。 */
const MAX_BEHIND_SECONDS = 3

/** 播放到缓冲末尾前保留的偏移，避免解码抖动导致停顿。 */
const LIVE_EDGE_SECONDS = 0.8

/** 一次播放器创建所需的元素、流格式与失败回调。 */
export interface MsePlayerInput {
  /** 画面区里的视频元素。 */
  video: HTMLVideoElement
  /** 状态接口报告的 fMP4 类型；必须能被当前浏览器的 MSE 接受。 */
  mime: string
  /** 同源请求载体，便于测试注入。 */
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>
  /** 流不可用、格式不支持或断开时调用；同一实例只调用一次。 */
  onFailure: () => void
}

/**
 * 在给定视频元素上建立 MSE 播放。
 * @param input - 视频元素、类型、请求载体与失败回调。
 * @returns 停止播放并释放全部资源的函数；不支持 MSE 时返回空操作。
 */
export function createMsePlayer(input: MsePlayerInput): () => void {
  const { video, mime, onFailure } = input
  const fetcher = input.fetcher ?? ((url, init) => fetch(url, init))
  if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mime)) {
    onFailure()
    return () => {}
  }
  const media = new MediaSource()
  const objectUrl = URL.createObjectURL(media)
  const abort = new AbortController()
  let disposed = false
  let failed = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let buffer: SourceBuffer | null = null
  let queue: Uint8Array[] = []
  let queued = 0
  let reading = false

  const fail = (): void => {
    if (disposed || failed) return
    failed = true
    onFailure()
  }

  const appendNext = (): void => {
    if (disposed || buffer === null || buffer.updating || queue.length === 0) return
    const chunk = queue.shift()
    if (chunk === undefined) return
    queued -= chunk.byteLength
    try {
      // 复制成自有 ArrayBuffer 视图：流分片与 MSE 的 BufferSource 在类型上不互通。
      buffer.appendBuffer(new Uint8Array(chunk))
    } catch {
      fail()
    }
  }

  // 直播画面只保留最近几秒：追上缓冲末尾播放，并移除过旧区间。
  const trim = (): void => {
    if (buffer === null || buffer.updating) return
    const { buffered } = video
    if (buffered.length === 0) return
    const end = buffered.end(buffered.length - 1)
    if (end - video.currentTime > LIVE_EDGE_SECONDS) video.currentTime = Math.max(0, end - 0.15)
    const start = buffered.start(0)
    if (start >= end - MAX_BEHIND_SECONDS) return
    try {
      buffer.remove(start, end - MAX_BEHIND_SECONDS)
    } catch {
      fail()
    }
  }

  const pump = (): void => {
    if (disposed || reading || reader === null || queued >= MAX_QUEUED_BYTES) return
    reading = true
    void reader.read().then((part) => {
      reading = false
      if (disposed) return
      if (part.done) {
        fail()
        return
      }
      queue.push(part.value)
      queued += part.value.byteLength
      appendNext()
      pump()
    }).catch(() => {
      reading = false
      if (!disposed) fail()
    })
  }

  const open = async (): Promise<void> => {
    try {
      const response = await fetcher(EGO_VIDEO_ROUTE, { signal: abort.signal, cache: 'no-store' })
      if (!response.ok || response.body === null) throw new Error('video stream unavailable')
      if (disposed) return
      reader = response.body.getReader()
      pump()
    } catch {
      if (!disposed) fail()
    }
  }

  media.addEventListener('sourceopen', () => {
    if (disposed) return
    try {
      buffer = media.addSourceBuffer(mime)
    } catch {
      fail()
      return
    }
    buffer.mode = 'segments'
    buffer.addEventListener('updateend', () => {
      if (disposed) return
      trim()
      appendNext()
      pump()
    })
    void open()
  })

  video.muted = true
  video.autoplay = true
  video.playsInline = true
  video.src = objectUrl
  try {
    void video.play().catch(() => {})
  } catch { /* 自动播放被拒绝时用户仍可直接播放。 */ }

  return () => {
    if (disposed) return
    disposed = true
    abort.abort()
    void reader?.cancel().catch(() => {})
    reader = null
    queue = []
    queued = 0
    try {
      video.pause()
    } catch { /* 元素可能已被卸载。 */ }
    try {
      video.removeAttribute('src')
      video.load()
    } catch { /* 同上。 */ }
    if (media.readyState === 'open') {
      try {
        media.endOfStream()
      } catch { /* 已结束或被关闭时忽略。 */ }
    }
    try {
      URL.revokeObjectURL(objectUrl)
    } catch { /* 已回收时忽略。 */ }
  }
}
