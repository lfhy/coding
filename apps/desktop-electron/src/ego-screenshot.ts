/** 桌面工作台的截图适配：裁剪落在位图上，不改变网页的布局。 */
import { nativeImage, type Debugger } from 'electron'

/**
 * Chromium 带 clip 的截图会临时调整原生视图尺寸。视口内 PNG 改为读取整张 surface，再按文档坐标裁剪和缩放。
 * 显式超出视口的截图及其他编码仍交由 CDP 处理。
 * @param debuggerApi 已附加到目标页面的调试器。
 * @param params 原始 Page.captureScreenshot 参数。
 * @returns CDP 截图响应；不可见的裁剪区域拒绝截取。
 */
export async function captureEgoViewport(debuggerApi: Debugger, params: Record<string, unknown>): Promise<unknown> {
  const { clip, ...options } = params
  if (!viewportClip(clip) || options.captureBeyondViewport === true || options.fromSurface === false
    || (options.format !== undefined && options.format !== 'png')) {
    return await debuggerApi.sendCommand('Page.captureScreenshot', params) as unknown
  }

  const { cssVisualViewport: viewport } = await debuggerApi.sendCommand('Page.getLayoutMetrics') as {
    cssVisualViewport: { pageX: number; pageY: number; scale: number }
  }
  // CSS VisualViewport 不含占位滚动条，原生位图却包含；不能用两者的宽度比换算元素坐标。
  const { result } = await debuggerApi.sendCommand('Runtime.evaluate', {
    expression: 'window.devicePixelRatio', returnByValue: true,
  }) as { result: { value?: number } }
  const scale = (result.value ?? 0) * viewport.scale
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('screenshot pixel scale unavailable')
  const shot = await debuggerApi.sendCommand('Page.captureScreenshot', options) as { data: string }
  const image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))
  const { width, height } = image.getSize()
  if (width <= 0 || height <= 0) throw new Error('screenshot image unavailable')
  const left = Math.max(0, (clip.x - viewport.pageX) * scale)
  const top = Math.max(0, (clip.y - viewport.pageY) * scale)
  const right = Math.min(width, (clip.x + clip.width - viewport.pageX) * scale)
  const bottom = Math.min(height, (clip.y + clip.height - viewport.pageY) * scale)
  if (right <= left || bottom <= top) throw new Error('screenshot clip is outside the viewport')
  const x = Math.floor(left), y = Math.floor(top)
  const w = Math.ceil(right) - x, h = Math.ceil(bottom) - y
  if (x === 0 && y === 0 && w === width && h === height && clip.scale === 1) return shot
  const cropped = image.crop({ x, y, width: w, height: h })
  const resized = clip.scale === 1 ? cropped : cropped.resize({
    width: Math.max(1, Math.round((right - left) * clip.scale)),
    height: Math.max(1, Math.round((bottom - top) * clip.scale)),
  })
  return { data: resized.toPNG().toString('base64') }
}

function viewportClip(value: unknown): value is { x: number; y: number; width: number; height: number; scale: number } {
  if (value === null || typeof value !== 'object') return false
  const { x, y, width, height, scale } = value as Record<string, unknown>
  return [x, y, width, height, scale].every(Number.isFinite)
    && Number(width) > 0 && Number(height) > 0 && Number(scale) > 0 && Number(scale) <= 1
}
