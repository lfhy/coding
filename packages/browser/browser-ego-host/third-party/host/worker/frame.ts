import type { TargetSessions } from './capture-cdp.ts'

/** PNG 单帧的体积预算（base64 字符）；UI 页面通常远低于它，照片类页面超过时改用 JPEG。 */
const PNG_BUDGET = 1_200_000

/** base64 只接受标准字母表，避免把任意文本当图片塞进面板。 */
const BASE64 = /^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

/** 单帧采集参数；两个值都来自用户的采集设置，Host 按请求下发。 */
export interface FrameOptions {
  /** 超出 PNG 预算时的 JPEG 质量（1–100）。 */
  quality: number
  /** 输出宽度上限（设备像素）；超宽面板按比例缩小，避免大图撑爆画面预算。 */
  maxWidth: number
}

/**
 * 采集当前视口的一帧画面（默认无损 PNG，超预算时退回 JPEG），并附上 CSS 视口尺寸供 Host 换算人工输入坐标。
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
  const shot = async (format: 'png' | 'jpeg', quality?: number): Promise<string> => {
    const image = await sessions.call(targetId, 'Page.captureScreenshot', {
      format, ...(quality === undefined ? {} : { quality }), captureBeyondViewport: false,
      clip: { x, y, width: vw, height: vh, scale },
    }) as { data?: string }
    if (typeof image.data !== 'string' || !BASE64.test(image.data)
      || image.data.length === 0 || image.data.length > 2_800_000) throw new Error('frame unavailable')
    return image.data
  }
  // 面板与本机服务同机传输：UI 页面用无损 PNG 往往比 JPEG 更小且没有色偏与振铃，
  // 只有照片类页面会超过预算，才退回按设置质量的 JPEG。
  const png = await shot('png')
  const lossless = png.length <= PNG_BUDGET
  const data = lossless ? png : await shot('jpeg', options.quality)
  return { targetId, data, mime: lossless ? 'image/png' : 'image/jpeg', vw: vw as number, vh: vh as number, ts: Date.now() }
}
