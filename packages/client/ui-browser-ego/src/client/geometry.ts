/** 将缩放与留白后的 JPEG 图片像素映射到会话浏览器视口。 */

/**
 * 没有完整的图片或点击落在留白内时禁止发送坐标命令。
 * @param clientX - 屏幕内水平位置。
 * @param clientY - 屏幕内垂直位置。
 * @param rect - 图片元素的布局边界。
 * @param natural - 实际解码的图片尺寸。
 * @param viewport - 截图对应的 Host CSS 视口。
 * @returns 视口内整数坐标；图像外为 null。
 */
export function pointOnFrame(clientX: number, clientY: number, rect: DOMRect,
  natural: { width: number; height: number }, viewport: { width: number; height: number }): { x: number; y: number } | null {
  if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height,
    natural.width, natural.height, viewport.width, viewport.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || natural.width <= 0 || natural.height <= 0
    || viewport.width <= 0 || viewport.height <= 0) return null
  const scale = Math.min(rect.width / natural.width, rect.height / natural.height)
  const width = natural.width * scale
  const height = natural.height * scale
  const x = clientX - rect.left - (rect.width - width) / 2
  const y = clientY - rect.top - (rect.height - height) / 2
  if (x < 0 || y < 0 || x >= width || y >= height) return null
  return { x: Math.min(viewport.width - 1, Math.floor(x * viewport.width / width)),
    y: Math.min(viewport.height - 1, Math.floor(y * viewport.height / height)) }
}
