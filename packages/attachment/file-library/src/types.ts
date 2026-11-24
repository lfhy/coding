/** 全局文件库的持久记录；相对路径只能位于受管理目录。@module coding-file-library/types */
import type { FileId } from './brand.ts'

/** 用户输入、生成图片、会话导出与无目录笔记的受管理文件分类。 */
export type ManagedFileKind = 'upload' | 'generated-image' | 'export' | 'note'

/** 笔记目录树的节点；`path` 是相对笔记根目录的斜杠路径，浏览器端不会拿到绝对路径。 */
export interface NotesTreeNode {
  name: string
  /**
   * `deck` 是以 `.codingppt` 结尾的幻灯片工程目录：它是一行幻灯片条目而不是可展开目录，
   * 因此不携带 `children`。目录内的工程文件由 PPT 工作台读写，不进入笔记树。
   * `mindmap`、`word` 和 `excel` 是独立的结构化笔记文件，不能通过 Markdown 读写入口处理。
   */
  kind: 'dir' | 'file' | 'deck' | 'mindmap' | OfficeKind
  path: string
  /** 文件修改时间戳（毫秒）；目录取其最后一次写入时间，供编辑端检测外部改动。 */
  mtimeMs: number
  children?: NotesTreeNode[] | undefined
}

/** 主题节点；同一文档内 `id` 唯一，编辑主题内容或位置不改变该 ID。 */
export interface MindMapNode {
  id: string
  text: string
  children: MindMapNode[]
}

/** 原生思维导图的文件结构；版本由 Host 校验。 */
export interface MindMapDocument {
  version: 1
  root: MindMapNode
}

/** 一项结构化编辑；移动位置为移除原节点后目标子节点数组的零基插入位置。 */
export type MindMapEdit =
  | { op: 'add'; parentId: string; text: string }
  | { op: 'rename'; id: string; text: string }
  | { op: 'move'; id: string; parentId: string; index?: number }
  | { op: 'delete'; id: string }

/** 可编辑的磁盘快照；`path` 为笔记根目录的相对路径，`revision` 随内容字节变化。 */
export interface MindMapSnapshot {
  path: string
  revision: string
  document: MindMapDocument
}

/** 具有独立原生后缀的 Office 笔记类型。 */
export type OfficeKind = 'word' | 'excel'

/** Word 段落样式；标题与正文样式独立于行内文字属性。 */
export type WordParagraphStyle = 'normal' | 'title' | 'heading1' | 'heading2' | 'heading3'

/** Word 段落的水平对齐方式。 */
export type WordParagraphAlign = 'left' | 'center' | 'right' | 'justify'

/** 单个 Word 文字片段；颜色是 `#RRGGBB`，字号单位是 pt。 */
export interface WordRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  fontSize?: number
}

/** 一个 Word 段落；空段可以没有文字片段。 */
export interface WordParagraph {
  style: WordParagraphStyle
  align?: WordParagraphAlign
  runs: WordRun[]
}

/** 受支持的 Excel 单元格样式；颜色和填充是 `#RRGGBB`。 */
export interface ExcelStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  background?: string
  numberFormat?: string
}

/** 零基单元格；公式带 `=`，有公式时 `value` 表示可选缓存结果，无结果为 `null`。 */
export interface ExcelCell {
  row: number
  column: number
  value: string | number | boolean | null
  formula?: string
  style?: ExcelStyle
}

/** 包含起止点的零基合并区域。 */
export interface ExcelMerge {
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
}

/** 工作表；重命名不会改变当前笔记中持久化的表 ID。 */
export interface ExcelSheet {
  id: string
  name: string
  cells: ExcelCell[]
  merges?: ExcelMerge[]
}

/** 引擎文档快照的正文；除 `dataStream` 外的表格、图片、链接等结构原样保留。 */
export interface WordSnapshotBody {
  dataStream: string
  [key: string]: unknown
}

/** 引擎文档快照；Word 笔记直接保存它，因此引擎能表达的块都能落盘。 */
export interface WordSnapshot {
  body: WordSnapshotBody
  [key: string]: unknown
}

/** Office 笔记原生文档；版本及类型由 Host 在存取边界校验。 */
export type OfficeDocument =
  | { version: 2; kind: 'word'; snapshot: WordSnapshot }
  | { version: 1; kind: 'excel'; sheets: ExcelSheet[] }

/** 一项原子批次中的编辑；段落索引从零开始，单元格操作完整替换指定坐标。 */
export type OfficeEdit =
  | { op: 'replace_paragraph'; index: number; paragraph: WordParagraph }
  | { op: 'insert_paragraph'; index: number; paragraph: WordParagraph }
  | { op: 'delete_paragraph'; index: number }
  | { op: 'set_cells'; sheetId: string; cells: ExcelCell[] }
  | { op: 'add_sheet'; name: string }
  | { op: 'rename_sheet'; sheetId: string; name: string }
  | { op: 'delete_sheet'; sheetId: string }

/** 一个实际读取或发布的磁盘版本；路径相对于笔记根目录。 */
export interface OfficeSnapshot {
  path: string
  revision: string
  document: OfficeDocument
}

/** 从单个快照生成的可下载 Office 文件，不携带本机路径。 */
export interface OfficeExport {
  name: string
  mediaType: string
  bytes: Uint8Array
}

export type ManagedFileCategory = 'image' | 'presentation' | 'document' | 'other'

/** 上传原件、生成图片与会话导出的受管理文件元数据。 */
export interface ManagedFileRecord {
  id: FileId
  kind: ManagedFileKind
  name: string
  relativePath: string
  mediaType: string
  bytes: number
  createdAt: string
  sessionId?: string | undefined
  /** 保存时由 Host 工作区注册表解析出的归属；未分组会话不携带该字段。 */
  workspaceId?: string | undefined
  galleryId?: string | undefined
  attachmentId?: string | undefined
}

/** 按创建时间倒序分页，不包含本机绝对路径。 */
export interface ManagedFilePage {
  items: ManagedFileRecord[]
  total: number
  nextOffset?: number
}
