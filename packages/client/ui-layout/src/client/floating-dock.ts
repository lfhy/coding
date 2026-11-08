/** 悬浮对话只允许停靠在工作台下沿的三个位置。 */
export type FloatingDock = 'left' | 'center' | 'right'

/** 已扣除导航栏、终端底栏与安全边距的布局边界。 */
export interface FloatingBounds {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

export interface FloatingPoint {
  readonly left: number
  readonly top: number
}

export interface FloatingSize {
  readonly width: number
  readonly height: number
}

/**
 * 把拖动中的小窗留在可用工作台内。
 * @param point - 拖动后小窗的左上角。
 * @param size - 当前小窗的实测尺寸。
 * @param bounds - 工作台的可用边界。
 * @returns 限制在边界内的左上角。
 */
export function clampFloatingPoint(point: FloatingPoint, size: FloatingSize, bounds: FloatingBounds): FloatingPoint {
  const rightmost = Math.max(bounds.left, bounds.right - size.width)
  const bottommost = Math.max(bounds.top, bounds.bottom - size.height)
  return {
    left: Math.min(Math.max(point.left, bounds.left), rightmost),
    top: Math.min(Math.max(point.top, bounds.top), bottommost),
  }
}

/**
 * 取得左下、底部居中或右下停靠时的小窗左边缘。
 * @param dock - 目标停靠位置。
 * @param size - 小窗的实测尺寸。
 * @param bounds - 工作台可用边界。
 * @returns 小窗的左侧坐标。
 */
export function floatingDockLeft(dock: FloatingDock, size: FloatingSize, bounds: FloatingBounds): number {
  const rightmost = Math.max(bounds.left, bounds.right - size.width)
  if (dock === 'left') return bounds.left
  if (dock === 'right') return rightmost
  return bounds.left + (rightmost - bounds.left) / 2
}

/**
 * 松手时选最近的停靠点；等距或窄屏三点重合时沿用当前选择。
 * @param left - 已限制边界的小窗左边缘。
 * @param size - 当前小窗的实测尺寸。
 * @param bounds - 工作台可用边界。
 * @param current - 拖动前的停靠位置。
 * @returns 最近的停靠位置。
 */
export function snapFloatingDock(
  left: number,
  size: FloatingSize,
  bounds: FloatingBounds,
  current: FloatingDock,
): FloatingDock {
  let nearest = current
  let distance = Math.abs(left - floatingDockLeft(current, size, bounds))
  for (const dock of ['left', 'center', 'right'] as const) {
    const candidate = Math.abs(left - floatingDockLeft(dock, size, bounds))
    if (candidate < distance) {
      nearest = dock
      distance = candidate
    }
  }
  return nearest
}
