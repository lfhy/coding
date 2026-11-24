/** 笔记助手的 Word／Excel 工具；结构、格式和写入事务由文件库负责。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from 'coding-agent'
import { NoteConflictError, NoteNotFoundError, readWordParagraphs, type ExcelCell, type OfficeKind, type OfficeSnapshot, type WordParagraph } from 'coding-file-library'
import { defineTool } from 'coding-tools'
import { toolActionTitle } from 'coding-tools/tool-action-title'

const PAGE_BYTES = 8 * 1024
const PAGE_ITEMS = 24
const PREVIEW_LENGTH = 256
const requiredString = { type: 'string', required: true } as const
const index = { type: 'integer', required: true } as const
const kindSchema = { type: 'string', enum: ['word', 'excel'] } as const
const color = { type: 'string', description: '#RRGGBB 颜色。' } as const
const fontStyle = {
  bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' },
  strike: { type: 'boolean' }, color,
} as const
const paragraphSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    style: { type: 'string', enum: ['normal', 'title', 'heading1', 'heading2', 'heading3'], required: true },
    align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
    runs: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: {
        text: requiredString, ...fontStyle, fontSize: { type: 'number', description: '字号，单位为 pt。' },
      },
    } },
  },
} as const
const cellSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    row: index, column: index,
    value: {
      oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }], required: true,
      description: '单元格值；有公式时是缓存结果，无缓存可用 null。不带公式和样式的 null 会清空单元格。',
    },
    formula: { type: 'string', description: '以 = 开头的工作簿公式，不支持外部连接。' },
    style: { type: 'object', additionalProperties: false, properties: {
      ...fontStyle, background: color, numberFormat: { type: 'string' },
    } },
  },
} as const
const rangeSchema = {
  type: 'object', additionalProperties: false,
  properties: { startRow: index, startColumn: index, endRow: index, endColumn: index },
  description: '可选；仅在读取指定工作表时使用，含起止坐标。行和列都从 0 开始。',
} as const
const previewSchema = { truncated: { type: 'boolean', const: true, required: true }, preview: requiredString } as const

type SheetRange = { startRow: number; startColumn: number; endRow: number; endColumn: number }
type PageTarget = { path: string; revision: string; kind: OfficeKind; sheetId?: string; range?: SheetRange }

/** 按实际序列化大小限制整页；过大的首项只给预览，以便仍能继续翻页。 */
function readPage<T, U, K extends string>(
  base: PageTarget, key: K, offset: number, items: readonly T[],
  map: (item: T, index: number) => U,
  preview?: (item: T, index: number) => U,
) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) throw new TypeError('分页位置无效，请从头读取。')
  const pageItems: U[] = []
  const page = {
    ...base, offset, total: items.length, nextOffset: offset < items.length ? offset : null,
    ...{ [key]: pageItems } as Record<K, U[]>,
  }
  const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= PAGE_BYTES
  if (!fits(page)) throw new TypeError('文档路径过长，无法在单次结果中返回。')
  for (const [position, item] of items.slice(offset, offset + PAGE_ITEMS).entries()) {
    const itemIndex = offset + position
    const nextOffset = itemIndex + 1 < items.length ? itemIndex + 1 : null
    const full = map(item, itemIndex)
    if (fits({ ...page, [key]: [...pageItems, full], nextOffset })) {
      pageItems.push(full)
    } else {
      if (pageItems.length > 0) break
      const partial = preview?.(item, itemIndex)
      if (partial === undefined || !fits({ ...page, [key]: [partial], nextOffset })) {
        throw new TypeError('该项无法在单次结果中返回，请在编辑器中查看。')
      }
      pageItems.push(partial)
    }
    page.nextOffset = nextOffset
  }
  return page
}

type WordPageEntry = (WordParagraph & { index: number })
  | { index: number; style: WordParagraph['style']; truncated: true; preview: string }
type ExcelPageEntry = ExcelCell | { row: number; column: number; truncated: true; preview: string }

