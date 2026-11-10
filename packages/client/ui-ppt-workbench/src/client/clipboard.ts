/** 元素粘贴时保留内容和样式，重新生成身份；坐标限制在目标页可见范围内。 */
import { SLIDE_SIZES, type PptElement, type SlideSizeId } from 'coding-ppt-model'

/**
 * 生成插入操作的元素载荷；原元素不会被修改，服务端负责生成新 id 并校验媒体引用。
 * @param source - 已复制的元素。
 * @param size - 目标工程的画布尺寸。
 * @param count - 已成功粘贴的次数。
 * @param at - 右键位置；缺省时逐次错开原元素。
 * @returns 保留元素内容但不带旧 id 的插入载荷。
 */
export function pastedElement(
  source: PptElement, size: SlideSizeId, count: number, at?: { x: number; y: number },
): Record<string, unknown> {
  const { id: _id, ...element } = structuredClone(source)
  const canvas = SLIDE_SIZES[size]
  return {
    ...element,
    x: Math.round(Math.min(Math.max(at?.x ?? source.x + (count + 1) * 24, 0), Math.max(0, canvas.width - source.w))),
    y: Math.round(Math.min(Math.max(at?.y ?? source.y + (count + 1) * 24, 0), Math.max(0, canvas.height - source.h))),
  }
}
