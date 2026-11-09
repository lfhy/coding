/** 本机 Session 工作区的拖放文件暂存；该协议不经过远端文件系统 provider。 */

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { isAbsolute, join, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from 'coding-session'
import { remoteWorkspacePath } from 'coding-subprocess'
import type { OpenInAppAttachPayload } from './shared.ts'

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024
const MAX_SESSION_ID_BYTES = 1024
/** 编码后的文件名头上限；解码后再按落盘上限截断，因此超长名称不会被直接拒绝。 */
const MAX_ENCODED_FILE_NAME_BYTES = 4 * 1024
/** 落盘文件名（不含随机前缀）的 UTF-8 字节上限，为目录与 UUID 前缀留出余量。 */
const MAX_FILE_NAME_BYTES = 120
const FALLBACK_STEM = 'file'
const UPLOAD_DIRECTORY = '.dsh-uploads'

type AttachFailure = { readonly ok: false; readonly status: 400 | 403 | 404 | 409 | 413 | 415; readonly message: string }
type AttachResult = { readonly ok: true; readonly payload: OpenInAppAttachPayload } | AttachFailure

/** 本次上传创建的目录事实，用于提交点复核。 */
interface UploadDirectory {
  readonly path: string
  /** `realpath(cwd)`；与目录 realpath 一起确认 `.dsh-uploads` 仍是 cwd 的真实子目录。 */
  readonly root: string
  /** 提交点复核目录身份，拒绝路径被换成其他目录后的悬空引用。 */
  readonly identity: { readonly dev: number; readonly ino: number }
}

/** 本次上传独占创建的文件及其身份，用于只删除自己写下的文件。 */
interface UploadFile {
  readonly handle: FileHandle
  readonly path: string
  readonly identity: { readonly dev: number; readonly ino: number }
}

const failure = (status: AttachFailure['status'], message: string): AttachFailure => ({ ok: false, status, message })

function loopbackIpv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/** 即使 connection 实现配置了其他可信宿主，文件写入仍须来自本机回环同源请求。 */
function localSameOrigin(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  const peer = address?.startsWith('::ffff:') ? address.slice(7) : address
  if (peer !== '::1' && (peer === undefined || !loopbackIpv4(peer))) return false
  const authority = req.headers.host
  if (typeof authority !== 'string' || authority.length > 255) return false
  let host: URL
  try {
    host = new URL(`http://${authority}`)
  } catch {
    return false
  }
  if (host.host !== authority.toLowerCase()
    || (host.hostname !== 'localhost' && host.hostname !== '[::1]' && !loopbackIpv4(host.hostname))) return false
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).origin === host.origin
  } catch {
    return false
  }
}

function headerValue(value: string | string[] | undefined, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes
    || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined
  return value
}

/** 与浏览器暂存路径校验一致；不保留组合符号、emoji 或其他标点。 */
const UNSAFE_FILE_NAME = /[^\p{L}\p{N} ._-]/gu
const SAFE_EXTENSION = /^[A-Za-z0-9]{1,16}$/u
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu
const REPLACEMENT = '_'

function truncateBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let kept = ''
  let bytes = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    kept += character
    bytes += size
  }
  return kept
}

/**
 * 把浏览器给出的文件名规范成可安全引用、可安全落盘的替代名。
 *
 * 拖放的文件即使名字含引号、百分号、控制字符或目录分隔符也仍然要转成路径，
 * 因此这里选择规范化而不是拒绝：取最后一段路径、合成重音、把字母数字、
 * 空格与 `._-` 以外的字符替换成 `_`，避免连续点与客户端路径校验冲突，并保留
 * 安全扩展名（例如 `.pptx`）；最后按 UTF-8 字节上限截断且不切断字符。仅缺失、
 * 无法解码或规范化后没有任何可见名字时返回 undefined 让调用方明确拒绝。
 * @param value - `x-file-name` 头里的 `encodeURIComponent(file.name)`。
 * @returns 可落盘且可直接插进 `@file` 引用的文件名；没有有意义名称时返回 undefined。
 */
