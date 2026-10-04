/**
 * workspace domain zod schemas (names derived from map keys). The
 * WorkspaceId brand cast lives in sessions.schema (see the note there) and
 * is re-exported here as the domain-local name.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { WorkspaceView, GitChangedFile, GitStatus, GitBranches, GitOperationResult } from './workspace.ts'
import { sessionIdSchema, workspaceIdSchema } from './sessions.schema.ts'

export { workspaceIdSchema } from './sessions.schema.ts'

/** WorkspaceView row of every workspace.* response. */
export const workspaceViewSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(sessionIdSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<Wire<WorkspaceView>>

/** workspace.list request payload (empty object literal). */
export const workspaceListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'workspace.list'>>>

/** workspace.list response value. */
export const workspaceListValueSchema = z.object({
  items: z.array(workspaceViewSchema),
  archivedSessionIds: z.array(sessionIdSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.list'>>>

/** Git RPC 仅接受会话 id；工作目录始终由 Host 从会话头推导。 */
const gitRequestSchema = z.strictObject({ sessionId: sessionIdSchema })
export const workspaceGitStatusRequestSchema = gitRequestSchema satisfies z.ZodType<Wire<RequestPayload<'workspace.gitStatus'>>>
export const workspaceGitBranchesRequestSchema = gitRequestSchema satisfies z.ZodType<Wire<RequestPayload<'workspace.gitBranches'>>>
export const workspaceGitCheckoutRequestSchema = gitRequestSchema.extend({ branch: z.string().min(1) }) satisfies z.ZodType<Wire<RequestPayload<'workspace.gitCheckout'>>>
const gitCredentialsSchema = z.strictObject({ username: z.string().min(1).max(1024), password: z.string().min(1).max(8192) })
export const workspaceGitPushRequestSchema = gitRequestSchema.extend({ credentials: gitCredentialsSchema.optional() }) satisfies z.ZodType<Wire<RequestPayload<'workspace.gitPush'>>>
export const workspaceGitPullRequestSchema = gitRequestSchema.extend({ credentials: gitCredentialsSchema.optional() }) satisfies z.ZodType<Wire<RequestPayload<'workspace.gitPull'>>>

const gitChangedFileSchema = z.strictObject({
  path: z.string(), status: z.string(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
}) satisfies z.ZodType<Wire<GitChangedFile>>
const gitStatusSchema = z.strictObject({
  branch: z.string().nullable(), ahead: z.number().int().nonnegative(), behind: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), files: z.array(gitChangedFileSchema),
}) satisfies z.ZodType<Wire<GitStatus>>
const gitOperationSchema = z.strictObject({
  branch: z.string().nullable(), commitCreated: z.boolean(), commit: z.string().optional(),
}) satisfies z.ZodType<Wire<GitOperationResult>>
export const workspaceGitStatusValueSchema = gitStatusSchema.nullable() satisfies z.ZodType<Wire<ResponseValue<'workspace.gitStatus'>>>
const gitBranchesSchema = z.strictObject({
  branches: z.array(z.string()), current: z.string().nullable(),
}) satisfies z.ZodType<Wire<GitBranches>>
export const workspaceGitBranchesValueSchema = gitBranchesSchema.nullable() satisfies z.ZodType<Wire<ResponseValue<'workspace.gitBranches'>>>
export const workspaceGitCheckoutValueSchema = gitStatusSchema satisfies z.ZodType<Wire<ResponseValue<'workspace.gitCheckout'>>>
export const workspaceGitPushValueSchema = gitOperationSchema satisfies z.ZodType<Wire<ResponseValue<'workspace.gitPush'>>>
export const workspaceGitPullValueSchema = gitOperationSchema satisfies z.ZodType<Wire<ResponseValue<'workspace.gitPull'>>>

/** workspace.create 请求：已有目录路径与仅用于新记录的可选非空标题。 */
export const workspaceCreateRequestSchema = z.object({
  path: z.string(),
  title: z.string().trim().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.create'>>>

/** workspace.create response value. */
export const workspaceCreateValueSchema = z.object({
  workspace: workspaceViewSchema,
  created: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.create'>>>

/** workspace.rename request payload: the new title must be non-blank. */
export const workspaceRenameRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  title: z.string(),
}).refine(
  payload => payload.title.trim() !== '',
  { message: 'workspace.rename requires a non-blank title' },
) satisfies z.ZodType<Wire<RequestPayload<'workspace.rename'>>>

/** workspace.rename response value. */
export const workspaceRenameValueSchema = z.object({
  workspace: workspaceViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.rename'>>>

/** workspace.delete request payload. */
export const workspaceDeleteRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.delete'>>>

/** workspace.delete response value. */
export const workspaceDeleteValueSchema = z.object({
  deleted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.delete'>>>

/** workspace.insertBefore request payload (anchor omitted = append to end). */
export const workspaceInsertBeforeRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  beforeWorkspaceId: workspaceIdSchema.optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.insertBefore'>>>

/** workspace.insertBefore response value: the complete durable display order. */
export const workspaceInsertBeforeValueSchema = z.object({
  workspaceIds: z.array(workspaceIdSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.insertBefore'>>>

/** workspace.insertSessionBefore request payload (anchor omitted = append to end). */
export const workspaceInsertSessionBeforeRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  sessionId: sessionIdSchema,
  beforeSessionId: sessionIdSchema.optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.insertSessionBefore'>>>

/** workspace.insertSessionBefore response value. */
export const workspaceInsertSessionBeforeValueSchema = z.object({
  workspace: workspaceViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.insertSessionBefore'>>>

/** workspace.archiveSession request payload. */
export const workspaceArchiveSessionRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.archiveSession'>>>

/** workspace.archiveSession response value: the full updated archive set. */
export const workspaceArchiveSessionValueSchema = z.object({
  archivedSessionIds: z.array(sessionIdSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.archiveSession'>>>
