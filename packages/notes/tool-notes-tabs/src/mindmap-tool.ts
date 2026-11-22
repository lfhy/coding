/** 笔记助手的结构化导图工具；目录与编辑事务仍由文件库验证和提交。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from 'coding-agent'
import { NoteConflictError, NoteNotFoundError, type MindMapNode, type MindMapSnapshot } from 'coding-file-library'
import { defineTool } from 'coding-tools'

const PAGE_BYTES = 8 * 1024
const PAGE_TOPICS = 24
const id = { type: 'string', required: true } as const
const text = { type: 'string', required: true, description: '主题文字，最多 256 个字符。' } as const
const topicSchema = {
  type: 'object', additionalProperties: false,
  properties: { id, text, parentId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true } },
} as const

/** 保留父子与兄弟顺序；分页大小包含完整 JSON 的转义和元数据开销。 */
function pageOf(snapshot: MindMapSnapshot, offset: number) {
  type Topic = { id: string; text: string; parentId: string | null }
  const topics: Topic[] = []
  const visit = (node: MindMapNode, parentId: string | null) => {
    topics.push({ id: node.id, text: node.text, parentId })
    for (const child of node.children) visit(child, node.id)
  }
  visit(snapshot.document.root, null)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > topics.length) throw new Error('主题分页位置无效，请从第一页读取。')
  const page = {
    path: snapshot.path, revision: snapshot.revision, totalTopics: topics.length, topics: [] as Topic[],
    nextOffset: offset < topics.length ? offset : null,
  }
  for (const [index, topic] of topics.slice(offset, offset + PAGE_TOPICS).entries()) {
    const cursor = offset + index + 1
    const nextOffset = cursor < topics.length ? cursor : null
    const candidate = { ...page, topics: [...page.topics, topic], nextOffset }
    if (Buffer.byteLength(JSON.stringify(candidate)) > PAGE_BYTES) break
    page.topics.push(topic)
    page.nextOffset = nextOffset
  }
  if (page.topics.length === 0 && page.nextOffset !== null) throw new Error('无法在单次结果中返回该主题，请在导图编辑器查看。')
  return page
}

/**
 * 在笔记预设内注册有界读写工具，读不到活动标签时不猜测目标，写入始终使用明确路径。
 * @param ctx - 笔记预设插件上下文。
 * @param authorized - 判断调用者是否为当前笔记目录对应的 live 助手。
 * @param activePath - 核验当前唯一窗口的活动导图路径。
 */
export function registerNotesMindmap(
  ctx: Context,
  authorized: (agent: Agent | undefined) => agent is Agent,
  activePath: (agent: Agent, signal: AbortSignal) => Promise<string | undefined>,
): void {
  ctx.tools.register(defineTool({
    name: 'notes_mindmap',
    description: '读取、创建或编辑笔记目录中的思维导图。读取可省略路径以使用当前导图；编辑必须使用读取返回的 path、revision 和主题 id。'
      + '一批编辑全部成功才写入；版本变化时重新读取并核对目标，不要覆盖他人的修改。',
    parameters: {
      action: { type: 'string', enum: ['read', 'create', 'edit'], required: true, description: '读取、创建或编辑思维导图。' },
      path: { type: 'string', description: '导图相对于笔记根目录的路径。读取当前导图时可省略；翻页和编辑必填。' },
      name: { type: 'string', description: '创建时必填，作为新导图的名称及中心主题。' },
      directory: { type: 'string', description: '创建时可选的相对目录，省略时保存在笔记根目录。' },
      revision: { type: 'string', description: '翻页和编辑必填，使用读取结果里的 revision；不能自行生成。' },
      offset: { type: 'integer', description: '读取时使用上一页的 nextOffset；省略从中心主题开始，null 表示没有下一页。' },
      edits: {
        type: 'array', description: '编辑时必填，按序执行的 1 至 32 项修改。新主题的 id 由系统分配，随后读取才能使用。',
        items: { oneOf: [
          { type: 'object', additionalProperties: false, properties: {
            op: { type: 'string', const: 'add', required: true }, parentId: id, text,
          } },
          { type: 'object', additionalProperties: false, properties: {
            op: { type: 'string', const: 'rename', required: true }, id, text,
          } },
          { type: 'object', additionalProperties: false, properties: {
            op: { type: 'string', const: 'move', required: true }, id, parentId: id,
            index: { type: 'integer', description: '从旧位置移除后，在新父主题下从 0 开始的插入位置；省略则追加。' },
          } },
          { type: 'object', additionalProperties: false, properties: {
            op: { type: 'string', const: 'delete', required: true }, id,
          } },
        ] },
      },
    },
    output: {
      schema: { oneOf: [
        { type: 'object', additionalProperties: false, properties: { path: id } },
        { type: 'object', additionalProperties: false, properties: {
          path: id, revision: id, totalTopics: { type: 'integer', required: true },
          topics: { type: 'array', items: topicSchema, required: true },
          nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
        } },
      ] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: args => args.action === 'read',
    presentCall: ({ action }) => ({
      card: 'generic', kind: action === 'read' ? 'read' : 'other',
      title: action === 'read' ? '读取思维导图' : action === 'create' ? '新建思维导图' : '编辑思维导图',
    }),
    async execute(args, { agent, signal }) {
      if (!authorized(agent)) throw new Error('只可在对应笔记目录的笔记会话中操作思维导图。')
      signal.throwIfAborted()
      if (args.action !== 'read' && ctx.sandboxPolicy.resolve({ session: agent.session }).mode === 'read-only') {
        throw new Error('当前会话为只读，不能创建或编辑思维导图。')
      }

      try {
        if (args.action === 'create') {
          if (!args.name?.trim()) throw new Error('请提供新导图的名称。')
          return await ctx.fileLibrary.createNoteMindmap(args.name, args.directory)
        }
        if (args.action === 'edit') {
          if (args.path === undefined || args.revision === undefined || args.edits === undefined) {
            throw new Error('请先读取目标导图，再提供它的路径、版本和编辑内容。')
          }
          return pageOf(await ctx.fileLibrary.editNoteMindmap(args.path, args.revision, args.edits), 0)
        }
        const offset = args.offset ?? 0
        if (offset !== 0 && (args.path === undefined || args.revision === undefined)) {
          throw new Error('翻页需要使用上一页返回的路径和版本。')
        }
        const path = args.path ?? await activePath(agent, signal)
        if (path === undefined) throw new Error('无法确定当前思维导图。请打开目标导图，或提供它在笔记目录中的相对路径。')
        signal.throwIfAborted()
        if (!authorized(agent)) throw new Error('笔记会话已关闭，请重新打开后再试。')
        const snapshot = await ctx.fileLibrary.readNoteMindmap(path)
        if (args.revision !== undefined && args.revision !== snapshot.revision) {
          throw new NoteConflictError('导图版本已更换')
        }
        return pageOf(snapshot, offset)
      } catch (error) {
        if (error instanceof NoteConflictError) {
          throw new Error(args.action === 'create' ? '无法创建思维导图：同名笔记已存在或目录已变更。'
            : '思维导图已发生变化。请重新读取并核对主题后再试；本次没有写入。')
        }
        if (error instanceof NoteNotFoundError) throw new Error('找不到思维导图或保存目录。请核对相对路径。')
        throw error
      }
    },
  }))
}