/** 生成结构化分页；Excel 表目录与指定工作表的单元格分别读取。 */
function pageOf(snapshot: OfficeSnapshot, offset: number, sheetId?: string, range?: SheetRange) {
  const { path, revision, document } = snapshot
  const base = { path, revision, kind: document.kind }
  if (document.kind === 'word') {
    if (sheetId !== undefined || range !== undefined) throw new TypeError('只有 Excel 工作簿可以读取指定工作表或区域。')
    return readPage<WordParagraph, WordPageEntry, 'paragraphs'>(base, 'paragraphs', offset, readWordParagraphs(document.snapshot),
      (paragraph, index) => ({ index, ...paragraph }), (paragraph, index) => {
        let preview = ''
        for (const run of paragraph.runs) {
          preview += run.text.slice(0, PREVIEW_LENGTH - preview.length)
          if (preview.length >= PREVIEW_LENGTH) break
        }
        return { index, style: paragraph.style, preview, truncated: true }
      })
  }
  if (sheetId === undefined) {
    if (range !== undefined) throw new TypeError('读取区域需要指定工作表 ID。')
    return readPage(base, 'sheets', offset, document.sheets, sheet => ({
      id: sheet.id, name: sheet.name, cellCount: sheet.cells.length, mergeCount: sheet.merges?.length ?? 0,
    }))
  }
  const sheet = document.sheets.find(item => item.id === sheetId)
  if (sheet === undefined) throw new TypeError('找不到该工作表，请重新读取工作簿的工作表列表。')
  if (range !== undefined && (!Object.values(range).every(n => Number.isSafeInteger(n) && n >= 0)
    || range.startRow > range.endRow || range.startColumn > range.endColumn)) throw new TypeError('单元格范围无效。')
  const cells = range === undefined ? sheet.cells : sheet.cells.filter(cell => cell.row >= range.startRow
    && cell.row <= range.endRow && cell.column >= range.startColumn && cell.column <= range.endColumn)
  return readPage<ExcelCell, ExcelPageEntry, 'cells'>({ ...base, sheetId, ...(range === undefined ? {} : { range }) }, 'cells', offset, cells,
    cell => cell, cell => ({ row: cell.row, column: cell.column, truncated: true,
      preview: (cell.formula ?? String(cell.value ?? '')).slice(0, PREVIEW_LENGTH) }))
}

/**
 * 在笔记预设中注册版本化读写，回退到当前文档只用于初次读取。
 * @param ctx - 笔记预设插件上下文。
 * @param authorized - 判断调用者是否仍对应同一个有效笔记会话。
 * @param activePath - 从唯一有效窗口复核活动 Office 笔记。
 */
