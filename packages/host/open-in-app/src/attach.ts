/** 本机拖放文件上传的来源、Session 与原始请求流校验。 */

import { lstat, realpath } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-file-library'
import { SessionId } from 'coding-session'
import { remoteWorkspacePath } from 'coding-subprocess'
import type { OpenInAppAttachPayload } from './shared.ts'

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024
const MAX_SESSION_ID_BYTES = 1024
/** 编码后的文件名头上限；解码后再按落盘上限截断，因此超长名称不会被直接拒绝。 */
const MAX_ENCODED_FILE_NAME_BYTES = 4 * 1024
/** 安全文件名（不含服务分配的随机前缀）的 UTF-8 字节上限。 */
const MAX_FILE_NAME_BYTES = 120
const FALLBACK_STEM = 'file'

type AttachFailure = { readonly ok: false; readonly status: 400 | 403 | 404 | 409 | 413 | 415; readonly message: string }
type AttachResult = { readonly ok: true; readonly payload: OpenInAppAttachPayload } | AttachFailure

class UploadRejection extends Error {
  constructor(readonly status: AttachFailure['status'], message: string) {
    super(message)
  }
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
 * 把原始请求流交给全局文件库；成功响应仅在字节与数据库记录提交后返回。
 * @param ctx - 提供 live Session 与文件库的 Host 上下文。
 * @param req - 原始 HTTP 请求流与编码文件名头。
 * @param ssh - Host 是否由 SSH 启动；此模式拒绝本机文件上传。
 * @returns 成功时的绝对文件路径，失败时无内部路径的 4xx 信息。
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
  const id = SessionId(sessionId)
  const length = req.headers['content-length']
  if (length !== undefined && Number(length) > MAX_UPLOAD_BYTES) return failure(413, 'file exceeds 32 MiB')
  if (ssh) return failure(409, 'file upload is unavailable for remote workspaces')
  const session = ctx.sessions.get(id)
  if (session === undefined) return failure(404, 'session is not live')
  const cwd = session.header.cwd
  if (cwd === undefined || !isAbsolute(cwd) || cwd.includes('\0')) {
    return failure(409, 'session has no local workspace')
  }
  const workspace = cwd
  try {
    if (await remoteWorkspacePath(cwd, cwd) !== undefined) {
      return failure(409, 'file upload is unavailable for remote workspaces')
    }
  } catch {
    return failure(409, 'file upload is unavailable for remote workspaces')
  }
  let identity: { dev: number; ino: number; real: string }
  try {
    const entry = await lstat(cwd)
    if (!entry.isDirectory() || entry.isSymbolicLink()) return failure(409, 'session workspace is unavailable')
    identity = { dev: entry.dev, ino: entry.ino, real: await realpath(cwd) }
  } catch {
    return failure(409, 'session workspace is unavailable')
  }

  let size = 0
  async function* boundedStream(): AsyncGenerator<Uint8Array> {
    // 不以 Content-Length 代替流限额；短报头与分块传输同样受到约束。
    for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
      size += chunk.byteLength
      if (size > MAX_UPLOAD_BYTES) {
        req.resume()
        throw new UploadRejection(413, 'file exceeds 32 MiB')
      }
      yield chunk
    }
  }
  async function verify(): Promise<void> {
    const current = ctx.sessions.get(id)
    if (current === undefined) throw new UploadRejection(404, 'session is no longer live')
    if (current !== session || current.header.cwd !== workspace) {
      throw new UploadRejection(409, 'session workspace changed during upload')
    }
    try {
      const entry = await lstat(workspace)
      if (entry.isDirectory() && !entry.isSymbolicLink() && entry.dev === identity.dev && entry.ino === identity.ino
        && await realpath(workspace) === identity.real) return
    } catch {
      // 会话工作区可能在流期间被删除或换成了其他对象。
    }
    throw new UploadRejection(409, 'session workspace changed during upload')
  }
  try {
    const { path } = await ctx.fileLibrary.saveUpload({ name: fileName, sessionId, stream: boundedStream(), verify })
    return { ok: true, payload: { path } }
  } catch (error) {
    if (error instanceof UploadRejection) return failure(error.status, error.message)
    return failure(409, 'file upload is unavailable')
  }
}
