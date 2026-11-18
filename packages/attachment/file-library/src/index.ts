/** 全局受管理文件：私有磁盘对象、持久领域元数据和只读列表。@module coding-file-library */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, chmod, realpath, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Stats } from 'node:fs'
import { Readable } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from 'coding-home-paths'
import type { Domain } from 'coding-storage-domain'
import type {} from 'coding-workspace'
import { FileId } from './brand.ts'
import { managedFileCategory } from './file-category.ts'
import { fileDomainSpec } from './spec.ts'
import { installFileRoutes } from './routes.ts'
import type { ManagedFileCategory, ManagedFileKind, ManagedFilePage, ManagedFileRecord, NotesTreeNode } from './types.ts'

export { FileId } from './brand.ts'
export type { ManagedFileCategory, ManagedFileKind, ManagedFileRecord, ManagedFilePage, NotesTreeNode } from './types.ts'

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

/** 笔记接受的 Markdown 扩展名；其他扩展名一律不是笔记。 */
const NOTE_EXTENSIONS = new Set(['.md', '.markdown'])

/** 单篇笔记的原始字节上限；原文区把全文载入内存，超限的条目拒绝读写。 */
const NOTE_MAX_BYTES = 1024 * 1024

/** 笔记目录树的最大深度；超出说明目录结构异常，整棵树拒绝而不是静默截断。 */
const NOTE_MAX_DEPTH = 8

/** 单棵笔记树的节点总数上限；目录与文件条目共用这一个预算。 */
const NOTE_MAX_NODES = 4096

/** 笔记或目录已不存在，调用方可以刷新目录。 */
export class NoteNotFoundError extends Error {
  constructor() { super('笔记不存在') }
}

/** 笔记操作与当前磁盘状态冲突；调用方应刷新目录后重试。 */
export class NoteConflictError extends Error {}

/** 保存时检测到笔记在读后被外部修改；编辑端应重新加载而不是被覆盖。 */
export class StaleNoteError extends NoteConflictError {
  constructor() { super('笔记已被外部修改') }
}

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

