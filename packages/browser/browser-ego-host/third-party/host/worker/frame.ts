import type { TargetSessions } from './capture-cdp.ts'

/** 单帧采集参数；两个值都来自用户的采集设置，Host 按请求下发。 */
export interface FrameOptions {
  /** JPEG 质量（1–100）：2 倍采集后画面按设备像素 1:1 显示，质量直接决定文字边缘与渐变的保真度。 */
  quality: number
  /** 输出宽度上限（设备像素）；超宽面板按比例缩小，避免大图撑爆画面预算。 */
  maxWidth: number
}

/**
 * 采集当前视口的一帧 JPEG，并附上 CSS 视口尺寸供 Host 换算人工输入坐标。
 *
 * 采集按设备像素进行：面板用 `Emulation.setDeviceMetricsOverride` 把页面像素比设成
 * 显示器像素比，这里不再折算回 CSS 像素，否则 HiDPI 下 1:1 的截图会被面板放大而发虚。
 */
export async function captureFrame(
  sessions: Pick<TargetSessions, 'call'>,
  targetId: string,
  options: FrameOptions,
): Promise<{ targetId: string; data: string; vw: number; vh: number; ts: number }> {
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
  const image = await sessions.call(targetId, 'Page.captureScreenshot', {
    format: 'jpeg', quality: options.quality, captureBeyondViewport: false,
    clip: { x, y, width: vw, height: vh, scale },
  }) as { data?: string }
  if (typeof image.data !== 'string' || !/^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.data)
    || image.data.length === 0 || image.data.length > 2_800_000) throw new Error('frame unavailable')
  return { targetId, data: image.data, vw: vw as number, vh: vh as number, ts: Date.now() }
}
