/** 全局受管理文件：私有磁盘对象、持久领域元数据和只读列表。@module coding-file-library */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from 'coding-home-paths'
import type { Domain } from 'coding-storage-domain'
import type {} from 'coding-workspace'
import { FileId } from './brand.ts'
import { managedFileCategory, managedUploadMediaType } from './file-category.ts'
import { fileDomainSpec } from './spec.ts'
import { installFileRoutes } from './routes.ts'
import { privateDirectory, safeName, syncDirectory } from './private-files.ts'
import { isMarkdownNoteName, NoteStore } from './notes.ts'
import type {
  ManagedFileCategory, ManagedFileKind, ManagedFilePage, ManagedFileRecord, MindMapSnapshot, NotesTreeNode,
  OfficeExport, OfficeKind, OfficeSnapshot,
} from './types.ts'

export { FileId } from './brand.ts'
export { isDeckDirectoryName, NOTE_DECK_SUFFIX, NoteConflictError, NoteNotFoundError, StaleNoteError } from './note-path.ts'
export { NOTE_MINDMAP_SUFFIX } from './mindmap.ts'
export { NOTE_EXCEL_SUFFIX, NOTE_WORD_SUFFIX } from './office-notes.ts'
export type {
  ExcelCell, ExcelMerge, ExcelSheet, ExcelStyle,
  ManagedFileCategory, ManagedFileKind, ManagedFileRecord, ManagedFilePage,
  MindMapDocument, MindMapEdit, MindMapNode, MindMapSnapshot, NotesTreeNode,
  OfficeDocument, OfficeEdit, OfficeExport, OfficeKind, OfficeSnapshot, WordParagraph, WordParagraphAlign, WordParagraphStyle, WordRun,
} from './types.ts'

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

