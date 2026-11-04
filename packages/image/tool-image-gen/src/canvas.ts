/** 从当前会话画布快照得到有界模型摘要；只读持久日志，不读取浏览器临时笔迹。@module coding-tool-image-gen/canvas */
import type { CanvasSnapshot } from 'coding-image-gen'
import type { JsonValue } from 'coding-tools'

/** 画布工具的 JSON 输出仅包含本会话日志中可重建的结构。 */
export interface CanvasSummary extends Record<string, JsonValue> {
  revision: number
  width: 960
  height: 640
  nodes: ({ id: string; type: 'stroke'; x: number; y: number; pointCount: number; width: number; color: 'ink'; erase?: boolean }
    | { id: string; type: 'image'; imageId: string; x: number; y: number; width: number; height: number })[]
  truncated: boolean
}

/** 工具输出最多列 32 个节点，避免大画布被重复送入模型上下文。 */
export function summarizeCanvas(snapshot: CanvasSnapshot): CanvasSummary {
  const nodes = snapshot.state.nodes.slice(0, 32).map(node => node.type === 'image'
    ? { id: node.id, type: 'image' as const, imageId: node.imageId,
      x: node.x, y: node.y, width: node.width, height: node.height }
    : { id: node.id, type: 'stroke' as const, x: node.points[0]?.x ?? 0, y: node.points[0]?.y ?? 0,
      pointCount: node.points.length, width: node.width, color: 'ink' as const,
      ...node.erase === undefined ? {} : { erase: node.erase } })
  return { revision: snapshot.revision, width: 960, height: 640, nodes,
    truncated: snapshot.state.nodes.length > nodes.length }
}
