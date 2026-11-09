/** 全局受管理文件：私有磁盘对象、持久领域元数据和只读列表。@module coding-file-library */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from 'coding-home-paths'
import type { Domain } from 'coding-storage-domain'
import { FileId } from './brand.ts'
import { fileDomainSpec } from './spec.ts'
import { installFileRoutes } from './routes.ts'
import type { ManagedFilePage, ManagedFileRecord } from './types.ts'

export { FileId } from './brand.ts'
export type { ManagedFileRecord, ManagedFilePage } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { fileLibrary: FileLibrary }
}

/** 单个不可信用户上传流的最大原始字节数。 */
export const MAX_MANAGED_FILE_BYTES = 32 * 1024 * 1024

/** 文件库的部署根目录；省略时跟随当前 Coding home。 */
export interface Config {
  /** 显式覆盖受管理文件根目录；默认使用已解析 Coding home 下的 `files`，仅供测试与部署隔离使用。 */
  readonly root?: string
}

const EXTENSION = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const

/** 生成图片副本接受的媒体类型；与附件服务的图片准入格式一致。 */
export type GeneratedImageMediaType = keyof typeof EXTENSION
const UPLOAD_MEDIA: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

function safeName(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 1024 || name.includes('\0')) {
    throw new TypeError('文件名无效')
  }
  const leaf = name.split(/[/\\]/u).at(-1)?.replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  const safe = leaf?.replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^\.+/u, '').trim()
  if (!safe) throw new TypeError('文件名无效')
  const dot = safe.lastIndexOf('.')
  const extension = dot > 0 && Buffer.byteLength(safe.slice(dot), 'utf8') <= 32 ? safe.slice(dot) : ''
  const stem = extension ? safe.slice(0, -extension.length) : safe
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(safe) ? '_' : ''
  let result = reserved
  for (const character of stem) {
    if (Buffer.byteLength(result + character + extension, 'utf8') > 120) break
    result += character
  }
  result = result.replace(/[ .]+$/u, '') + extension
  if (!result || result === extension) throw new TypeError('文件名无效')
  return result
}

