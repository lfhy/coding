/**
 * 截图上的 CSS 坐标映射到 Host 视口；边界以实际图像盒为准。
 * @param clientX - 指针相对视窗的水平坐标。
 * @param clientY - 指针相对视窗的垂直坐标。
 * @param rect - 实际图片可见盒。
 * @param viewport - 与截图对应的 Host 视口。
 * @returns Host 整数坐标；盒外或未布局时为 null。
 */
export function pointOnFrame(clientX: number, clientY: number, rect: DOMRect,
  viewport: { readonly width: number; readonly height: number }): { x: number; y: number } | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)
    || rect.width <= 0 || rect.height <= 0
    || clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return null
  return {
    x: Math.min(viewport.width - 1, Math.floor((clientX - rect.left) * viewport.width / rect.width)),
    y: Math.min(viewport.height - 1, Math.floor((clientY - rect.top) * viewport.height / rect.height)),
  }
}
