/** 原生思维导图的字节、结构和编辑校验；不负责笔记路径或写入时序。 */
import { createHash, randomUUID } from 'node:crypto'
import { readXMindContent, XMIND_UPLOAD_MAX_BYTES } from './xmind.ts'
import type { MindMapDocument, MindMapEdit, MindMapNode } from './types.ts'

/** 原生思维导图只以此后缀保存为笔记文件。 */
export const NOTE_MINDMAP_SUFFIX = '.codingmindmap'

/** 原生文件（含导入）在解析前及序列化后的字节上限。 */
export const MINDMAP_MAX_BYTES = 1024 * 1024
const MAX_NODES = 400
const MAX_DEPTH = 20
const MAX_LABEL_CHARS = 256
const MAX_LABEL_BYTES = 1024
const MAX_ID_BYTES = 128
const MAX_EDITS = 32

/**
 * 判断真实笔记文件名是否使用思维导图后缀；调用方另行检查条目类型。
 * @param name - 不带目录的文件名。
 * @returns 后缀之前存在名称且匹配原生格式时为真。
 */
export function isMindmapName(name: string): boolean {
  return name.toLowerCase().endsWith(NOTE_MINDMAP_SUFFIX) && name.length > NOTE_MINDMAP_SUFFIX.length
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('思维导图结构无效')
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('思维导图结构无效')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, required: readonly string[], optional?: string): void {
  if (required.some(key => !Object.hasOwn(value, key))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !required.includes(key) && key !== optional)) {
    throw new TypeError('思维导图字段无效')
  }
}

function id(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_ID_BYTES || !value.trim() || !value.isWellFormed()
    || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value) > MAX_ID_BYTES) {
    throw new TypeError('思维导图主题标识无效')
  }
  return value
}

function label(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_LABEL_CHARS * 2 || !value.isWellFormed()
    || Buffer.byteLength(value) > MAX_LABEL_BYTES || Array.from(value).length > MAX_LABEL_CHARS) {
    throw new TypeError('思维导图主题文字无效或超过 256 个字符')
  }
  return value
}

function checkBudget(depth: number, count: number): void {
  if (depth > MAX_DEPTH) throw new TypeError('思维导图主题层级过深')
  if (count >= MAX_NODES) throw new TypeError('思维导图主题超过 400 个')
}

function newId(used: ReadonlySet<string>): string {
  let value = randomUUID()
  while (used.has(value)) value = randomUUID()
  return value
}

function decodeJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
  catch { throw new TypeError('思维导图不是有效的 UTF-8 JSON') }
}

function decodeTree(
  input: unknown,
  decode: (value: unknown, ids: ReadonlySet<string>) => { id: string; text: string; children: readonly unknown[] },
): MindMapDocument {
  const ids = new Set<string>()
  function visit(value: unknown, depth: number): MindMapNode {
    checkBudget(depth, ids.size)
    const topic = decode(value, ids)
    if (ids.has(topic.id)) throw new TypeError('思维导图主题标识重复')
    ids.add(topic.id)
    return { id: topic.id, text: topic.text, children: topic.children.map(child => visit(child, depth + 1)) }
  }
  return { version: 1, root: visit(input, 1) }
}

/**
 * 校验并解析原生笔记，保留主题标识及顺序，不接纳未知字段。
 * @param bytes - 从磁盘或导入请求取得的原生 JSON 字节。
 * @returns 验证后的独立文档；无效或超限输入抛出 `TypeError`。
 */
export function decodeMindmap(bytes: Uint8Array): MindMapDocument {
  if (bytes.byteLength > MINDMAP_MAX_BYTES) throw new TypeError('原生思维导图超过 1 MiB')
  const document = object(decodeJson(bytes))
  keys(document, ['version', 'root'])
  if (document.version !== 1) throw new TypeError('思维导图文件版本不受支持')
  return decodeTree(document.root, (value) => {
    const node = object(value)
    keys(node, ['id', 'text', 'children'])
    if (!Array.isArray(node.children)) throw new TypeError('思维导图子主题无效')
    return { id: id(node.id), text: label(node.text), children: node.children }
  })
}

function xmindChildren(value: unknown): readonly unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('XMind 子主题无效')
  return value
}

/**
 * 读取 XMind 首张图的标题与主题层次；不引用外部地址或保留附件、样式等元数据。
 * @param bytes - XMind 原始 ZIP 上传字节。
 * @returns 具有新主题标识的原生文档；无效或超限输入抛出 `TypeError`。
 */
export function decodeXMind(bytes: Uint8Array): MindMapDocument {
  if (bytes.byteLength > XMIND_UPLOAD_MAX_BYTES) throw new TypeError('XMind 文件超过 16 MiB')
  const sheets = decodeJson(readXMindContent(bytes))
  if (!Array.isArray(sheets) || sheets.length === 0) throw new TypeError('XMind 未包含可导入的主题')
  const sheet = object(sheets[0])
  return decodeTree(sheet.rootTopic, (value, ids) => {
    const topic = object(value)
    const groups = topic.children === undefined ? {} : object(topic.children)
    const attached = xmindChildren(groups.attached)
    const detached = xmindChildren(groups.detached)
    if (attached.length + detached.length > MAX_NODES) throw new TypeError('思维导图主题超过 400 个')
    return { id: newId(ids), text: label(topic.title), children: [...attached, ...detached] }
  })
}

