/** SQLite 后端路由的 `files` 领域记录格式。@module coding-file-library/spec */
import { z } from 'zod'
import { defineDomain, domainTable } from 'coding-storage-domain'
import { FileId } from './brand.ts'
import type { ManagedFileRecord } from './types.ts'

export const managedFileSchema: z.ZodType<ManagedFileRecord> = z.object({
  id: z.uuid().transform(FileId),
  kind: z.enum(['upload', 'generated-image']),
  name: z.string().min(1).max(255),
  relativePath: z.string().regex(/^(?:uploads\/[0-9a-f-]{36}-[^/\\]+|generated\/[0-9a-f-]{36}\.(?:png|jpg|webp|gif))$/u),
  mediaType: z.string().min(1),
  bytes: z.number().int().min(1).max(32 * 1024 * 1024),
  createdAt: z.iso.datetime(),
  sessionId: z.string().min(1).optional(),
  galleryId: z.string().min(1).optional(),
  attachmentId: z.string().min(1).optional(),
}).strict()

export const fileDomainSpec = defineDomain({
  name: 'files', version: 1,
  tables: { files: domainTable<ManagedFileRecord['id'], ManagedFileRecord>(managedFileSchema) },
})
