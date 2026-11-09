/** SQLite 后端路由的 `files` 领域记录格式。@module coding-file-library/spec */
import { z } from 'zod'
import { defineDomain, domainTable } from 'coding-storage-domain'
import { FileId } from './brand.ts'
import type { ManagedFileRecord } from './types.ts'

/** 持久边界的完整记录校验；不信任 SQLite 中的路径或标识符。 */
export const managedFileSchema: z.ZodType<ManagedFileRecord> = z.object({
  id: z.uuid().transform(FileId),
  kind: z.enum(['upload', 'generated-image']),
  name: z.string().min(1).max(255),
  relativePath: z.string().regex(/^(?:uploads\/[0-9a-f-]{36}-[^/\\]+|generated\/[0-9a-f-]{36}\.(?:png|jpg|webp|gif))$/u),
  mediaType: z.string().min(1),
  bytes: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  sessionId: z.string().min(1).optional(),
  galleryId: z.string().min(1).optional(),
  attachmentId: z.string().min(1).optional(),
}).strict()

/** 文件元数据独占 `files` v1 领域，物理后端由组合层选择。 */
export const fileDomainSpec = defineDomain({
  name: 'files', version: 1,
  tables: { files: domainTable<ManagedFileRecord['id'], ManagedFileRecord>(managedFileSchema) },
})