/**
 * 创建只有中心主题的原生文档。
 * @param text - 规范化文件名中不含后缀的名称。
 * @returns 分配了新标识的文档。
 */
export function newMindmap(text: string): MindMapDocument {
  return { version: 1, root: { id: randomUUID(), text: label(text), children: [] } }
}

/**
 * 序列化经领域校验的原生文档，超限时不产生可写入的结果。
 * @param document - 已通过校验的思维导图。
 * @returns 持久化所用的 UTF-8 JSON 字节。
 */
export function encodeMindmap(document: MindMapDocument): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8')
  if (bytes.byteLength > MINDMAP_MAX_BYTES) throw new TypeError('原生思维导图超过 1 MiB')
  return bytes
}

/**
 * 以实际读取的磁盘字节计算内容基准，而不是依靠文件修改时间。
 * @param bytes - 原生文件字节。
 * @returns 供编辑请求原样传回的不透明版本。
 */
export function mindmapRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 在执行任何操作前，检查整批操作的字段和参数值并生成独立副本。
 * @param input - 不可信的编辑批次。
 * @returns 非空且不超过 32 项的已验证操作。
 */
export function parseMindmapEdits(input: unknown): MindMapEdit[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_EDITS) {
    throw new TypeError('思维导图每批需要 1 至 32 个操作')
  }
  return Array.from({ length: input.length }, (_, index): MindMapEdit => {
    if (!Object.hasOwn(input, index)) throw new TypeError('思维导图编辑操作无效')
    const edit = object(input[index])
    switch (edit.op) {
      case 'add':
        keys(edit, ['op', 'parentId', 'text'])
        return { op: 'add', parentId: id(edit.parentId), text: label(edit.text) }
      case 'rename':
        keys(edit, ['op', 'id', 'text'])
        return { op: 'rename', id: id(edit.id), text: label(edit.text) }
      case 'move': {
        keys(edit, ['op', 'id', 'parentId'], 'index')
        const move: MindMapEdit = { op: 'move', id: id(edit.id), parentId: id(edit.parentId) }
        if (Object.hasOwn(edit, 'index')) {
          if (typeof edit.index !== 'number' || !Number.isSafeInteger(edit.index) || edit.index < 0) {
            throw new TypeError('思维导图主题的位置无效')
          }
          move.index = edit.index
        }
        return move
      }
      case 'delete':
        keys(edit, ['op', 'id'])
        return { op: 'delete', id: id(edit.id) }
      default: throw new TypeError('思维导图编辑操作无效')
    }
  })
}

interface TopicLocation { node: MindMapNode; parent: MindMapNode | undefined }

function indexTree(root: MindMapNode): Map<string, TopicLocation> {
  const topics = new Map<string, TopicLocation>()
  function visit(node: MindMapNode, parent: MindMapNode | undefined, depth: number): void {
    checkBudget(depth, topics.size)
    topics.set(node.id, { node, parent })
    for (const child of node.children) visit(child, node, depth + 1)
  }
  visit(root, undefined, 1)
  return topics
}

function topicAt(topics: ReadonlyMap<string, TopicLocation>, key: string): TopicLocation {
  const found = topics.get(key)
  if (found === undefined) throw new TypeError('思维导图主题不存在')
  return found
}

function assertNever(edit: never): never {
  throw new TypeError(`思维导图编辑操作无效：${String(edit)}`)
}

/**
 * 编辑只发生在调用方独占的临时文档中；任一操作失败时，调用方不得保存该文档。
 * @param document - 未发布的、已验证的文档副本。
 * @param edits - 按发送顺序应用的已验证操作。
 * @returns 全批通过结构和预算检查后的同一份文档。
 */
export function applyMindmapEdits(document: MindMapDocument, edits: readonly MindMapEdit[]): MindMapDocument {
  let topics = indexTree(document.root)
  const ids = new Set(topics.keys())
  for (const edit of edits) {
    switch (edit.op) {
      case 'add': {
        const parent = topicAt(topics, edit.parentId).node
        const key = newId(ids)
        ids.add(key)
        parent.children.push({ id: key, text: edit.text, children: [] })
        break
      }
      case 'rename':
        topicAt(topics, edit.id).node.text = edit.text
        break
      case 'move': {
        const { node, parent } = topicAt(topics, edit.id)
        if (parent === undefined) throw new TypeError('不能移动思维导图的中心主题')
        const destination = topicAt(topics, edit.parentId).node
        for (let ancestor: MindMapNode | undefined = destination; ancestor !== undefined;) {
          if (ancestor === node) throw new TypeError('不能把主题移到自身或其子主题内')
          ancestor = topics.get(ancestor.id)?.parent
        }
        const remaining = destination.children.length - Number(parent === destination)
        const position = edit.index ?? remaining
        if (position > remaining) throw new TypeError('思维导图主题的位置越界')
        parent.children.splice(parent.children.indexOf(node), 1)
        destination.children.splice(position, 0, node)
        break
      }
      case 'delete': {
        const { node, parent } = topicAt(topics, edit.id)
        if (parent === undefined) throw new TypeError('不能删除思维导图的中心主题')
        parent.children.splice(parent.children.indexOf(node), 1)
        break
      }
      default: assertNever(edit)
    }
    topics = indexTree(document.root)
  }
  return document
}
