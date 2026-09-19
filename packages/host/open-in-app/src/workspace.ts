/** Session 绑定的工作区路径解析、目录列表与有界文件预览。 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  OpenInAppFileEntry,
  OpenInAppFilesPayload,
  OpenInAppFilesRequest,
  OpenInAppReadPayload,
  OpenInAppReadRequest,
} from './shared.ts'

const MAX_FILE_SEGMENTS = 64
const MAX_FILE_PATH_BYTES = 8 * 1024
const MAX_SESSION_ID_BYTES = 1024
const MAX_FILE_ENTRIES = 2_000
const NUL = String.fromCharCode(0)

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const CODE_EXTENSIONS = new Set([
  'bat', 'bash', 'c', 'cc', 'cjs', 'cmd', 'cpp', 'cs', 'css', 'fish', 'go',
  'graphql', 'h', 'hpp', 'htm', 'html', 'java', 'js', 'json', 'jsonc', 'jsx',
  'kt', 'kts', 'mjs', 'php', 'ps1', 'py', 'rb', 'rs', 'scss', 'sh', 'sql',
  'svelte', 'swift', 'toml', 'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml', 'zsh',
])
const CODE_FILENAMES = new Set(['dockerfile', 'makefile'])

/** HTTP 层可安全呈现的工作区协议错误。 */
export class WorkspaceProtocolError extends Error {
  /**
   * @param status - HTTP 状态码。
   * @param code - 稳定 wire 错误码。
   * @param message - 不含 provider 身份或凭据的诊断。
   */
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: 'bad-request' | 'session-not-found' | 'workspace-unavailable' | 'not-found',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceProtocolError'
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseRequest(value: unknown, requireFile: boolean): OpenInAppFilesRequest | undefined {
  const body = recordOf(value)
  if (body === undefined
    || Object.keys(body).some(key => key !== 'sessionId' && key !== 'segments')
    || typeof body.sessionId !== 'string'
    || body.sessionId.length === 0
    || body.sessionId.includes(NUL)
    || Buffer.byteLength(body.sessionId, 'utf8') > MAX_SESSION_ID_BYTES
    || !Array.isArray(body.segments)
    || body.segments.length > MAX_FILE_SEGMENTS
    || (requireFile && body.segments.length === 0)) return undefined
  const segments: string[] = []
  let bytes = 0
  for (const segment of body.segments) {
    if (typeof segment !== 'string' || segment.length === 0 || segment.includes(NUL)) return undefined
    bytes += Buffer.byteLength(segment, 'utf8')
    if (bytes > MAX_FILE_PATH_BYTES) return undefined
    segments.push(segment)
  }
  return { sessionId: body.sessionId, segments }
}

/**
 * 解析封闭的目录列表请求。
 * @param value - JSON 请求体。
 * @returns 通过校验的 Session 与路径段；畸形或含多余字段时返回 undefined。
 */
export function parseFilesRequest(value: unknown): OpenInAppFilesRequest | undefined {
  return parseRequest(value, false)
}

/**
 * 解析封闭的文件预览请求。
 * @param value - JSON 请求体。
 * @returns 至少含一个路径段的请求；畸形或含多余字段时返回 undefined。
 */
export function parseReadRequest(value: unknown): OpenInAppReadRequest | undefined {
  return parseRequest(value, true)
}

function workspaceUnavailable(message: string): WorkspaceProtocolError {
  return new WorkspaceProtocolError(404, 'not-found', message)
}

async function rootFor(ctx: Context, sessionId: string): Promise<FsTarget> {
  const session = ctx.sessions.get(SessionId(sessionId))
  if (session === undefined) {
    throw new WorkspaceProtocolError(404, 'session-not-found', `session is not live: ${sessionId}`)
  }
  const cwd = session.header.cwd
  if (cwd === undefined) {
    throw new WorkspaceProtocolError(409, 'workspace-unavailable', 'session has no workspace directory')
  }
  return ctx.fs.resolve(cwd, { cwd })
}

async function descendDirectories(
  ctx: Context,
  root: FsTarget,
  segments: readonly string[],
): Promise<FsTarget> {
  let target = root
  for (const segment of segments) {
    const children = await ctx.fs.listDir(target)
    const child = children.find(entry => entry.name === segment)
    if (child === undefined || child.type !== 'directory' || !ctx.fs.contains(root, child.target)) {
      throw workspaceUnavailable('workspace directory is unavailable')
    }
    target = child.target
  }
  return target
}

function wireEntry(entry: FsDirEntry): OpenInAppFileEntry {
  return {
    name: entry.name,
    type: entry.type,
    ...entry.size === undefined ? {} : { size: entry.size },
  }
}

/**
 * 列出 Session 工作区中的一层目录。
 * @param ctx - 携带 Session store 与组合文件系统的 Host 上下文。
 * @param request - 已验证的 Session id 和 provider 名称段。
 * @returns 有界目录项及 provider 展示路径。
 */
export async function listWorkspaceFiles(
  ctx: Context,
  request: OpenInAppFilesRequest,
): Promise<OpenInAppFilesPayload> {
  const root = await rootFor(ctx, request.sessionId)
  const target = await descendDirectories(ctx, root, request.segments)
  const listed = await ctx.fs.listDir(target)
  const entries = listed.slice(0, MAX_FILE_ENTRIES).map(wireEntry)
  return {
    displayPath: target.displayPath,
    entries,
    truncated: listed.length > entries.length,
  }
}

async function fileEntry(
  ctx: Context,
  request: OpenInAppReadRequest,
): Promise<{ readonly entry: FsDirEntry; readonly target: FsTarget }> {
  const root = await rootFor(ctx, request.sessionId)
  const parent = await descendDirectories(ctx, root, request.segments.slice(0, -1))
  const name = request.segments.at(-1) as string
  const entry = (await ctx.fs.listDir(parent)).find(candidate => candidate.name === name)
  if (entry === undefined || !ctx.fs.contains(root, entry.target)) {
    throw workspaceUnavailable('workspace file is unavailable')
  }
  if (entry.type !== 'file') {
    throw new WorkspaceProtocolError(400, 'bad-request', 'workspace preview target must be a file')
  }
  const current = await ctx.fs.stat(entry.target)
  if (current === undefined) throw workspaceUnavailable('workspace file is unavailable')
  if (current.type !== 'file') {
    throw new WorkspaceProtocolError(400, 'bad-request', 'workspace preview target must remain a file')
  }
  const { size: _listedSize, ...withoutSize } = entry
  const currentEntry: FsDirEntry = current.size === undefined
    ? withoutSize
    : { ...withoutSize, size: current.size }
  return { entry: currentEntry, target: entry.target }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

function textFormat(name: string): 'markdown' | 'code' | 'text' {
  const extension = extensionOf(name)
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (CODE_EXTENSIONS.has(extension) || CODE_FILENAMES.has(name.toLowerCase())) return 'code'
  return 'text'
}

function unsupported(
  entry: FsDirEntry,
  target: FsTarget,
  reason: 'binary' | 'too-large',
): OpenInAppReadPayload {
  return {
    kind: 'unsupported',
    reason,
    displayPath: target.displayPath,
    name: entry.name,
    truncated: reason === 'too-large',
  }
}

function tooLarge(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'FS_TOO_LARGE'
}

/**
 * 读取一个有界文件预览。图片返回完整 base64；文本要求严格 UTF-8 且不含 NUL。
 * @param ctx - 携带 Session store 与组合文件系统的 Host 上下文。
 * @param request - 已验证且至少含一个路径段的请求。
 * @param maxBytes - 单个预览允许读取的最大字节数。
 * @returns 文本、图片或不携带原始内容的 unsupported 响应。
 */
export async function readWorkspaceFile(
  ctx: Context,
  request: OpenInAppReadRequest,
  maxBytes: number,
): Promise<OpenInAppReadPayload> {
  const { entry, target } = await fileEntry(ctx, request)
  if (entry.size !== undefined && entry.size > maxBytes) return unsupported(entry, target, 'too-large')
  let bytes: Uint8Array
  try {
    bytes = await ctx.fs.readBytes(target, undefined, maxBytes)
  } catch (error) {
    if (tooLarge(error)) return unsupported(entry, target, 'too-large')
    throw error
  }
  if (bytes.byteLength > maxBytes) return unsupported(entry, target, 'too-large')
  const base = { displayPath: target.displayPath, name: entry.name, truncated: false } as const
  const mime = IMAGE_MIME_TYPES[extensionOf(entry.name)]
  if (mime !== undefined) {
    return { ...base, kind: 'image', mime, dataBase64: Buffer.from(bytes).toString('base64') }
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return unsupported(entry, target, 'binary')
  }
  if (text.includes(NUL)) return unsupported(entry, target, 'binary')
  return { ...base, kind: 'text', format: textFormat(entry.name), text }
}
