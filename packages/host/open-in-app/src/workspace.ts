/** Session 绑定的工作区路径解析、目录列表与有界文件预览。 */

import type { Context } from '@deepseek-ai/cordis'
import { FsVersion } from 'coding-fs'
import type { FsDirEntry, FsTarget } from 'coding-fs'
import { SessionId } from 'coding-session'
import type {} from 'coding-session-persistence'
import type {} from 'coding-sandbox-policy'
import type {
  OpenInAppFileEntry,
  OpenInAppFilesPayload,
  OpenInAppFilesRequest,
  OpenInAppLocatePayload,
  OpenInAppLocateRequest,
  OpenInAppReadPayload,
  OpenInAppReadRequest,
  OpenInAppSavePayload,
  OpenInAppSaveRequest,
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
    readonly status: 400 | 403 | 404 | 409 | 413,
    readonly code: 'bad-request' | 'session-not-found' | 'workspace-unavailable' | 'not-found'
      | 'file-conflict' | 'file-too-large' | 'file-readonly',
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

function parseRequest(
  value: unknown,
  requireFile: boolean,
  extraKeys: readonly string[] = [],
): OpenInAppFilesRequest | undefined {
  const body = recordOf(value)
  if (body === undefined
    || Object.keys(body).some(key => key !== 'sessionId' && key !== 'segments' && !extraKeys.includes(key))
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
 * 解析封闭的版本化保存请求，并在解析点执行完整内容字节上限。
 * @param value - JSON 请求体。
 * @param maxBytes - 单个文本文件允许的最大字节数。
 * @returns 通过校验的保存请求；畸形或含多余字段时返回 undefined。
 * @throws {WorkspaceProtocolError} 完整内容超过 maxBytes 时返回 413。
 */
export function parseSaveRequest(value: unknown, maxBytes: number): OpenInAppSaveRequest | undefined {
  const path = parseRequest(value, true, ['baseVersion', 'content'])
  const body = recordOf(value)
  if (path === undefined || body === undefined
    || typeof body.baseVersion !== 'string' || body.baseVersion.length === 0
    || Buffer.byteLength(body.baseVersion, 'utf8') > 4_096
    || typeof body.content !== 'string' || body.content.includes(NUL)) return undefined
  if (Buffer.byteLength(body.content, 'utf8') > maxBytes) {
    throw new WorkspaceProtocolError(413, 'file-too-large', 'workspace file is too large to save')
  }
  return { ...path, baseVersion: body.baseVersion, content: body.content }
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

/**
 * 读出 Session 的工作区根路径。
 *
 * 文件树与预览只需要会话的 cwd 与执行世界，与「该会话此刻是否在 Host 内存里
 * 运行」无关：持久化过的会话在 Host 重启后是冷的，浏览器侧仍能复用它读写文件。
 * 因此 live 会话优先，其次读持久化 header，两者都没有才报 session-not-found。
 * 结果按本 Host 组合缓存——会话 header 的 cwd 在会话生命周期内不变，而列表读取
 * 每次都要扫一遍持久化目录。
 * @param ctx - 携带 Session store 与可选持久化的 Host 上下文。
 * @param sessionId - 请求里的会话身份。
 * @returns 该会话 cwd 的绝对路径。
 */
async function sessionCwdOf(ctx: Context, sessionId: string): Promise<string> {
  const cache = cwdCacheOf(ctx)
  const live = ctx.sessions.get(SessionId(sessionId))
  if (live !== undefined) {
    const cwd = live.header.cwd
    if (cwd === undefined) {
      throw new WorkspaceProtocolError(409, 'workspace-unavailable', 'session has no workspace directory')
    }
    cache.set(sessionId, cwd)
    return cwd
  }
  const cached = cache.get(sessionId)
  if (cached !== undefined) return cached
  const persistence = ctx.get('sessionPersistence')
  const stored = persistence === undefined
    ? undefined
    : (await persistence.list()).find(header => header.id === sessionId)
  if (stored === undefined) {
    throw new WorkspaceProtocolError(404, 'session-not-found', `session is unknown: ${sessionId}`)
  }
  if (stored.cwd === undefined) {
    throw new WorkspaceProtocolError(409, 'workspace-unavailable', 'session has no workspace directory')
  }
  cache.set(sessionId, stored.cwd)
  return stored.cwd
}

/** 每个 Host 组合一份会话到 cwd 的缓存；键来自不可变 header，不含凭据或用户输入。 */
const cwdCaches = new WeakMap<Context, Map<string, string>>()

function cwdCacheOf(ctx: Context): Map<string, string> {
  let cache = cwdCaches.get(ctx)
  if (cache === undefined) {
    cache = new Map<string, string>()
    cwdCaches.set(ctx, cache)
  }
  return cache
}

async function rootFor(ctx: Context, sessionId: string): Promise<FsTarget> {
  const cwd = await sessionCwdOf(ctx, sessionId)
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
  const cwd = await sessionCwdOf(ctx, request.sessionId)
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
): Promise<{ readonly entry: FsDirEntry; readonly target: FsTarget; readonly version: string }> {
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
  return { entry: currentEntry, target: entry.target, version: String(current.version) }
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
  version: string,
  reason: 'binary' | 'too-large',
): OpenInAppReadPayload {
  return {
    kind: 'unsupported',
    reason,
    displayPath: target.displayPath,
    name: entry.name,
    truncated: reason === 'too-large',
    version,
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
  const { entry, target, version } = await fileEntry(ctx, request)
  if (entry.size !== undefined && entry.size > maxBytes) return unsupported(entry, target, version, 'too-large')
  let bytes: Uint8Array
  try {
    bytes = await ctx.fs.readBytes(target, undefined, maxBytes)
  } catch (error) {
    if (tooLarge(error)) return unsupported(entry, target, version, 'too-large')
    throw error
  }
  if (bytes.byteLength > maxBytes) return unsupported(entry, target, version, 'too-large')
  const base = { displayPath: target.displayPath, name: entry.name, truncated: false, version } as const
  const mime = IMAGE_MIME_TYPES[extensionOf(entry.name)]
  if (mime !== undefined) {
    return { ...base, kind: 'image', mime, dataBase64: Buffer.from(bytes).toString('base64') }
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return unsupported(entry, target, version, 'binary')
  }
  if (text.includes(NUL)) return unsupported(entry, target, version, 'binary')
  return { ...base, kind: 'text', format: textFormat(entry.name), text }
}

/** 将文件系统保存失败映射为浏览器可恢复的稳定协议错误。 */
function saveFailure(error: unknown): WorkspaceProtocolError | undefined {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
  if (code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED') {
    return new WorkspaceProtocolError(409, 'file-conflict', 'workspace file changed since it was read')
  }
  if (code === 'FS_NOT_FOUND') return workspaceUnavailable('workspace file is unavailable')
  if (code === 'FS_TOO_LARGE') {
    return new WorkspaceProtocolError(413, 'file-too-large', 'workspace file is too large to save')
  }
  if (code === 'FS_SANDBOX_DENIED' || code === 'FS_PERMISSION_DENIED') {
    return new WorkspaceProtocolError(403, 'file-readonly', 'workspace file is not writable')
  }
  if (code === 'FS_NOT_TEXT' || code === 'FS_NOT_REGULAR_FILE') {
    return new WorkspaceProtocolError(400, 'bad-request', 'workspace save target must remain a text file')
  }
  return undefined
}

/**
 * 按读取版本原子保存已有文本文件；Session 策略与工作区包含关系都在 Host 执行世界复核。
 * @param ctx - 携带 Session store、组合文件系统与可选沙箱策略的 Host 上下文。
 * @param request - 已验证的 Session、路径段、基础版本与完整内容。
 * @returns 新版本及本次写入类型。
 */
export async function saveWorkspaceFile(
  ctx: Context,
  request: OpenInAppSaveRequest,
): Promise<OpenInAppSavePayload> {
  const { entry, target } = await fileEntry(ctx, request)
  // 冷会话（Host 重启后尚未恢复）仍可写入：沙箱策略退化为工作区根，版本校验不变。
  const session = ctx.sessions.get(SessionId(request.sessionId))
  const policy = session === undefined
    ? ctx.get('sandboxPolicy')?.resolve({})
    : ctx.get('sandboxPolicy')?.resolve({ session })
  try {
    const outcome = await ctx.fs.writeText(
      target,
      request.content,
      { kind: 'replaceIfVersion', version: FsVersion(request.baseVersion) },
      undefined,
      policy,
    )
    return {
      displayPath: target.displayPath,
      name: entry.name,
      version: String(outcome.version),
      operation: outcome.operation,
    }
  } catch (error) {
    const failure = saveFailure(error)
    if (failure !== undefined) throw failure
    throw error
  }
}