function identity(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${field}无效`)
  }
  return value
}

async function privateDirectory(path: string): Promise<void> {
  // 已存在的条目也按 lstat 检查，不跟随被替换进目录树的符号链接。
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const info = await lstat(path)
  const currentUid = process.getuid?.()
  if (!info.isDirectory() || info.isSymbolicLink() || currentUid !== undefined && info.uid !== currentUid
    || process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error(`文件库目录不是仅限当前用户访问的真实目录: ${path}`)
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

/** 受管理文件与记录分属两个介质；提交失败只回滚当前操作仍拥有的磁盘条目。 */
export class FileLibrary extends Service {
  static inject = ['storageDomain']
  static Config: z<Config> = z.object({ root: z.string() })

  /** 用于磁盘对象的绝对目录；浏览器列表不会得到该路径。 */
  readonly root: string
  private domain!: Domain<typeof fileDomainSpec>
  private rootIdentity!: { dev: number; ino: number }

  constructor(ctx: Context, config: Config = {}) {
    const root = config.root ?? join(resolveDshHome(), 'files')
    if (root === '' || /["\u0000-\u001f\u007f]/u.test(root)) {
      throw new TypeError('文件库根目录不能为空，也不能包含双引号或控制字符')
    }
    super(ctx, 'fileLibrary')
    this.root = resolve(root)
    installFileRoutes(ctx, this)
  }

  protected async [Service.init](): Promise<void> {
    // 用户主目录的父级可由系统管理；受管理根目录本身必须是真实私有目录。
    await mkdir(dirname(this.root), { recursive: true, mode: 0o700 })
    await privateDirectory(this.root)
    const info = await lstat(this.root)
    this.rootIdentity = { dev: info.dev, ino: info.ino }
    const domain = await this.ctx.storageDomain.open(fileDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'file-library.domainClose')
    this.domain = domain
  }

  private async directory(kind: 'uploads' | 'generated'): Promise<string> {
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.rootIdentity.dev || info.ino !== this.rootIdentity.ino) {
      throw new Error('文件库根目录已更换')
    }
    const path = join(this.root, kind)
    await privateDirectory(path)
    return path
  }

  /**
   * 将上传流写入独占私有文件，校验发起会话后写入领域记录。
   * 拒绝空文件或超过 32 MiB 的流；失败仅删除本次仍持有的文件，不回滚其他介质已持久化的事实。
   * @param input - 原名、会话身份、数据流和提交前的会话有效性检查。
   * @returns 持久记录和只供 Host 内部使用的绝对路径。
   */
  async saveUpload(input: {
    name: string
    sessionId: string
    stream: AsyncIterable<Uint8Array>
    verify: () => Promise<void>
  }): Promise<{ record: ManagedFileRecord; path: string }> {
    const name = safeName(input.name)
    const sessionId = identity(input.sessionId, '会话标识')
    await input.verify()
    const extension = name.split('.').at(-1)?.toLowerCase() ?? ''
    return this.save('upload', name, `uploads/${randomUUID()}-${name}`, input.stream, { sessionId }, input.verify,
      UPLOAD_MEDIA[extension] ?? 'application/octet-stream', MAX_MANAGED_FILE_BYTES)
  }

  /**
   * 复制已由附件服务准入的不可变生成图片；原附件继续由附件服务拥有，字节限额仍由附件提供方控制。
   * @param input - 会话、图库、附件引用及已准入编码字节。
   * @returns 副本的持久元数据。
   */
  async saveGeneratedImage(input: {
    sessionId: string
    galleryId?: string
    attachmentId: string
    mediaType: GeneratedImageMediaType
    data: Uint8Array
  }): Promise<ManagedFileRecord> {
    const sessionId = identity(input.sessionId, '会话标识')
    const galleryId = input.galleryId === undefined ? undefined : identity(input.galleryId, '图库标识')
    const attachmentId = identity(input.attachmentId, '附件标识')
    if (!Object.hasOwn(EXTENSION, input.mediaType) || !(input.data instanceof Uint8Array)) {
      throw new TypeError('生成图片格式无效')
    }
    const extension = EXTENSION[input.mediaType]
    const name = `image-${(galleryId ?? attachmentId).replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 80)}.${extension}`
    const record = await this.save('generated-image', name, `generated/${randomUUID()}.${extension}`,
      Readable.from([input.data]), { sessionId, ...(galleryId === undefined ? {} : { galleryId }), attachmentId },
      () => Promise.resolve(), input.mediaType)
    return record.record
  }

  private async save(kind: ManagedFileRecord['kind'], name: string, relativePath: string,
    stream: AsyncIterable<Uint8Array>, metadata: Partial<Pick<ManagedFileRecord, 'sessionId' | 'galleryId' | 'attachmentId'>>,
    verify: () => Promise<void>, mediaType = 'application/octet-stream', maxBytes?: number): Promise<{ record: ManagedFileRecord; path: string }> {
    const directory = await this.directory(kind === 'upload' ? 'uploads' : 'generated')
    const folder = await lstat(directory)
    const path = join(directory, basename(relativePath))
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const owned = await handle.stat()
    let bytes = 0
    try {
      try {
        for await (const chunk of stream) {
          if (!(chunk instanceof Uint8Array)) throw new TypeError('文件流包含无效字节')
          bytes += chunk.byteLength
          if (!Number.isSafeInteger(bytes)) throw new TypeError('文件字节数超出安全整数范围')
          if (maxBytes !== undefined && bytes > maxBytes) throw new TypeError('文件超过 32 MiB 上限')
          await handle.writeFile(chunk)
        }
        if (bytes === 0) throw new TypeError('文件不能为空')
        await handle.sync()
      } finally { await handle.close() }
      await syncDirectory(directory)
      await verify()
      await this.directory(kind === 'upload' ? 'uploads' : 'generated')
      const currentFolder = await lstat(directory)
      if (currentFolder.dev !== folder.dev || currentFolder.ino !== folder.ino) throw new Error('文件库子目录已更换')
      const current = await lstat(path)
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) {
        throw new Error('文件库条目已更换')
      }
      const record: ManagedFileRecord = {
        id: FileId(randomUUID()), kind, name, relativePath, mediaType, bytes, createdAt: new Date().toISOString(), ...metadata,
      }
      await this.domain.table('files').put(record.id, record)
      return { record, path: process.platform === 'win32' ? path.replaceAll('\\', '/') : path }
    } catch (error) {
      try {
        const current = await lstat(path)
        if (current.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await unlink(path)
      } catch { /* 原错误是写入失败；只有仍拥有的文件可回滚。 */ }
      throw error
    }
  }

  /**
   * 从领域快照按创建时间倒序分页；不返回本机路径。
   * @param offset - 从零开始的偏移，默认零。
   * @param limit - 每页最多 100 条，默认 50。
   * @returns 当前快照的一页、总数和可选后续偏移。
   */
  list(offset: number = 0, limit: number = 50): ManagedFilePage {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('分页参数无效')
    }
    const rows = [...this.domain.table('files').entries()].map(([, row]) => row)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const size = Math.min(limit, 100)
    const items = rows.slice(offset, offset + size)
    return { items, total: rows.length, ...(offset + items.length < rows.length ? { nextOffset: offset + items.length } : {}) }
  }

  /**
   * 读取真实且仍归本库登记的上传记录；目录和文件均需通过当前身份检查。
   * @param path - Host 提供的绝对路径。
   * @returns 已登记的上传记录；路径失效或不属于本库时为 `undefined`。
   */
  async getUpload(path: string): Promise<ManagedFileRecord | undefined> {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return undefined
    try {
      const directory = await this.directory('uploads')
      const normalized = resolve(path)
      if (!normalized.startsWith(`${directory}${sep}`) || dirname(normalized) !== directory) return undefined
      const info = await lstat(normalized)
      if (!info.isFile() || info.isSymbolicLink()) return undefined
      return [...this.domain.table('files').entries()].find(([, row]) =>
        row.kind === 'upload' && join(this.root, row.relativePath) === normalized)?.[1]
    } catch { return undefined }
  }

  /**
   * 仅确认真实、仍归本库登记的上传文件，拒绝符号链接及库外路径。
   * @param path - Host 提供的绝对路径。
   * @returns 是否属于已登记的上传对象。
   */
  async isManagedUploadPath(path: string): Promise<boolean> {
    return await this.getUpload(path) !== undefined
  }
}

export default FileLibrary
