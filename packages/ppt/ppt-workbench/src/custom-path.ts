/** 将自定义路径中可确定的无旋转水平/垂直单线段投影为编辑器坐标；其余形状交给导入器报告损失。 */
import type { ElementFrame } from 'coding-ppt-model'

/**
 * 只识别没有填充、旋转和翻转的单段直线，避免把复杂路径错误地当成原始版式。
 * @param shapeProps - 已通过 OOXML 结构准入的形状属性。
 * @param box - 幻灯片上的形状外框，路径坐标相对该外框缩放。
 * @returns 可编辑线段外框；不能准确表达时返回 null。
 */
export function axisAlignedCustomPath(shapeProps: string, box: ElementFrame): ElementFrame | null {
  const path = /<a:path\b[^>]*>[\s\S]*?<\/a:path>/u.exec(shapeProps)?.[0] ?? ''
  const commands = [...path.matchAll(/<a:(moveTo|lnTo)>\s*<a:pt\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"[^>]*\/>\s*<\/a:\1>/gu)]
  const transform = /<a:xfrm\b[^>]*>/u.exec(shapeProps)?.[0] ?? ''
  const pathWidth = Number(/<a:path\b[^>]*\bw="(\d+)"/u.exec(path)?.[1])
  const pathHeight = Number(/<a:path\b[^>]*\bh="(\d+)"/u.exec(path)?.[1])
  const pathPoints = /<a:pathLst\b[^>]*>[\s\S]*?<\/a:pathLst>/u.exec(shapeProps)?.[0] ?? ''
  if ((pathPoints.match(/<a:path\b/gu)?.length ?? 0) !== 1 || /<a:(?:close|cubicBezTo|quadBezTo|arcTo)\b/u.test(path)
    || commands.length !== 2 || commands[0]?.[1] !== 'moveTo' || commands[1]?.[1] !== 'lnTo'
    || !/<a:noFill\s*\/>/u.test(shapeProps) || /\b(?:rot|flipH|flipV)=/u.test(transform)
    || pathWidth <= 0 || pathHeight <= 0) return null
  const [start, end] = commands
  const x1 = box.x + Math.round(Number(start[2]) / pathWidth * box.w)
  const y1 = box.y + Math.round(Number(start[3]) / pathHeight * box.h)
  const x2 = box.x + Math.round(Number(end[2]) / pathWidth * box.w)
  const y2 = box.y + Math.round(Number(end[3]) / pathHeight * box.h)
  if ((x1 !== x2 && y1 !== y2) || !Number.isFinite(x1 + y1 + x2 + y2)) return null
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}
