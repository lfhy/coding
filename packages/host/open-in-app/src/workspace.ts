/** Session 绑定的工作区路径解析、目录列表与有界文件预览。 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsDirEntry, FsTarget } from 'coding-fs'
import { SessionId } from 'coding-session'
import type {
  OpenInAppFileEntry,
  OpenInAppFilesPayload,
  OpenInAppFilesRequest,
  OpenInAppLocatePayload,
  OpenInAppLocateRequest,
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
  webp: 'image/webp',
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const HTML_EXTENSIONS = new Set(['htm', 'html'])
const SVG_EXTENSIONS = new Set(['svg'])
const CODE_EXTENSIONS = new Set([
  'bat', 'bash', 'c', 'cc', 'cjs', 'cmd', 'cpp', 'cs', 'css', 'fish', 'go',
  'graphql', 'h', 'hpp', 'java', 'js', 'json', 'jsonc', 'jsx',
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

/**
 * 解析封闭的路径定位请求。
 * @param value - JSON 请求体。
 * @returns 通过校验的 Session 与原始路径；畸形或含多余字段时返回 undefined。
 */
export function parseLocateRequest(value: unknown): OpenInAppLocateRequest | undefined {
  const body = recordOf(value)
  if (body === undefined
    || Object.keys(body).some(key => key !== 'sessionId' && key !== 'path')
    || typeof body.sessionId !== 'string'
    || body.sessionId.length === 0
    || body.sessionId.includes(NUL)
    || Buffer.byteLength(body.sessionId, 'utf8') > MAX_SESSION_ID_BYTES
    || typeof body.path !== 'string'
    || body.path.trim().length === 0
    || body.path.includes(NUL)
    || Buffer.byteLength(body.path, 'utf8') > MAX_FILE_PATH_BYTES) return undefined
  return { sessionId: body.sessionId, path: body.path }
}

function workspaceUnavailable(message: string): WorkspaceProtocolError {
  return new WorkspaceProtocolError(404, 'not-found', message)
}

/** 读出 Session 的工作区根路径；Session 或工作区缺席时给出协议错误。 */
function sessionCwdOf(ctx: Context, sessionId: string): string {
  const session = ctx.sessions.get(SessionId(sessionId))
  if (session === undefined) {
    throw new WorkspaceProtocolError(404, 'session-not-found', `session is not live: ${sessionId}`)
  }
  const cwd = session.header.cwd
  if (cwd === undefined) {
    throw new WorkspaceProtocolError(409, 'workspace-unavailable', 'session has no workspace directory')
  }
  return cwd
}

async function rootFor(ctx: Context, sessionId: string): Promise<FsTarget> {
  const cwd = sessionCwdOf(ctx, sessionId)
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

/** 两个 provider target 是否指向同一项；只比较不透明的 target key。 */
function sameTarget(left: FsTarget, right: FsTarget): boolean {
  return String(left.targetKey) === String(right.targetKey)
}

/**
 * 逐个 provider 子项把根到目标的名称链找出来：每一层只接受 `listDir` 返回的子项，
 * 目录才能继续深入，末段必须是普通文件。返回 undefined 表示这条路径无法用名称链表达。
 */
async function segmentsToward(
  ctx: Context,
  root: FsTarget,
  target: FsTarget,
): Promise<string[] | undefined> {
  const segments: string[] = []
  let current = root
  for (let depth = 0; depth <= MAX_FILE_SEGMENTS; depth += 1) {
    // 兄弟项互不包含，因此唯一的命中项就是通往目标的下一层。
    const child = (await ctx.fs.listDir(current)).find(entry => ctx.fs.contains(entry.target, target))
    if (child === undefined) return undefined
    segments.push(child.name)
    if (sameTarget(child.target, target)) return child.type === 'file' ? segments : undefined
    current = child.target
  }
  return undefined
}

/**
 * 在 Session 自己的执行世界里把一条模型/界面路径定位成工作区内的名称链。
 *
 * 远端工作区的 cwd 是本地占位目录，模型给出的工具路径属于远端执行世界，浏览器无法自己
 * 换算；这里用 `ctx.fs.resolve` 在正确执行世界解析，并要求目标仍落在工作区根内。返回的
 * 段与 `files`／`read` 路由使用同一套 provider 子项名称，因此可以继续复用文件树与预览。
 * @param ctx - 携带 Session store 与组合文件系统的 Host 上下文。
 * @param request - 已验证的 Session 与原始路径。
 * @returns 从工作区根开始、末段为普通文件的名称链。
 */
export async function locateWorkspaceFile(
  ctx: Context,
  request: OpenInAppLocateRequest,
): Promise<OpenInAppLocatePayload> {
  const cwd = sessionCwdOf(ctx, request.sessionId)
  const root = await ctx.fs.resolve(cwd, { cwd })
  let target: FsTarget
  try {
    target = await ctx.fs.resolve(request.path, { cwd })
  } catch {
    throw workspaceUnavailable('workspace path is unavailable')
  }
  if (!ctx.fs.contains(root, target)) throw workspaceUnavailable('workspace path is unavailable')
  const segments = await segmentsToward(ctx, root, target)
  if (segments === undefined) throw workspaceUnavailable('workspace path is unavailable')
  return { segments }
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

function textFormat(name: string): 'markdown' | 'code' | 'html' | 'svg' | 'text' {
  const extension = extensionOf(name)
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (HTML_EXTENSIONS.has(extension)) return 'html'
  if (SVG_EXTENSIONS.has(extension)) return 'svg'
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
