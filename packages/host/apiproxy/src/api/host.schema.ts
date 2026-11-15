/**
 * host domain zod schemas (names derived from map keys).
 */

import { z } from 'zod'
import type { DirectoryEntry } from './host.ts'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** host.describe 请求 payload（空对象字面量）。 */
export const hostDescribeRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.describe'>>>

/** host.describe 响应值。 */
export const hostDescribeValueSchema = z.object({
  version: z.string(),
  cwd: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  attachedSessions: z.number().int().nonnegative(),
  home: z.string(),
  canOpenPath: z.boolean(),
  managedHostToken: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.describe'>>>

/** host.pickDirectory request payload (empty object literal). */
export const hostPickDirectoryRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.pickDirectory'>>>

/** host.pickDirectory response value; null means the user cancelled. */
export const hostPickDirectoryValueSchema = z.object({
  path: z.string().nullable(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.pickDirectory'>>>

/** Directory row shared by listing entries and breadcrumb crumbs. */
export const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  hidden: z.boolean(),
}) satisfies z.ZodType<Wire<DirectoryEntry>>

/** host.listDirectory request payload; an absent path lists the home directory. */
export const hostListDirectoryRequestSchema = z.object({
  path: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.listDirectory'>>>

/** host.listDirectory response value. */
export const hostListDirectoryValueSchema = z.object({
  path: z.string(),
  home: z.string(),
  crumbs: z.array(directoryEntrySchema),
  entries: z.array(directoryEntrySchema),
  files: z.array(directoryEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.listDirectory'>>>

/**
 * 建目录与改名的共用 payload：`name` 必须是一个普通路径段。wire 栅栏在这里，
 * 后端对直连服务调用方重复同一道栅栏。
 */
const directorySegmentPayloadSchema = z.object({
  path: z.string(),
  name: z.string(),
}).refine(
  payload => payload.name.trim() !== '' && payload.name !== '.' && payload.name !== '..'
    && !/[/\\]/.test(payload.name),
  { message: 'name must be a single non-blank path segment' },
)

/** host.createDirectory request payload：name 必须是单个普通路径段。 */
export const hostCreateDirectoryRequestSchema = directorySegmentPayloadSchema satisfies z.ZodType<Wire<RequestPayload<'host.createDirectory'>>>

/** host.createDirectory response value: the created directory's absolute path. */
export const hostCreateDirectoryValueSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.createDirectory'>>>

/** host.renameDirectoryEntry request payload：目标路径加上新的单段名称。 */
export const hostRenameDirectoryEntryRequestSchema = directorySegmentPayloadSchema satisfies z.ZodType<Wire<RequestPayload<'host.renameDirectoryEntry'>>>

/** host.renameDirectoryEntry response value: the entry's absolute path under its new name. */
export const hostRenameDirectoryEntryValueSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.renameDirectoryEntry'>>>

/** host.deleteDirectoryEntry request payload. */
export const hostDeleteDirectoryEntryRequestSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.deleteDirectoryEntry'>>>

/** host.deleteDirectoryEntry response value. */
export const hostDeleteDirectoryEntryValueSchema = z.object({
  deleted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'host.deleteDirectoryEntry'>>>

/** host.openPath request payload. */
export const hostOpenPathRequestSchema = z.object({
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'host.openPath'>>>

/** host.openPath response value. */
export const hostOpenPathValueSchema = z.object({
  opened: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'host.openPath'>>>
