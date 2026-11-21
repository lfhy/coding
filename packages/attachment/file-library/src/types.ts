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
   */
  kind: 'dir' | 'file' | 'deck'
  path: string
  /** 文件修改时间戳（毫秒）；目录取其最后一次写入时间，供编辑端检测外部改动。 */
  mtimeMs: number
  children?: NotesTreeNode[] | undefined
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
