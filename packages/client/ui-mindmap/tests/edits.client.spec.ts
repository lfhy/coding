import { expect, it } from 'vitest'
import { createDraft, editFromDraft } from '../src/client/mindmap-edits.ts'
import { indexMindmap, moveDestinations, nodeTrail } from '../src/client/mindmap-tree.ts'
import type { MindmapNode, MindmapNodeId } from '../src/client/wire.ts'

const node = (id: string, text: string, ...children: MindmapNode[]): MindmapNode => ({ id: id as MindmapNodeId, text, children })
const descendant = node('descendant', '孩子')
const first = node('first', '甲', descendant)
const last = node('last', '')
const root = node('root', '计划', first, last)
const tree = indexMindmap(root)
const revision = 'v1'

it('根不可删除或移动，源节点的子树、原上级和不存在的节点都不是新目标', () => {
  expect(editFromDraft(tree, createDraft('delete', root, revision))).toBeNull()
  expect(editFromDraft(tree, createDraft('earlier', root, revision))).toBeNull()
  expect(moveDestinations(tree, root.id)).toEqual([])
  expect(moveDestinations(tree, node('other', '其他').id)).toEqual([])
  expect(moveDestinations(tree, first.id).map(row => row.node.id)).toEqual([last.id])
  const draft = createDraft('move', first, revision)
  expect(editFromDraft(tree, { ...draft, action: 'move', parentId: descendant.id })).toBeNull()
  expect(nodeTrail(tree.byId.get(last.id)!, '未命名节点')).toBe('计划 › 未命名节点')
})

it('同级调整拒绝越过边界，并按最新快照计算合法的插入位置', () => {
  expect(editFromDraft(tree, createDraft('earlier', first, revision))).toBeNull()
  expect(editFromDraft(tree, createDraft('later', last, revision))).toBeNull()
  expect(editFromDraft(tree, createDraft('earlier', last, revision))).toEqual({
    op: 'move', id: last.id, parentId: root.id, index: 0,
  })
})
