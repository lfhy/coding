/** 全局文件库的持久记录；相对路径只能位于受管理目录。@module coding-file-library/types */
import type { FileId } from './brand.ts'

/** 用户输入、生成图片与会话导出的受管理文件分类。 */
export type ManagedFileKind = 'upload' | 'generated-image' | 'export'
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