function portableFileName(value: string | string[] | undefined): string | undefined {
  const encoded = headerValue(value, MAX_ENCODED_FILE_NAME_BYTES)
  if (encoded === undefined) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    return undefined
  }
  const lastSegment = decoded.split(/[\\/]/u).at(-1) ?? ''
  const trimmed = lastSegment.normalize('NFC').replace(/^[. ]+/u, '').replace(/[. ]+$/u, '')
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return undefined
  const dot = trimmed.lastIndexOf('.')
  const extension = dot > 0 && SAFE_EXTENSION.test(trimmed.slice(dot + 1)) ? trimmed.slice(dot + 1) : ''
  const suffix = extension === '' ? 0 : extension.length + 1
  const stem = truncateBytes(
    (dot > 0 ? trimmed.slice(0, dot) : trimmed)
      .replace(UNSAFE_FILE_NAME, REPLACEMENT)
      .replace(/_+/gu, REPLACEMENT)
      .replace(/\.{2,}/gu, REPLACEMENT)
      .replace(/^[._ ]+|[._ ]+$/gu, ''),
    MAX_FILE_NAME_BYTES - suffix,
  ).replace(/[._ ]+$/u, '')
  const name = `${stem === '' ? FALLBACK_STEM : stem}${extension === '' ? '' : `.${extension}`}`
  return WINDOWS_RESERVED.test(name) ? `${REPLACEMENT}${name}` : name
}

/**
 * 解析 Session 的暂存目录，并在创建或复用后确认它仍是 cwd 的真实子目录。
 * @param cwd - Session header 持有的工作目录。
 * @returns 可用于落盘的目录与 cwd realpath；cwd 或 `.dsh-uploads` 是 symlink 时返回 undefined。
 */
async function uploadDirectoryFor(cwd: string): Promise<UploadDirectory | undefined> {
  const directory = join(cwd, UPLOAD_DIRECTORY)
  try {
    const workspace = await lstat(cwd)
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) return undefined
    // macOS 的 /var 会解析成 /private/var；以真实父目录校验子目录，不把别名当作可逃逸路径。
    const root = await realpath(cwd)
    try {
      await mkdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
    }
    const entry = await lstat(directory)
    if (!entry.isDirectory() || entry.isSymbolicLink()) return undefined
    if (await realpath(directory) !== join(root, UPLOAD_DIRECTORY)) return undefined
    return { path: directory, root, identity: { dev: entry.dev, ino: entry.ino } }
  } catch {
    return undefined
  }
}

/** 以 O_EXCL 与随机前缀独占创建落盘文件，从不覆盖同目录的既有文件。 */
async function createUploadFile(directory: string, fileName: string): Promise<UploadFile | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const path = join(directory, `${randomUUID()}-${fileName}`)
    try {
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        const stats = await handle.stat()
        return { handle, path, identity: { dev: stats.dev, ino: stats.ino } }
      } catch {
        await handle.close().catch(() => {})
        await unlink(path).catch(() => {})
        return undefined
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
    }
  }
  return undefined
}

/**
 * 删除本次上传创建的文件。
 *
 * 以 inode 身份校验路径，目录在上传期间被替换成指向别处的 symlink 时不会误删
 * 别人的文件；目录被重命名时，仅在原工作区内找到相同目录身份才清理自己的文件。
 * @param directory - 创建时记录的目录与根身份。
 * @param upload - 创建时记录的文件路径与 inode。
 */
async function removeOwnedFile(directory: UploadDirectory, upload: UploadFile): Promise<void> {
  const fileName = upload.path.slice(directory.path.length + sep.length)
  async function unlinkMatching(path: string): Promise<boolean> {
    try {
      const entry = await lstat(path)
      if (entry.isSymbolicLink() || entry.dev !== upload.identity.dev || entry.ino !== upload.identity.ino) return false
      await unlink(path)
      return true
    } catch {
      return false
    }
  }
  if (await unlinkMatching(upload.path)) return
  // 被重命名的目录不能通过原路径到达；只在 cwd 当前一级找回同一目录 inode，
  // 不遍历外部路径、不删除 inode 不匹配的同名文件。
  try {
    const rootEntry = await lstat(directory.root)
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return
    const siblings = await readdir(directory.root)
    for (const name of siblings) {
      if (name === UPLOAD_DIRECTORY) continue
      const candidate = join(directory.root, name)
      const entry = await lstat(candidate)
      if (entry.isDirectory() && !entry.isSymbolicLink()
        && entry.dev === directory.identity.dev && entry.ino === directory.identity.ino) {
        await unlinkMatching(join(candidate, fileName))
        return
      }
    }
  } catch {
    // 工作区本身不可用时无法安全定位原目录，只清理仍可核实身份的文件。
  }
}

