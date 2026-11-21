/**
 * 桌面端的原生呈现入口。
 *
 * 桌面壳把页面放进应用窗口自己的原生视图，工作台只需要说明「页面该占哪块矩形」；
 * Web 与 CLI 没有这个入口，仍按帧流渲染。入口由 preload 提供，页面只拿到一个
 * 异步方法，不接触进程、会话或页面内容。
 */

/** 上报给桌面壳的矩形，坐标相对窗口内容区（CSS 像素）。 */
export interface EgoSurfaceBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 原生呈现请求；`visible: false` 表示撤回该页面。 */
export interface EgoSurfaceRequest {
  targetId: string
  visible: boolean
  bounds: EgoSurfaceBounds
}

export interface EgoNativeSurface {
  present(request: EgoSurfaceRequest): Promise<unknown>
}

const EMPTY: EgoSurfaceBounds = { x: 0, y: 0, width: 0, height: 0 }

/**
 * 读取桌面端原生呈现入口。
 * @returns 桌面壳提供了该能力时为入口对象，否则为 null（走帧流）。
 */
export function nativeEgoSurface(): EgoNativeSurface | null {
  const desktop = (globalThis as { codingDesktop?: { egoBrowser?: unknown } }).codingDesktop
  const candidate = desktop?.egoBrowser
  if (typeof candidate !== 'object' || candidate === null) return null
  const present = (candidate as { present?: unknown }).present
  if (typeof present !== 'function') return null
  return { present: input => (present as EgoNativeSurface['present']).call(candidate, input) }
}

/**
 * 撤回某个页面的呈现。
 * @param surface 原生呈现入口。
 * @param targetId 页面标识；缺失时什么也不做。
 */
export function concealEgoSurface(surface: EgoNativeSurface, targetId: string | null | undefined): void {
  if (targetId === null || targetId === undefined) return
  void surface.present({ targetId, visible: false, bounds: EMPTY }).catch(() => undefined)
}