async function privateDirectory(path: string, repairPermissions = false): Promise<void> {
  // 已存在的条目也按 lstat 检查，不跟随被替换进目录树的符号链接。
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const info = await lstat(path)
  const currentUid = process.getuid?.()
  if (!info.isDirectory() || info.isSymbolicLink() || currentUid !== undefined && info.uid !== currentUid) {
    throw new Error(`文件库目录不是仅限当前用户访问的真实目录: ${path}`)
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    if (!repairPermissions) throw new Error(`文件库目录不是仅限当前用户访问的真实目录: ${path}`)
    await chmod(path, 0o700)
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

  /** 笔记写操作串行队列，避免改名/删除后的迟到保存重建旧路径。 */
  private notesWriteQueue: Promise<void> = Promise.resolve()
  private scheduleNotesWrite<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.notesWriteQueue.then(fn, fn)
    this.notesWriteQueue = next.then(() => undefined, () => undefined)
    return next
  }

  /** 从宿主工作区注册表解析会话归属；未装载注册表或未分组会话返回 undefined。 */
  private workspaceIdForSession(sessionId: string): string | undefined {
    const registry = this.ctx.get('workspaceRegistry') as {
      list(): readonly { id: string; sessionIds: readonly string[] }[]
    } | undefined
    return registry?.list().find(workspace => workspace.sessionIds.includes(sessionId))?.id
  }

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

  private async directory(kind: 'uploads' | 'generated' | 'exports' | 'notes'): Promise<string> {
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.rootIdentity.dev || info.ino !== this.rootIdentity.ino) {
      throw new Error('文件库根目录已更换')
    }
    const path = join(this.root, kind)
    await privateDirectory(path, kind === 'notes')
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
    workspaceId?: string
    stream: AsyncIterable<Uint8Array>
    verify: () => Promise<void>
  }): Promise<{ record: ManagedFileRecord; path: string }> {
    const name = safeName(input.name)
    const sessionId = identity(input.sessionId, '会话标识')
    await input.verify()
    const extension = name.split('.').at(-1)?.toLowerCase() ?? ''
    return this.save('upload', name, `uploads/${randomUUID()}-${name}`, input.stream,
      { sessionId, workspaceId: input.workspaceId === undefined
        ? this.workspaceIdForSession(sessionId) : identity(input.workspaceId, '工作区标识') }, input.verify,
      UPLOAD_MEDIA[extension] ?? 'application/octet-stream', MAX_MANAGED_FILE_BYTES)
  }

  /**
   * 复制已由附件服务准入的不可变生成图片；原附件继续由附件服务拥有，字节限额仍由附件提供方控制。
   * @param input - 会话、图库、附件引用及已准入编码字节。
   * @returns 副本的持久元数据，以及模型侧需要引用的绝对路径。
   */
  async saveGeneratedImage(input: {
    sessionId: string
    workspaceId?: string
    galleryId?: string
    attachmentId: string
    mediaType: GeneratedImageMediaType
    data: Uint8Array
  }): Promise<{ record: ManagedFileRecord; path: string }> {
    const sessionId = identity(input.sessionId, '会话标识')
    const galleryId = input.galleryId === undefined ? undefined : identity(input.galleryId, '图库标识')
    const attachmentId = identity(input.attachmentId, '附件标识')
    if (!Object.hasOwn(EXTENSION, input.mediaType) || !(input.data instanceof Uint8Array)) {
      throw new TypeError('生成图片格式无效')
    }
    const extension = EXTENSION[input.mediaType]
    const name = `image-${(galleryId ?? attachmentId).replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 80)}.${extension}`
    const record = await this.save('generated-image', name, `generated/${randomUUID()}.${extension}`,
      Readable.from([input.data]), { sessionId, workspaceId: input.workspaceId === undefined
        ? this.workspaceIdForSession(sessionId) : identity(input.workspaceId, '工作区标识'), ...(galleryId === undefined ? {} : { galleryId }), attachmentId },
      () => Promise.resolve(), input.mediaType)
    return record
  }

  /** 把已由附件服务准入的输入图片复制到文件库，供文件管理页集中查看。 */
  async saveInputImage(input: {
    sessionId: string
    workspaceId?: string
    attachmentId: string
    mediaType: GeneratedImageMediaType
    name?: string
    data: Uint8Array
  }): Promise<{ record: ManagedFileRecord; path: string }> {
    const sessionId = identity(input.sessionId, '会话标识')
    const attachmentId = identity(input.attachmentId, '附件标识')
    if (!Object.hasOwn(EXTENSION, input.mediaType) || !(input.data instanceof Uint8Array) || input.data.byteLength === 0) {
      throw new TypeError('输入图片格式无效')
    }
    const extension = EXTENSION[input.mediaType]
    const name = safeName(input.name ?? `image-${attachmentId.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 80)}.${extension}`)
    return this.save('upload', name, `uploads/${randomUUID()}-${name}`, Readable.from([input.data]),
      { sessionId, workspaceId: input.workspaceId === undefined
        ? this.workspaceIdForSession(sessionId) : identity(input.workspaceId, '工作区标识'), attachmentId },
      () => Promise.resolve(), input.mediaType)
  }

  /**
   * 把会话导出的成品登记到全局文件库。导出文件与工作区里的原始产物
   * 保持两份独立副本，便于无工作区会话在 Coding home 中集中管理。
   * @param input - 成品文件名、会话身份、媒体类型与已生成字节。
   * @returns 文件库记录和仅供 Host 使用的绝对路径。
   */
  async saveExport(input: {
    name: string
    sessionId: string
    workspaceId?: string
    mediaType: string
    data: Uint8Array
  }): Promise<{ record: ManagedFileRecord; path: string }> {
    const name = safeName(input.name)
    const sessionId = identity(input.sessionId, '会话标识')
    if (!(input.data instanceof Uint8Array) || input.data.byteLength === 0 || input.mediaType.length === 0) {
      throw new TypeError('导出文件无效')
    }
    return this.save('export', name, `exports/${randomUUID()}-${name}`, Readable.from([input.data]),
      { sessionId, workspaceId: input.workspaceId === undefined
        ? this.workspaceIdForSession(sessionId) : identity(input.workspaceId, '工作区标识') },
      () => Promise.resolve(), input.mediaType)
  }

  private async save(kind: ManagedFileKind, name: string, relativePath: string,
    stream: AsyncIterable<Uint8Array>, metadata: Partial<Pick<ManagedFileRecord, 'sessionId' | 'workspaceId' | 'galleryId' | 'attachmentId'>>,
    verify: () => Promise<void>, mediaType = 'application/octet-stream', maxBytes?: number): Promise<{ record: ManagedFileRecord; path: string }> {
    const directory = await this.directory(kind === 'upload' ? 'uploads' : kind === 'generated-image' ? 'generated' : 'exports')
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
      await this.directory(kind === 'upload' ? 'uploads' : kind === 'generated-image' ? 'generated' : 'exports')
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
  list(offset: number = 0, limit: number = 50, filter: {
    sessionId?: string
    workspaceId?: string
    unscoped?: boolean
    kind?: ManagedFileKind
    category?: ManagedFileCategory
  } = {}): ManagedFilePage {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('分页参数无效')
    }
    const rows = this.filterRows(filter).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const size = Math.min(limit, 100)
    const items = rows.slice(offset, offset + size)
    return { items, total: rows.length, ...(offset + items.length < rows.length ? { nextOffset: offset + items.length } : {}) }
  }

  /** 应用会话、工作区、范围、类型与分类过滤；排序与分页由调用方完成。 */
  private filterRows(filter: {
    sessionId?: string
    workspaceId?: string
    unscoped?: boolean
    kind?: ManagedFileKind
    category?: ManagedFileCategory
  }): ManagedFileRecord[] {
    const sessionId = filter.sessionId === undefined ? undefined : identity(filter.sessionId, '会话标识')
    const workspaceId = filter.workspaceId === undefined ? undefined : identity(filter.workspaceId, '工作区标识')
    return [...this.domain.table('files').entries()].map(([, row]) => row)
      .filter(row => sessionId === undefined || row.sessionId === sessionId)
      .filter(row => workspaceId === undefined || row.workspaceId === workspaceId)
      .filter(row => !filter.unscoped || row.workspaceId === undefined)
      .filter(row => filter.kind === undefined || row.kind === filter.kind)
      .filter(row => filter.category === undefined || managedFileCategory(row) === filter.category)
  }

  /**
   * 文件列表并入无目录笔记：领域快照的过滤结果与笔记根目录的实时记录合并后分页。
   * 笔记只出现在未分组视图或 `kind: 'note'` 过滤下；已登记记录与实时记录相对路径重复时只取登记记录。
   * @param offset - 从零开始的偏移，默认零。
   * @param limit - 每页最多 100 条，默认 50。
   * @param filter - 与 {@link FileLibrary.list} 相同的过滤条件。
   * @returns 合并视图的一页、总数和可选后续偏移。
   */
  async listWithNotes(offset: number = 0, limit: number = 50, filter: {
    sessionId?: string
    workspaceId?: string
    unscoped?: boolean
    kind?: ManagedFileKind
    category?: ManagedFileCategory
  } = {}): Promise<ManagedFilePage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('分页参数无效')
    }
    const rows = this.filterRows(filter)
    // 会话或工作区过滤排除了所有无归属条目，笔记同样不携带归属。
    const includeNotes = filter.sessionId === undefined && filter.workspaceId === undefined
      && (filter.kind === 'note' || (filter.kind === undefined && filter.unscoped === true))
    const combined = includeNotes
      ? [...rows, ...(await this.noteRecords()).filter(row =>
        filter.category === undefined || managedFileCategory(row) === filter.category)]
      : rows
    combined.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const size = Math.min(limit, 100)
    const items = combined.slice(offset, offset + size)
    return { items, total: combined.length, ...(offset + items.length < combined.length ? { nextOffset: offset + items.length } : {}) }
  }

  /** 按文件库 ID 读取已登记的本地字节；绝对路径永远不离开 Host。未登记 id 落到无目录笔记的实时记录。 */
  async read(id: string): Promise<{ record: ManagedFileRecord; data: Uint8Array } | undefined> {
    let fileId
    try { fileId = FileId(id) } catch { return undefined }
    const record = this.domain.table('files').get(fileId)
    if (record !== undefined) {
      try {
        const directory = await this.directory(record.kind === 'upload' ? 'uploads' : record.kind === 'generated-image' ? 'generated' : 'exports')
        const target = join(directory, basename(record.relativePath))
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const info = await handle.stat()
          if (!info.isFile()) return undefined
          return { record, data: new Uint8Array(await handle.readFile()) }
        } finally {
          await handle.close()
        }
      } catch { return undefined }
    }
    // 无目录笔记不进领域表：按实时 id 匹配后直接服务磁盘文件。
    const note = (await this.noteRecords()).find(row => row.id === fileId)
    if (note === undefined) return undefined
    try {
      const target = join(await this.directory('notes'), basename(note.relativePath))
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink()) return undefined
      return { record: note, data: new Uint8Array(await readFile(target)) }
    } catch { return undefined }
  }

  /** 笔记根目录的绝对路径；只供 Host 侧会话工作目录使用，不进入浏览器响应。 */
  notesRootPath(): string {
    return resolve(join(this.root, 'notes'))
  }

  /** 由笔记相对路径推导稳定 UUID（同一相对路径永远映射同一 id）。 */
  private static noteIdOf(relativePath: string): FileId {
    const digest = createHash('sha1').update(`notes:${relativePath}`).digest()
    const bytes = new Uint8Array(16)
    bytes.set(digest.subarray(0, 16))
    const versionByte = digest[6]
    const variantByte = digest[8]
    if (versionByte === undefined || variantByte === undefined) throw new TypeError('笔记标识推导失败')
    bytes[6] = (versionByte & 0x0f) | 0x50
    bytes[8] = (variantByte & 0x3f) | 0x80
    const hex = Buffer.from(bytes).toString('hex')
    return FileId(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`)
  }

  /**
   * 校验客户端提交的相对路径落在笔记根目录内；拒绝空段、`.`、`..` 与绝对路径。
   * @param relativePath - 斜杠分隔的相对路径。
   * @returns 规范化相对路径（斜杠分隔）与笔记根目录绝对路径。
   */
  private noteTarget(relativePath: string): { rel: string; target: string } {
    if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 4096
      || relativePath.includes('\0') || /[\u0001-\u001f\u007f]/u.test(relativePath)
      || /^[a-zA-Z]:/u.test(relativePath)) {
      throw new TypeError('笔记路径无效')
    }
    const segments = relativePath.split(/[\\/]/u)
    if (segments[0] === '' || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw new TypeError('笔记路径无效')
    }
    return { rel: segments.join('/'), target: join(this.root, 'notes', ...segments) }
  }

  /**
   * 确认真实笔记文件：父链 realpath 不逃出笔记根目录（拦符号链接子目录），
   * 条目本身是真实文件且扩展名为 Markdown。
   * @param relativePath - 相对笔记根目录的路径。
   * @returns 绝对路径与规范化相对路径。
   */
  private async safeNoteFile(relativePath: string): Promise<{ target: string; rel: string }> {
    const { rel, target } = this.noteTarget(relativePath)
    const notesDir = await this.directory('notes')
    const realNotes = await realpath(notesDir)
    let realParent: string
    try { realParent = await realpath(dirname(target)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new TypeError('笔记不存在')
    }
    if (realParent !== realNotes && !realParent.startsWith(realNotes + sep)) throw new TypeError('笔记路径无效')
    let info
    try { info = await lstat(target) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new TypeError('笔记不存在')
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new TypeError('笔记不是真实文件')
    if (!NOTE_EXTENSIONS.has(extname(target).toLowerCase())) throw new TypeError('笔记扩展名无效')
    return { target, rel }
  }

  /** 校验笔记父目录属于笔记根目录，并返回其真实目录。 */
  private async safeNoteDirectory(relativePath: string): Promise<{ target: string; rel: string }> {
    if (relativePath === '') {
      const target = await this.directory('notes')
      return { target, rel: '' }
    }
    const { rel, target } = this.noteTarget(relativePath)
    const notesDir = await this.directory('notes')
    const realNotes = await realpath(notesDir)
    let info
    try { info = await lstat(target) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TypeError('笔记目录不存在')
      throw error
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('笔记目录无效')
    const realTarget = await realpath(target)
    if (realTarget !== realNotes && !realTarget.startsWith(realNotes + sep)) throw new TypeError('笔记目录无效')
    await this.ensurePrivateDirs(notesDir, target)
    return { target, rel }
  }

  /** 把中间目录逐段修成私有目录：真实目录、属主为本用户、0o700；会话工具按默认权限建的目录在此收紧。 */
  private async ensurePrivateDirs(notesDir: string, dir: string): Promise<void> {
    let cursor = notesDir
    for (const segment of relative(notesDir, dir).split(sep)) {
      cursor = join(cursor, segment)
      const info = await lstat(cursor)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('笔记目录无效')
      const uid = process.getuid?.()
      if (uid !== undefined && info.uid !== uid) throw new TypeError('笔记目录属主不符')
      if (process.platform !== 'win32') {
        await chmod(cursor, 0o700)
        await syncDirectory(cursor)
      }
    }
  }

  /**
   * 扫描笔记根目录返回目录树：全部目录与全部 Markdown 文件，符号链接条目不进入树。
   * 深度与节点总数超限视为结构异常，整棵树拒绝。
   * @returns 根级条目数组；子节点按名称排序。
   */
  async notesTree(): Promise<NotesTreeNode[]> {
    const notesDir = await this.directory('notes')
    let count = 0
    const scan = async (dirPath: string, prefix: string, depth: number): Promise<NotesTreeNode[]> => {
      if (depth > NOTE_MAX_DEPTH) throw new TypeError('笔记目录层级过深')
      const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
      const nodes: NotesTreeNode[] = []
      for (const entry of entries) {
        count += 1
        if (count > NOTE_MAX_NODES) throw new TypeError('笔记条目过多')
        if (entry.isSymbolicLink()) continue
        const full = join(dirPath, entry.name)
        const rel = `${prefix}${entry.name}`
        if (entry.isDirectory()) {
          nodes.push({ name: entry.name, kind: 'dir', path: rel, mtimeMs: (await lstat(full)).mtimeMs, children: await scan(full, `${rel}/`, depth + 1) })
        } else if (entry.isFile() && NOTE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          nodes.push({ name: entry.name, kind: 'file', path: rel, mtimeMs: (await lstat(full)).mtimeMs })
        }
      }
      return nodes
    }
    return await scan(notesDir, '', 0)
  }

  /**
   * 读取笔记原文与其修改时间；保存冲突检测的基准时间由此取得。
   * @param relativePath - 相对笔记根目录的路径。
   * @returns 规范化路径、全文与毫秒修改时间。
   */
  async readNote(relativePath: string): Promise<{ path: string; content: string; mtimeMs: number }> {
    const { target, rel } = await this.safeNoteFile(relativePath)
    const info = await lstat(target)
    if (info.size > NOTE_MAX_BYTES) throw new TypeError('笔记超过大小上限')
    return { path: rel, content: await readFile(target, 'utf8'), mtimeMs: info.mtimeMs }
  }

  /**
   * 写入笔记；没有修改时间基准时按需创建中间目录，写入经临时文件原子改名并同步目录。
   * 传入 `baseMtimeMs` 时目标文件与父目录必须仍存在，外部修改或删除都拒绝覆盖。
   * @param relativePath - 相对笔记根目录的路径，必须使用 Markdown 扩展名。
   * @param content - 笔记全文。
   * @param baseMtimeMs - 读取时的修改时间（可选）。
   * @returns 规范化路径与写入后的修改时间。
   */
  async saveNote(relativePath: string, content: string, baseMtimeMs?: number): Promise<{ path: string; mtimeMs: number }> {
    return this.scheduleNotesWrite(async () => {
      const { rel, target } = this.noteTarget(relativePath)
      if (!NOTE_EXTENSIONS.has(extname(target).toLowerCase())) throw new TypeError('笔记必须使用 Markdown 扩展名')
      if (Buffer.byteLength(content, 'utf8') > NOTE_MAX_BYTES) throw new TypeError('笔记超过大小上限')
      const notesDir = await this.directory('notes')
      const realNotes = await realpath(notesDir)
      const dir = dirname(target)
      // 只有没有版本基准的首次写入才允许创建父目录；带基准的迟到保存不得复活旧路径。
      if (baseMtimeMs === undefined && dir !== notesDir) {
        const exists = await lstat(dir).then(() => true).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        })
        if (!exists) {
          await mkdir(dir, { recursive: true, mode: 0o700 })
          await this.ensurePrivateDirs(notesDir, dir)
        }
      }
      let realParent: string
      try { realParent = await realpath(dir) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoteNotFoundError()
        throw error
      }
      if (realParent !== realNotes && !realParent.startsWith(realNotes + sep)) throw new TypeError('笔记路径无效')
      let existing: Stats | undefined
      try { existing = await lstat(target) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (baseMtimeMs !== undefined) throw new NoteNotFoundError()
          existing = undefined
        } else {
          throw error
        }
      }
      if (existing !== undefined) {
        if (!existing.isFile() || existing.isSymbolicLink()) throw new TypeError('笔记不是真实文件')
        if (baseMtimeMs !== undefined && Math.floor(existing.mtimeMs) !== Math.floor(baseMtimeMs)) throw new StaleNoteError()
      }
      const tmp = `${target}.${randomUUID()}.tmp`
      const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        await handle.writeFile(Buffer.from(content, 'utf8'))
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(tmp, target)
        await syncDirectory(dir)
        if (dir !== notesDir) await syncDirectory(notesDir)
      } catch (error) {
        try { await unlink(tmp) } catch { /* 原错误是改名失败；只回滚本次仍拥有的临时文件。 */ }
        throw error
      }
      return { path: rel, mtimeMs: (await lstat(target)).mtimeMs }
    })
  }

  /**
   * 在指定笔记目录创建空笔记；名称按文件库规则净化，缺省扩展名补 `.md`，同名已存在时拒绝。
   * @param name - 用户提交的文件名。
   * @param directory - 相对笔记根目录的父目录，空字符串表示根目录。
   * @returns 相对笔记根目录的路径。
   */
  async createNote(name: string, directory = ''): Promise<{ path: string }> {
    const leaf = safeName(name)
    const fileName = NOTE_EXTENSIONS.has(extname(leaf).toLowerCase()) ? leaf : `${leaf}.md`
    const parent = await this.safeNoteDirectory(directory)
    const target = join(parent.target, fileName)
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    const handle = await open(target, flags, 0o600).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TypeError('笔记已存在')
      throw error
    })
    await handle.close()
    await syncDirectory(parent.target)
    return { path: parent.rel === '' ? fileName : `${parent.rel}/${fileName}` }
  }

  /**
   * 在指定笔记目录创建子目录；只接受单个目录名，拒绝覆盖现有条目。
   * @param name - 用户提交的目录名。
   * @param parent - 相对笔记根目录的父目录，空字符串表示根目录。
   * @returns 相对笔记根目录的新目录路径。
   */
  async createNoteDirectory(name: string, parent = ''): Promise<{ path: string }> {
    if (typeof name !== 'string' || name.length === 0 || name.length > 1024 || name.includes('\0')
      || /[\u0001-\u001f\u007f]/u.test(name) || /[\\/]/u.test(name) || name === '.' || name === '..'
      || /^[a-zA-Z]:/u.test(name)) {
      throw new TypeError('目录名无效')
    }
    const leaf = safeName(name)
    const parentDirectory = await this.safeNoteDirectory(parent)
    const parentSegments = parentDirectory.rel === '' ? [] : parentDirectory.rel.split('/')
    if (parentSegments.length + 1 > NOTE_MAX_DEPTH) throw new TypeError('笔记目录层级过深')
    const currentTree = await this.notesTree()
    const countNodes = (entries: readonly NotesTreeNode[]): number => entries.reduce((count, entry) => (
      count + 1 + (entry.children === undefined ? 0 : countNodes(entry.children))
    ), 0)
    if (countNodes(currentTree) >= NOTE_MAX_NODES) throw new TypeError('笔记条目过多')
    const target = join(parentDirectory.target, leaf)
    try { await mkdir(target, { mode: 0o700 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TypeError('笔记目录已存在')
      throw error
    }
    await syncDirectory(parentDirectory.target)
    return { path: parentDirectory.rel === '' ? leaf : `${parentDirectory.rel}/${leaf}` }
  }

  /**
   * 在原笔记或目录的同一父目录内安全改名；不覆盖已有条目。
   * @param relativePath - 要改名的笔记或目录路径。
   * @param name - 新的单段名称。
   * @returns 改名后的相对路径。
   */
  async renameNote(relativePath: string, name: string): Promise<{ path: string }> {
    return this.scheduleNotesWrite(async () => {
      const { rel, target } = this.noteTarget(relativePath)
      if (typeof name !== 'string' || name.length === 0 || name.length > 1024
        || name.includes('\0') || /[\\/]/u.test(name) || name === '.' || name === '..'
        || /^[a-zA-Z]:/u.test(name)) throw new TypeError('名称无效')
      const notesDir = await this.directory('notes')
      const realNotes = await realpath(notesDir)
      const parent = dirname(target)
      const realParent = await realpath(parent).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoteNotFoundError()
        throw error
      })
      if (realParent !== realNotes && !realParent.startsWith(realNotes + sep)) throw new TypeError('笔记路径无效')
      const current = await lstat(target).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoteNotFoundError()
        throw error
      })
      if (current.isSymbolicLink() || !current.isFile() && !current.isDirectory()) throw new TypeError('笔记条目无效')
      if (current.isFile() && !NOTE_EXTENSIONS.has(extname(target).toLowerCase())) throw new TypeError('笔记扩展名无效')
      const leaf = safeName(name)
      const fileName = current.isFile() && !NOTE_EXTENSIONS.has(extname(leaf).toLowerCase()) ? `${leaf}.md` : leaf
      const targetPath = join(parent, fileName)
      if (targetPath === target) return { path: rel }
      try { await lstat(targetPath); throw new NoteConflictError('笔记已存在') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
      await rename(target, targetPath)
      await syncDirectory(parent)
      return { path: relative(notesDir, targetPath).split(sep).join('/') }
    })
  }

  /**
   * 删除笔记或空目录；目录不递归，含任意磁盘条目时拒绝。
   * @param relativePath - 要删除的笔记或目录路径。
   * @returns 无返回值。
   */
  async deleteNote(relativePath: string): Promise<void> {
    return this.scheduleNotesWrite(async () => {
      const { target } = this.noteTarget(relativePath)
      const notesDir = await this.directory('notes')
      const realNotes = await realpath(notesDir)
      const parent = dirname(target)
      const realParent = await realpath(parent).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoteNotFoundError()
        throw error
      })
      if (realParent !== realNotes && !realParent.startsWith(realNotes + sep)) throw new TypeError('笔记路径无效')
      const current = await lstat(target).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoteNotFoundError()
        throw error
      })
      if (current.isSymbolicLink() || !current.isFile() && !current.isDirectory()) throw new TypeError('笔记条目无效')
      if (current.isFile() && !NOTE_EXTENSIONS.has(extname(target).toLowerCase())) throw new TypeError('笔记扩展名无效')
      if (current.isDirectory()) {
        try { await rmdir(target) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY' || (error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new NoteConflictError('笔记目录不为空')
          }
          throw error
        }
      } else {
        await unlink(target)
      }
      await syncDirectory(parent)
    })
  }

  /**
   * 无目录笔记的实时记录：笔记根目录直属的 Markdown 文件（不含子目录条目），
   * 已被领域表登记的同名相对路径不重复出现。
   * @returns 按修改时间表达创建时间的记录数组。
   */
  async noteRecords(): Promise<ManagedFileRecord[]> {
    const notesDir = await this.directory('notes')
    const entries = await readdir(notesDir, { withFileTypes: true })
    const stored = new Set<string>()
    for (const [, row] of this.domain.table('files').entries()) stored.add(row.relativePath)
    const records: ManagedFileRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      if (!NOTE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      const relativePath = `notes/${entry.name}`
      if (stored.has(relativePath)) continue
      const info = await lstat(join(notesDir, entry.name))
      if (!info.isFile() || info.isSymbolicLink()) continue
      records.push({
        id: FileLibrary.noteIdOf(relativePath), kind: 'note', name: entry.name, relativePath,
        mediaType: 'text/markdown', bytes: info.size, createdAt: new Date(info.mtimeMs).toISOString(),
      })
    }
    return records
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
