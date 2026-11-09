/** 全局文件库的持久记录；相对路径只能位于受管理目录。@module coding-file-library/types */
import type { FileId } from './brand.ts'

/** 上传原件与生成图片的受管理文件元数据。 */
export interface ManagedFileRecord {
  id: FileId
  kind: 'upload' | 'generated-image'
  name: string
  relativePath: string
  mediaType: string
  bytes: number
  createdAt: string
  sessionId?: string | undefined
  galleryId?: string | undefined
  attachmentId?: string | undefined
}

/** 按创建时间倒序分页，不包含本机绝对路径。 */
export interface ManagedFilePage {
  items: ManagedFileRecord[]
  total: number
  nextOffset?: number
}
