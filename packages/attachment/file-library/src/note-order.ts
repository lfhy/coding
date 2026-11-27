/** 每个笔记目录的私有排序清单；条目只保存直属名称，移动目录时清单随目录一起移动。 */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { writeNoteBytes } from './private-files.ts'
import type { NotesTreeNode } from './types.ts'

/** 排序清单保留在笔记根目录内，但不出现在目录树、节点预算或文件索引中。 */
export const NOTE_ORDER_FILE = '.coding-notes-order.json'
const NOTE_ORDER_MAX_NAMES = 4096
const NOTE_ORDER_MAX_NAME_BYTES = 1024
/** JSON 最坏情况会转义引号和控制字符；上限覆盖完整节点预算下的清单与结构开销。 */
const NOTE_ORDER_MAX_BYTES = NOTE_ORDER_MAX_NAMES * (NOTE_ORDER_MAX_NAME_BYTES * 2 + 3) + 64

/** 排序清单只接受单个真实名称，不接受路径段或控制字符。 */
function isOrderName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= NOTE_ORDER_MAX_NAME_BYTES
    && value !== '.' && value !== '..' && !/[\\/\u0000-\u001f\u007f]/u.test(value)
}

/** 校验外部清单的版本、数组形状、名称边界与唯一性。 */
function parseOrder(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)
    || !('version' in body) || body.version !== 1 || !('order' in body) || !Array.isArray(body.order)) return []
  const names = body.order.filter(isOrderName)
  if (names.length !== body.order.length || names.length > NOTE_ORDER_MAX_NAMES || new Set(names).size !== names.length) return []
  return names
}

/**
 * 读取目录排序；清单缺失、损坏或不是私有普通文件时退回名称排序，不阻断笔记访问。
 * 读取使用 no-follow 句柄并以初始大小多读一字节，拒绝检查后被替换或增大的清单。
 * @param directory - 已核验真实身份的笔记目录绝对路径。
 * @returns 校验后的直属名称顺序。
 */
export async function readNoteOrder(directory: string): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(join(directory, NOTE_ORDER_FILE), constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size > NOTE_ORDER_MAX_BYTES) return []
    const bytes = Buffer.alloc(Math.min(info.size + 1, NOTE_ORDER_MAX_BYTES + 1))
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > info.size || offset > NOTE_ORDER_MAX_BYTES) return []
    return parseOrder(JSON.parse(bytes.subarray(0, offset).toString('utf8')))
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * 原子写入目录排序；目录身份由调用方核验，临时文件与目标都使用私有权限。
 * @param directory - 已核验真实身份的笔记目录绝对路径。
 * @param names - 不重复的直属名称数组，长度受笔记节点上限约束。
 */
export async function writeNoteOrder(directory: string, names: readonly string[]): Promise<void> {
  if (names.length > NOTE_ORDER_MAX_NAMES || names.some(name => !isOrderName(name)) || new Set(names).size !== names.length) {
    throw new TypeError('笔记排序无效')
  }
  const bytes = Buffer.from(JSON.stringify({ version: 1, order: names }), 'utf8')
  if (bytes.length > NOTE_ORDER_MAX_BYTES) throw new TypeError('笔记排序超过大小上限')
  await writeNoteBytes(join(directory, NOTE_ORDER_FILE), bytes)
}

/**
 * 按手工顺序排列目录节点；清单之外的条目仍按名称排序并跟在已排序条目之后。
 * @param nodes - 当前目录中已准入的笔记节点。
 * @param order - 该目录的私有排序清单。
 * @returns 新数组，不修改传入节点。
 */
export function orderNoteNodes(nodes: readonly NotesTreeNode[], order: readonly string[]): NotesTreeNode[] {
  const rank = new Map(order.map((name, index) => [name, index]))
  return [...nodes].sort((left, right) => {
    const leftRank = rank.get(left.name) ?? order.length
    const rightRank = rank.get(right.name) ?? order.length
    return leftRank === rightRank ? left.name.localeCompare(right.name) : leftRank - rightRank
  })
}

/** 排序存在时把新条目追加到末尾；没有手工排序则不创建清单。 */
export async function appendNoteOrder(directory: string, name: string): Promise<void> {
  const order = await readNoteOrder(directory)
  if (order.length === 0 || order.includes(name)) return
  await writeNoteOrder(directory, [...order, name])
}

/** 从已有排序中移除条目；清单缺失时无需写入。 */
export async function removeNoteOrder(directory: string, name: string): Promise<void> {
  const order = await readNoteOrder(directory)
  if (!order.includes(name)) return
  await writeNoteOrder(directory, order.filter(item => item !== name))
}

/** 同目录改名时保留条目位置；目录改名只需更新父目录清单。 */
export async function replaceNoteOrderName(directory: string, from: string, to: string): Promise<void> {
  const order = await readNoteOrder(directory)
  const index = order.indexOf(from)
  if (index < 0) return
  await writeNoteOrder(directory, order.map(name => name === from ? to : name))
}