function identity(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${field}无效`)
  }
  return value
}

/** 受管理文件与记录分属两个介质；提交失败只回滚当前操作仍拥有的磁盘条目。 */
export class FileLibrary extends Service {
  static inject = ['storageDomain']
  static Config: z<Config> = z.object({ root: z.string() })

  /** 用于磁盘对象的绝对目录；浏览器列表不会得到该路径。 */
  readonly root: string
  private domain!: Domain<typeof fileDomainSpec>
  private rootIdentity!: { dev: number; ino: number }

  private readonly notes: NoteStore

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
    this.notes = new NoteStore(this.notesRootPath(), () => this.directory('notes'))
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
    return this.save('upload', name, `uploads/${randomUUID()}-${name}`, input.stream,
      { sessionId, workspaceId: input.workspaceId === undefined
        ? this.workspaceIdForSession(sessionId) : identity(input.workspaceId, '工作区标识') }, input.verify,
      managedUploadMediaType(name), MAX_MANAGED_FILE_BYTES)
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

  /**
   * 把已由附件服务准入的输入图片复制到文件库，供文件管理页集中查看。
   * @param input - 会话、附件身份、媒体类型、可选文件名与已准入字节。
   * @returns 文件库记录和仅供 Host 使用的绝对路径。
   */
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
   * @param filter - 可选的会话、工作区、范围、类型和分类过滤条件。
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

  /**
   * 按文件库 ID 读取已登记的本地字节；绝对路径永远不离开 Host。未登记 id 落到无目录笔记的实时记录。
   * @param id - 文件库或实时笔记的标识。
   * @returns 记录与字节；标识不存在或文件不再安全时为 undefined。
   */
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

  /**
   * 笔记根目录的绝对路径；只供 Host 侧会话工作目录使用，不进入浏览器响应。
   * @returns 笔记根目录绝对路径。
   */
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

  /** 扫描笔记根目录；节点或深度超出预算时拒绝整棵树。
   * @returns 按名称排序的相对路径条目。
   */
  async notesTree(): Promise<NotesTreeNode[]> { return this.notes.notesTree() }

  /**
   * 独占新建原生思维导图；中心主题取自最终文件名（去掉后缀）。
   * @param name - 期望的文件名。
   * @param directory - 可选的真实相对父目录。
   * @returns 相对笔记根目录的新文件路径。
   */
  async createNoteMindmap(name: string, directory?: string): Promise<{ path: string }> {
    return this.notes.mindmaps.create(name, directory)
  }

  /**
   * 完全校验后独占创建原生笔记；XMind 仅转换首张图的主题树，不保留格式或附件。
   * @param name - 带原生或 `.xmind` 后缀的来源文件名。
   * @param data - 来源文件的字节。
   * @param directory - 可选的真实相对父目录。
   * @returns 相对笔记根目录的新文件路径。
   */
  async importNoteMindmap(name: string, data: Uint8Array, directory?: string): Promise<{ path: string }> {
    return this.notes.mindmaps.import(name, data, directory)
  }

  /**
   * 读取结构和实际磁盘字节对应的版本；无效、超限或已删除的笔记不可读取。
   * @param path - 相对笔记根目录的真实思维导图文件路径。
   * @returns 规范路径、内容版本和结构化文档。
   */
  async readNoteMindmap(path: string): Promise<MindMapSnapshot> {
    return this.notes.mindmaps.read(path)
  }

  /**
   * 串行校验基准版本并原子提交整批变更；任何无效编辑都不会落盘。
   * @param path - 相对笔记根目录的真实思维导图文件路径。
   * @param revision - 读取时取得的不透明版本；过期时抛出 `NoteConflictError`。
   * @param edits - 非空且不超过 32 项的编辑操作。
   * @returns 提交后的快照；文件或父目录已消失时抛出 `NoteNotFoundError`。
   */
  async editNoteMindmap(path: string, revision: string, edits: unknown): Promise<MindMapSnapshot> {
    return this.notes.mindmaps.edit(path, revision, edits)
  }

  /** 独占创建完整的空白原生笔记。
   * @param kind - 文档类型。
   * @param name - 笔记名称。
   * @param directory - 可选的真实相对父目录。
   * @returns 新笔记的相对路径。
   */
  async createNoteOffice(kind: OfficeKind, name: string, directory?: string): Promise<{ path: string }> {
    return this.notes.office.create(kind, name, directory)
  }

  /** 转换完整的普通 Office 文件后，独占创建与源文件独立的新笔记。
   * @param kind - 文档类型，必须与 ZIP 主部件相符。
   * @param name - 目标笔记名称或带对应来源后缀的文件名。
   * @param bytes - 来源文件字节。
   * @param directory - 可选的真实相对父目录。
   * @returns 新笔记的相对路径。
   */
  async importNoteOffice(kind: OfficeKind, name: string, bytes: Uint8Array, directory?: string): Promise<{ path: string }> {
    return this.notes.office.import(kind, name, bytes, directory)
  }

  /** 读取对应磁盘字节的快照。
   * @param path - 笔记根目录下的相对路径。
   * @returns 规范路径、版本和结构化文档。
   */
  async readNoteOffice(path: string): Promise<OfficeSnapshot> { return this.notes.office.read(path) }

  /** 仅在版本相同且输入有效时，原子替换整篇文档。
   * @param path - 笔记的相对路径。
   * @param revision - 读取所得的版本；失配时抛出 `NoteConflictError`。
   * @param document - 待验证的完整原生文档。
   * @returns 提交后的快照。
   */
  async saveNoteOffice(path: string, revision: string, document: unknown): Promise<OfficeSnapshot> {
    return this.notes.office.save(path, revision, document)
  }

  /** 在同一笔记写入队列内核对版本并提交整批编辑；任一步失败均不写入。
   * @param path - 笔记的相对路径。
   * @param revision - 读取所得的版本；失配时抛出 `NoteConflictError`。
   * @param edits - 待验证的非空有界编辑批次。
   * @returns 提交后的快照。
   */
  async editNoteOffice(path: string, revision: string, edits: unknown): Promise<OfficeSnapshot> {
    return this.notes.office.edit(path, revision, edits)
  }

  /** 从一次读取的快照离线生成 Office 文件，不改写磁盘。
   * @param path - 笔记的相对路径。
   * @param revision - 可选的读取版本；失配时抛出 `NoteConflictError`。
   * @returns 下载名称、媒体类型、文件字节。
   */
  async exportNoteOffice(path: string, revision?: string): Promise<OfficeExport> { return this.notes.office.export(path, revision) }

  /** 读取 Markdown 原文与保存所需的时间基准。
   * @param relativePath - 相对笔记根目录的 Markdown 路径。
   * @returns 规范路径、原文和毫秒修改时间。
   */
  async readNote(relativePath: string): Promise<{ path: string; content: string; mtimeMs: number }> {
    return this.notes.readNote(relativePath)
  }

  /** 原子保存 Markdown；带时间基准时拒绝覆盖变更或恢复已删除的文件。
   * @param relativePath - 相对笔记根目录的 Markdown 路径。
   * @param content - 笔记全文。
   * @param baseMtimeMs - 读取时的修改时间（可选）。
   * @returns 规范路径和写入后的毫秒修改时间。
   */
  async saveNote(relativePath: string, content: string, baseMtimeMs?: number): Promise<{ path: string; mtimeMs: number }> {
    return this.notes.saveNote(relativePath, content, baseMtimeMs)
  }

  /** 独占创建 Markdown，可与初始原文一起落盘。
   * @param name - 文件名；省略后缀时补 `.md`。
   * @param directory - 可选的相对父目录。
   * @param content - 可选的初始原文。
   * @returns 相对笔记根目录的路径。
   */
  async createNote(name: string, directory?: string, content?: string): Promise<{ path: string }> {
    return this.notes.createNote(name, directory, content)
  }

  /** 仅供 Host 独占创建幻灯片目录；不会写入工程内容。
   * @param name - 工程名称；缺少 `.codingppt` 时自动补齐。
   * @param directory - 可选的真实相对父目录。
   * @returns 工程的相对路径和只清理本次创建条目的句柄。
   */
  async createNoteDeck(name: string, directory?: string): Promise<{ path: string; remove: () => Promise<void> }> {
    return this.notes.createNoteDeck(name, directory)
  }

  /** 独占创建笔记子目录。
   * @param name - 单段目录名。
   * @param parent - 可选的相对父目录。
   * @returns 相对笔记根目录的新目录路径。
   */
  async createNoteDirectory(name: string, parent?: string): Promise<{ path: string }> {
    return this.notes.createNoteDirectory(name, parent)
  }

  /** 在同一父目录内改名，拒绝覆盖并保留文件与幻灯片工程的格式。
   * @param relativePath - 文件或目录的相对路径。
   * @param name - 新的单段名称。
   * @returns 改名后的相对路径。
   */
  async renameNote(relativePath: string, name: string): Promise<{ path: string }> {
    return this.notes.renameNote(relativePath, name)
  }

  /** 删除单个笔记文件或递归删除真实目录，不跟随符号链接。
   * @param relativePath - 要删除的文件或目录路径。
   * @returns 删除完成。
   */
  async deleteNote(relativePath: string): Promise<void> { return this.notes.deleteNote(relativePath) }

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
      if (!isMarkdownNoteName(entry.name)) continue
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
