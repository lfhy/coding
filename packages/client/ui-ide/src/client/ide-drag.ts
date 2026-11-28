/** 拖拽分屏的落点判定：纯函数，固定四向边缘与标签栏左右半区语义。 */
import type { IdeSplitSide } from './ide-store.ts'

/** 编辑器内容区一次拖放的位置矩形（结构取自 getBoundingClientRect）。 */
export interface DropRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * 指针距离哪条边最近就落在哪个半区；上下左右都可形成嵌套分组。
 * @param rect - 目标内容区矩形。
 * @param clientX - 拖放指针的视口横坐标。
 * @param clientY - 拖放指针的视口纵坐标。
 * @returns 最近的左、右、上、下边缘。
 */
export function dropSideOf(rect: DropRect, clientX: number, clientY: number): IdeSplitSide {
  const x = clientX - rect.left
  const y = clientY - rect.top
  const candidates: ReadonlyArray<readonly [IdeSplitSide, number]> = [
    ['right', rect.width - x], ['top', y], ['bottom', rect.height - y],
  ]
  let side: IdeSplitSide = 'left'
  let nearest = x
  for (const [candidate, distance] of candidates) {
    if (distance < nearest) {
      nearest = distance
      side = candidate
    }
  }
  return side
}

/**
 * 标签栏高度只够表达左右拆分，避免指针靠近上沿时误判为上下分屏。
 * @param rect - 目标标签栏矩形。
 * @param clientX - 拖放指针的视口横坐标。
 * @returns 左半为 `left`，右半（含正中线）为 `right`。
 */
export function dropTabSideOf(rect: DropRect, clientX: number): IdeSplitSide {
  return clientX - rect.left < rect.width / 2 ? 'left' : 'right'
}
