/** 拖拽分屏的落点判定：纯函数，便于在组件之外固定左右半区的语义。 */
import type { IdeSplitSide } from './ide-store.ts'

/** 编辑器内容区一次拖放的位置矩形（结构取自 getBoundingClientRect）。 */
export interface DropRect {
  left: number
  width: number
}

/**
 * 指针落在半区的哪一侧。
 * @param rect - 目标内容区矩形。
 * @param clientX - 拖放指针的视口横坐标。
 * @returns 左半为 `left`，右半（含正中线）为 `right`。
 */
export function dropSideOf(rect: DropRect, clientX: number): IdeSplitSide {
  return clientX - rect.left < rect.width / 2 ? 'left' : 'right'
}
