/** 将对话框中的编辑意图转换成针对当前节点位置的一次保存。 */
import { moveDestinations, type MindmapTree } from './mindmap-tree.ts'
import type { MindmapEdit, MindmapNode, MindmapNodeId } from './wire.ts'

/** 工具栏公开的编辑动作。 */
export type BranchAction = 'add' | 'rename' | 'delete' | 'move' | 'earlier' | 'later'

/** 表单记住打开或明确刷新时的版本；背景读取不能替它确认新版本。 */
export type EditDraft = { nodeId: MindmapNodeId; revision: string } & (
  | { action: 'add' | 'rename'; text: string }
  | { action: 'move'; parentId: MindmapNodeId | null }
  | { action: 'delete' | 'earlier' | 'later' }
)

/**
 * 创建表单输入，不复制整张图。
 * @param action - 用户选择的操作。
 * @param node - 操作针对的节点。
 * @param revision - 打开时已确认的快照版本。
 * @returns 可独立于背景读取保留的输入。
 */
export function createDraft(action: BranchAction, node: MindmapNode, revision: string): EditDraft {
  const target = { nodeId: node.id, revision }
  if (action === 'add' || action === 'rename') return { ...target, action, text: action === 'rename' ? node.text : '' }
  if (action === 'move') return { ...target, action, parentId: null }
  return { ...target, action }
}

/**
 * 检查动作仍可用于当前节点，并使用移除源节点后的插入下标。
 * @param tree - 当前文档的索引。
 * @param draft - 用户确认的动作和输入。
 * @returns 一项操作；源、目标或顺序不再可用时为 null。
 */
export function editFromDraft(tree: MindmapTree, draft: EditDraft): MindmapEdit | null {
  const row = tree.byId.get(draft.nodeId)
  if (row === undefined) return null
  switch (draft.action) {
    case 'add': return { op: 'add', parentId: draft.nodeId, text: draft.text }
    case 'rename': return { op: 'rename', id: draft.nodeId, text: draft.text }
    case 'delete': return row.parent === null ? null : { op: 'delete', id: draft.nodeId }
    case 'move': return draft.parentId !== null && moveDestinations(tree, draft.nodeId).some(candidate => candidate.node.id === draft.parentId)
      ? { op: 'move', id: draft.nodeId, parentId: draft.parentId } : null
    case 'earlier':
    case 'later': {
      const index = row.siblingIndex + (draft.action === 'earlier' ? -1 : 1)
      if (row.parent === null || index < 0 || index >= row.parent.node.children.length) return null
      return { op: 'move', id: draft.nodeId, parentId: row.parent.node.id, index }
    }
    /* v8 ignore next -- 表单只由封闭的 BranchAction 联合产生，不接受运行时字符串。 */
    default: return assertNever(draft)
  }
}

/* v8 ignore next 3 -- 穷尽检查仅在将来有未处理的内部表单动作时抛错。 */
function assertNever(value: never): never {
  throw new TypeError(`不支持的导图编辑：${String(value)}`)
}
