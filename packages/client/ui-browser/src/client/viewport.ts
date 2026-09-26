/** 把右栏实际可用像素映射到浏览器提供方的有界视口。 */
const MIN_WIDTH = 200
const MIN_HEIGHT = 240
const MAX_WIDTH = 1920
const MAX_HEIGHT = 1400
const MAX_AREA = 1_800_000

export interface BrowserViewport {
  readonly width: number
  readonly height: number
}

/**
 * 对超大画布同比缩小；小于 Provider 最低尺寸时才单独补足短边。
 * @param width - 内容画布 CSS 宽度。
 * @param height - 内容画布 CSS 高度。
 * @returns 合法浏览器视口，隐藏或无布局尺寸时为 null。
 */
export function fitBrowserViewport(width: number, height: number): BrowserViewport | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height, Math.sqrt(MAX_AREA / (width * height)))
  let nextWidth = Math.max(MIN_WIDTH, Math.floor(width * scale))
  let nextHeight = Math.max(MIN_HEIGHT, Math.floor(height * scale))
  if (nextWidth * nextHeight > MAX_AREA) {
    const finalScale = Math.sqrt(MAX_AREA / (nextWidth * nextHeight))
    nextWidth = Math.max(MIN_WIDTH, Math.floor(nextWidth * finalScale))
    nextHeight = Math.max(MIN_HEIGHT, Math.floor(nextHeight * finalScale))
  }
  return { width: nextWidth, height: nextHeight }
}
