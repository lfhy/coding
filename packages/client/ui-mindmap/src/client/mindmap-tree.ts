/** 为节点选中、方向键、移动目标与顺序计算提供同一份只读索引。 */
import type { MindmapNode, MindmapNodeId } from './wire.ts'

interface MindmapPosition {
  node: MindmapNode
  parent: MindmapPosition | null
  siblingIndex: number
  start: number
  end: number
}

/** 已按画布阅读顺序索引的树，`start` 到 `end`（不含）是一个分支。 */
export interface MindmapTree {
  root: MindmapPosition
  rows: readonly MindmapPosition[]
  byId: ReadonlyMap<MindmapNodeId, MindmapPosition>
}

/**
 * 按父节点在前的顺序展开快照，保持全部孩子顺序。
 * @param root - 已校验且标识唯一的根节点。
 * @returns 节点、同级位置和分支范围的索引；不修改快照。
 */
export function indexMindmap(root: MindmapNode): MindmapTree {
  const rows: MindmapPosition[] = []
  const byId = new Map<MindmapNodeId, MindmapPosition>()
  const visit = (node: MindmapNode, parent: MindmapPosition | null, siblingIndex: number): MindmapPosition => {
    const position = { node, parent, siblingIndex, start: rows.length, end: 0 }
    rows.push(position)
    byId.set(node.id, position)
    node.children.forEach((child, index) => { visit(child, position, index) })
    position.end = rows.length
    return position
  }
  const rootPosition = visit(root, null, 0)
  return { root: rootPosition, rows, byId }
}

/**
 * 筛出能接收当前分支的新父节点；同级重排由独立动作完成。
 * @param tree - 当前画布的索引。
 * @param id - 要移动的分支。
 * @returns 不含自身、后代和原父节点的候选项。
 */
export function moveDestinations(tree: MindmapTree, id: MindmapNodeId): readonly MindmapPosition[] {
  const source = tree.byId.get(id)
  if (source === undefined || source.parent === null) return []
  return tree.rows.filter(row => row !== source.parent && (row.start < source.start || row.start >= source.end))
}

/**
 * 生成便于区分同名节点的位置文案。
 * @param position - 地图中的节点位置。
 * @param unnamed - 无文字节点的本地化名称。
 * @returns 从主节点起的完整名称链。
 */
export function nodeTrail(position: MindmapPosition, unnamed: string): string {
  const labels = []
  for (let row: MindmapPosition | null = position; row !== null; row = row.parent) {
    labels.push(row.node.text.trim() === '' ? unnamed : row.node.text)
  }
  return labels.reverse().join(' › ')
}
