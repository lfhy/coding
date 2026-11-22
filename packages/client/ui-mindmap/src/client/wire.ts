/** 思维导图的同源 HTTP 适配；Host 持有保存、限额和路径校验。 */
import type { Branded } from 'coding-brand'

/** 在当前导图内标识节点，不使用文字或显示位置作为身份。 */
export type MindmapNodeId = Branded<'MindmapNodeId'>

/** 来自一次成功读取或编辑的节点。 */
export interface MindmapNode {
  readonly id: MindmapNodeId
  readonly text: string
  readonly children: readonly MindmapNode[]
}

/** Host 返回的文档和与它配套的写入条件。 */
export interface MindmapSnapshot {
  readonly path: string
  readonly revision: string
  readonly document: { readonly version: 1; readonly root: MindmapNode }
}

/** 单次结构编辑；移动位置以移除原节点后的目标孩子序列为准。 */
export type MindmapEdit =
  | { op: 'add'; parentId: MindmapNodeId; text: string }
  | { op: 'rename'; id: MindmapNodeId; text: string }
  | { op: 'move'; id: MindmapNodeId; parentId: MindmapNodeId; index?: number }
  | { op: 'delete'; id: MindmapNodeId }

/** 只传递界面能够处理的结果，不向组件返回响应正文里的诊断。 */
export type MindmapResult =
  | { kind: 'ready'; snapshot: MindmapSnapshot }
  | { kind: 'missing' | 'conflict' | 'failed' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNode(value: unknown): value is MindmapNode {
  const pending = [value]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const node = pending.pop()
    if (!isRecord(node) || typeof node.id !== 'string' || node.id === '' || seen.has(node.id)
      || typeof node.text !== 'string' || !Array.isArray(node.children)) return false
    seen.add(node.id)
    for (const child of node.children as unknown[]) pending.push(child)
  }
  return true
}

function isSnapshot(value: unknown, path: string): value is MindmapSnapshot {
  return isRecord(value) && value.path === path && typeof value.revision === 'string' && value.revision !== ''
    && isRecord(value.document) && value.document.version === 1 && isNode(value.document.root)
}

async function request(path: string, url: string, init: RequestInit): Promise<MindmapResult> {
  try {
    const response = await fetch(url, { ...init, cache: 'no-store' })
    if (response.status === 404) return { kind: 'missing' }
    if (response.status === 409) return { kind: 'conflict' }
    if (!response.ok) return { kind: 'failed' }
    const body: unknown = await response.json()
    return isSnapshot(body, path) ? { kind: 'ready', snapshot: body } : { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}

/**
 * 读取当前笔记的导图；未通过结构校验的内容不进入画布。
 * @param path - 笔记页提供的相对路径。
 * @param signal - 当前读取的取消信号。
 * @returns 已校验的快照或可呈现的失败分类。
 */
export function readMindmap(path: string, signal: AbortSignal): Promise<MindmapResult> {
  return request(path, `/api/notes/mindmap/read?${new URLSearchParams({ path })}`, { signal })
}

/**
 * 按当前文档版本保存一次编辑，不重发完整文档。
 * @param snapshot - 提供目标路径与写入条件的快照。
 * @param edit - 用户确认的单个结构操作。
 * @param signal - 当前编辑的取消信号；取消响应不保证 Host 撤回已完成的写入。
 * @returns 已保存的快照、版本冲突或其他可呈现的失败分类。
 */
export function saveMindmap(snapshot: MindmapSnapshot, edit: MindmapEdit, signal: AbortSignal): Promise<MindmapResult> {
  return request(snapshot.path, '/api/notes/mindmap/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: snapshot.path, revision: snapshot.revision, edits: [edit] }),
    signal,
  })
}