/**
 * 只把完整且不超过 32 MiB 的原始字节写进本机 live Session 的工作区。
 *
 * 字节写完后再确认提交：Session 仍是同一个 live 实例、cwd 未变、暂存目录仍是
 * 同一个真实子目录，才把相对路径交给浏览器。上传期间 Session 被删除、重绑或
 * 工作区被替换时，已写入的文件会被删除并返回失败，客户端永远不会拿到指向旧
 * Session 或旧工作区的路径。
 * @param ctx - 提供 live Session 的 Host 上下文。
 * @param req - 原始 HTTP 请求流与编码文件名头。
 * @param ssh - Host 是否由 SSH 启动；此模式不能向本机写入拖放文件。
 * @returns 成功时的工作区相对路径，失败时无内部路径的 4xx 信息。
 */
export async function attachWorkspaceFile(ctx: Context, req: IncomingMessage, ssh: boolean): Promise<AttachResult> {
  if (!localSameOrigin(req)) return failure(403, 'file upload requires a local same-origin request')
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/octet-stream') {
    return failure(415, 'content-type must be application/octet-stream')
  }
  const sessionId = headerValue(req.headers['x-session-id'], MAX_SESSION_ID_BYTES)
  const fileName = portableFileName(req.headers['x-file-name'])
  if (sessionId === undefined) return failure(400, 'x-session-id must be a non-empty session id')
  if (fileName === undefined) return failure(400, 'x-file-name must name a file')
  const length = req.headers['content-length']
  if (length !== undefined && Number(length) > MAX_UPLOAD_BYTES) return failure(413, 'file exceeds 32 MiB')
  if (ssh) return failure(409, 'file upload is unavailable for remote workspaces')
  const session = ctx.sessions.get(SessionId(sessionId))
  if (session === undefined) return failure(404, 'session is not live')
  const cwd = session.header.cwd
  if (cwd === undefined || !isAbsolute(cwd) || cwd.includes('\0')) {
    return failure(409, 'session has no local workspace')
  }
  try {
    if (await remoteWorkspacePath(cwd, cwd) !== undefined) {
      return failure(409, 'file upload is unavailable for remote workspaces')
    }
  } catch {
    return failure(409, 'file upload is unavailable for remote workspaces')
  }
  const directory = await uploadDirectoryFor(cwd)
  if (directory === undefined) return failure(409, 'workspace upload directory is unavailable')
  const upload = await createUploadFile(directory.path, fileName)
  if (upload === undefined) return failure(409, 'workspace upload is unavailable')

  let rejection: AttachFailure = failure(400, 'file upload could not be completed')
  try {
    let size = 0
    // 不以 Content-Length 代替流限额；短报头、分块传输与大块载荷同样受到约束。
    for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
      size += chunk.byteLength
      if (size > MAX_UPLOAD_BYTES) {
        rejection = failure(413, 'file exceeds 32 MiB')
        req.resume()
        break
      }
      let offset = 0
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await upload.handle.write(chunk, offset, chunk.byteLength - offset)
        if (bytesWritten === 0) throw new Error('upload write stalled')
        offset += bytesWritten
      }
    }
    if (rejection.status === 413) throw new Error('upload limit exceeded')
    const current = ctx.sessions.get(SessionId(sessionId))
    if (current === undefined) {
      rejection = failure(404, 'session is no longer live')
      throw new Error('session was removed during upload')
    }
    if (current !== session || current.header.cwd !== cwd) {
      rejection = failure(409, 'session workspace changed during upload')
      throw new Error('session was re-bound during upload')
    }
    const confirmed = await uploadDirectoryFor(cwd)
    if (confirmed === undefined || confirmed.path !== directory.path || confirmed.root !== directory.root
      || confirmed.identity.dev !== directory.identity.dev || confirmed.identity.ino !== directory.identity.ino) {
      rejection = failure(409, 'workspace upload directory changed during upload')
      throw new Error('workspace upload directory changed during upload')
    }
    const fileStats = await lstat(upload.path)
    if (!fileStats.isFile() || fileStats.dev !== upload.identity.dev || fileStats.ino !== upload.identity.ino) {
      rejection = failure(409, 'workspace upload file changed during upload')
      throw new Error('workspace upload file changed during upload')
    }
    await upload.handle.close()
    return {
      ok: true,
      payload: { path: `${UPLOAD_DIRECTORY}/${upload.path.slice(directory.path.length + sep.length)}` },
    }
  } catch {
    await upload.handle.close().catch(() => {})
    await removeOwnedFile(directory, upload)
    return rejection
  }
}