export function registerNotesOffice(
  ctx: Context,
  authorized: (agent: Agent | undefined) => agent is Agent,
  activePath: (agent: Agent, signal: AbortSignal) => Promise<string | undefined>,
): void {
  ctx.tools.register(defineTool({
    name: 'notes_office',
    description: '读取、创建、编辑或导出笔记目录中的 Word 文档和 Excel 工作簿。首次读取可省略路径使用当前文档；Excel 先读取工作表列表，再指定 sheetId 读取单元格。'
      + '编辑或导出须使用读取返回的路径和版本；如有冲突，重新读取并核对目标。请保留用户未要求改动的内容和样式，不要用截断预览替代原内容。',
    parameters: {
      action: { type: 'string', enum: ['read', 'create', 'edit', 'export'], required: true },
      kind: { ...kindSchema, description: '创建时必填，选择 Word 文档或 Excel 工作簿。' },
      path: { type: 'string', description: 'Office 笔记相对于笔记根目录的路径；续读、编辑、导出必填。' },
      name: { type: 'string', description: '创建时必填，填写新文档名称。' },
      directory: { type: 'string', description: '创建时可选的相对目录，省略则保存在笔记根目录。' },
      revision: { type: 'string', description: '使用读取返回的版本；读下一页、读指定工作表、编辑及导出时必填。' },
      offset: { type: 'integer', description: '读取时使用上一页的 nextOffset 和相同的查询条件；null 表示读完，不再调用。' },
      sheetId: { type: 'string', description: '读取指定工作表时使用上一次读取返回的表 ID。' },
      range: rangeSchema,
      edits: {
        type: 'array', description: '编辑时必填，按序执行 1 至 32 项操作。段落索引和单元格行列从 0 开始，写入时完整替换指定段落或单元格。',
        items: { oneOf: [
          { type: 'object', additionalProperties: false, properties: {
            op: { type: 'string', enum: ['replace_paragraph', 'insert_paragraph'], required: true },
            index, paragraph: { ...paragraphSchema, required: true },
          } },
          { type: 'object', additionalProperties: false, properties: {
            op: { type: 'string', const: 'delete_paragraph', required: true }, index,
          } },
          { type: 'object', additionalProperties: false, properties: {
            op: { type: 'string', const: 'set_cells', required: true }, sheetId: requiredString,
            cells: { type: 'array', required: true, description: '一次设置 1 至 256 个单元格。', items: cellSchema },
          } },
          { type: 'object', additionalProperties: false, properties: {
            op: { type: 'string', const: 'add_sheet', required: true }, name: requiredString,
          } },
          { type: 'object', additionalProperties: false, properties: {
            op: { type: 'string', const: 'rename_sheet', required: true }, sheetId: requiredString, name: requiredString,
          } },
          { type: 'object', additionalProperties: false, properties: {
            op: { type: 'string', const: 'delete_sheet', required: true }, sheetId: requiredString,
          } },
        ] },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string' }, revision: { type: 'string' }, kind: kindSchema,
        name: { type: 'string' }, fileId: { type: 'string' },
        offset: { type: 'integer' }, total: { type: 'integer' }, nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        sheetId: { type: 'string' }, range: rangeSchema,
        paragraphs: { type: 'array', items: { oneOf: [
          { ...paragraphSchema, properties: { index, ...paragraphSchema.properties } },
          { type: 'object', additionalProperties: false, properties: { index, style: paragraphSchema.properties.style, ...previewSchema } },
        ] } },
        sheets: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          id: requiredString, name: requiredString, cellCount: index, mergeCount: index,
        } } },
        cells: { type: 'array', items: { oneOf: [
          cellSchema,
          { type: 'object', additionalProperties: false, properties: { row: index, column: index, ...previewSchema } },
        ] } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: args => args.action === 'read',
    presentCall: ({ action }) => ({
      card: 'generic', kind: action === 'read' ? 'read' : 'other',
      title: toolActionTitle('notes_office', JSON.stringify({ action })) ?? '操作办公笔记',
    }),
    async execute(args, { agent, signal }) {
      if (!authorized(agent)) throw new Error('只可在对应笔记目录的笔记会话中操作 Word 或 Excel。')
      const requireWritable = () => {
        if (ctx.sandboxPolicy.resolve({ session: agent.session }).mode === 'read-only') {
          throw new Error('当前会话为只读，不能创建、编辑或导出办公笔记。')
        }
      }
      signal.throwIfAborted()
      if (args.action !== 'read') requireWritable()
      try {
        if (args.action === 'create') {
          if (args.kind === undefined || !args.name?.trim()) throw new TypeError('请提供 Word 或 Excel 类型及新文档名称。')
          return await ctx.fileLibrary.createNoteOffice(args.kind, args.name, args.directory)
        }
        if (args.action === 'edit' || args.action === 'export') {
          if (args.path === undefined || args.revision === undefined) throw new TypeError('请先读取目标文档，再提供路径和版本。')
          if (args.action === 'edit') {
            if (args.edits === undefined) throw new TypeError('请提供要执行的编辑。')
            const { path, revision, document } = await ctx.fileLibrary.editNoteOffice(args.path, args.revision, args.edits)
            return { path, revision, kind: document.kind }
          }
          const exported = await ctx.fileLibrary.exportNoteOffice(args.path, args.revision)
          signal.throwIfAborted()
          if (!authorized(agent)) throw new Error('笔记会话已关闭，请重新打开后再试。')
          requireWritable()
          const { record } = await ctx.fileLibrary.saveExport({
            name: exported.name, mediaType: exported.mediaType, data: exported.bytes, sessionId: agent.session.id,
          })
          return { name: record.name, fileId: record.id }
        }
        const offset = args.offset ?? 0
        if ((offset !== 0 || args.sheetId !== undefined) && (args.path === undefined || args.revision === undefined)) {
          throw new TypeError('读取下一页或工作表时，请使用上一页返回的路径和版本。')
        }
        const path = args.path ?? await activePath(agent, signal)
        if (path === undefined) throw new Error('无法确定当前 Word 或 Excel 笔记。请打开目标，或提供它在笔记目录中的相对路径。')
        signal.throwIfAborted()
        if (!authorized(agent)) throw new Error('笔记会话已关闭，请重新打开后再试。')
        const snapshot = await ctx.fileLibrary.readNoteOffice(path)
        if (args.revision !== undefined && args.revision !== snapshot.revision) throw new NoteConflictError()
        return pageOf(snapshot, offset, args.sheetId, args.range)
      } catch (error) {
        if (error instanceof NoteConflictError) {
          throw new Error(args.action === 'create' ? '无法创建文档：同名笔记已存在或目录已变更。'
            : '文档已发生变化。请重新读取并核对内容后再试；本次没有写入。')
        }
        if (error instanceof NoteNotFoundError) throw new Error('找不到文档或保存目录。请核对相对路径。')
        throw error
      }
    },
  }))
}
