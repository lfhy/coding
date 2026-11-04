import type { TargetSessions } from './capture-cdp.ts'

/** 无损单帧的体积预算（base64 字符）；UI 页面通常远低于它，大片渐变或照片会超过预算。 */
const LOSSLESS_BUDGET = 1_200_000

/** base64 只接受标准字母表，避免把任意文本当图片塞进面板。 */
const BASE64 = /^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

/** 单帧采集参数；两个值都来自用户的采集设置，Host 按请求下发。 */
export interface FrameOptions {
  /** 输出宽度上限（设备像素）；超宽面板按比例缩小，避免大图撑爆画面预算。 */
  maxWidth: number
  /** 有损 WebP 质量（1–100）；也是无损帧超预算时的回退质量。 */
  quality: number
  /** 实时推流直接走有损（编码更便宜），静止取帧默认无损。 */
  format?: 'lossy'
}

/**
 * 采集当前视口的一帧画面（默认无损 WebP，超预算时退回有损），并附上 CSS 视口尺寸供 Host 换算人工输入坐标。
 *
 * 采集按设备像素进行：面板用 `Emulation.setDeviceMetricsOverride` 把页面像素比设成
 * 显示器像素比，这里不再折算回 CSS 像素，否则 HiDPI 下 1:1 的截图会被面板放大而发虚。
 */
export async function captureFrame(
  sessions: Pick<TargetSessions, 'call'>,
  targetId: string,
  options: FrameOptions,
): Promise<{ targetId: string; data: string; mime: string; vw: number; vh: number; ts: number }> {
  const result = await sessions.call(targetId, 'Runtime.evaluate', {
    expression: '({ x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })',
    returnByValue: true,
  }) as { result?: { value?: { x?: number; y?: number; width?: number; height?: number; dpr?: number } } }
  const viewport = result.result?.value
  const vw = viewport?.width
  const vh = viewport?.height
  if (!Number.isSafeInteger(vw) || !Number.isSafeInteger(vh)
    || (vw as number) < 1 || (vw as number) > 8192 || (vh as number) < 1 || (vh as number) > 8192) {
    throw new Error('viewport unavailable')
  }
  const dpr = Number.isFinite(viewport?.dpr) && (viewport?.dpr as number) > 0 ? viewport!.dpr as number : 1
  const x = viewport?.x ?? 0, y = viewport?.y ?? 0
  if (![x, y].every(Number.isFinite) || x < 0 || y < 0) throw new Error('viewport unavailable')
  const scale = Math.min(1, options.maxWidth / ((vw as number) * dpr))
  const shot = async (lossless: boolean): Promise<{ data: string; mime: string }> => {
    const image = await sessions.call(targetId, 'Page.captureScreenshot', {
      // 静止帧用 WebP 质量 100（无损，体积约为 PNG 的一半）；实时帧用 JPEG，编码快得多。
      format: lossless ? 'webp' : 'jpeg',
      quality: lossless ? 100 : options.quality,
      captureBeyondViewport: false,
      clip: { x, y, width: vw, height: vh, scale },
    }) as { data?: string }
    if (typeof image.data !== 'string' || !BASE64.test(image.data)
      || image.data.length === 0 || image.data.length > 2_800_000) throw new Error('frame unavailable')
    return { data: image.data, mime: lossless ? 'image/webp' : 'image/jpeg' }
  }
  // 静止取帧默认无损：像素与页面完全一致，渐变不会出现编码台阶。
  // 实时推流直接有损：每秒十几帧时无损编码的开销与体积都不划算。
  if (options.format === 'lossy') {
    const lossy = await shot(false)
    return { targetId, data: lossy.data, mime: lossy.mime, vw: vw as number, vh: vh as number, ts: Date.now() }
  }
  const lossless = await shot(true)
  const chosen = lossless.data.length <= LOSSLESS_BUDGET ? lossless : await shot(false)
  return { targetId, data: chosen.data, mime: chosen.mime, vw: vw as number, vh: vh as number, ts: Date.now() }
}
