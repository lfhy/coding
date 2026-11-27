/** 笔记磁盘操作：路径准入、目录与文件的写入顺序由同一实例持有。 */
import { constants, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { isMindmapName } from './mindmap.ts'
import { MindmapNotes } from './mindmap-notes.ts'
import {
  isDeckDirectoryName, NOTE_DECK_SUFFIX, NOTE_MAX_DEPTH, NoteConflictError, NoteNotFoundError, noteTarget, StaleNoteError, strictNoteParent,
} from './note-path.ts'
import { officeKindOfName, OfficeNotes } from './office-notes.ts'
import { NOTE_ORDER_FILE, appendNoteOrder, orderNoteNodes, readNoteOrder, removeNoteOrder, replaceNoteOrderName, writeNoteOrder } from './note-order.ts'
import { safeName, sameEntry, syncDirectory, writeNoteBytes } from './private-files.ts'
import type { NotesTreeNode } from './types.ts'

/** 原文读写只接受 Markdown；结构化笔记使用独立的文件格式。 */
const NOTE_EXTENSIONS = new Set(['.md', '.markdown'])

/** 单篇笔记的原始字节上限；原文区把全文载入内存，超限的条目拒绝读写。 */
const NOTE_MAX_BYTES = 1024 * 1024

/** 单棵笔记树的节点总数上限；目录与文件条目共用这一个预算。 */
const NOTE_MAX_NODES = 4096

/** 统计目录树的节点总数（含目录与文件），用于新建前的节点预算检查。 */
function countTreeNodes(entries: readonly NotesTreeNode[]): number {
  return entries.reduce((count, entry) => count + 1 + (entry.children === undefined ? 0 : countTreeNodes(entry.children)), 0)
}

/** 在已扫描的目录树中查找条目；移动前用它核对类型和子树深度。 */
function findTreeEntry(entries: readonly NotesTreeNode[], path: string): NotesTreeNode | undefined {
  for (const entry of entries) {
    if (entry.path === path) return entry
    if (entry.children !== undefined) {
      const found = findTreeEntry(entry.children, path)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** 普通目录自身及后代普通目录占用的扫描层数；文件与幻灯片工程都是零层叶子。 */
function subtreeDepth(entry: NotesTreeNode): number {
  if (entry.kind !== 'dir' || entry.children === undefined) return 0
  return 1 + Math.max(0, ...entry.children.map(subtreeDepth))
}

/**
 * 把用户输入的名称规范成幻灯片工程目录名。
 * 缺少后缀时补 `.codingppt`；已带后缀时保留用户写的大小写，只净化名称部分。
 * @throws TypeError 名称为空、只有后缀或含不安全字符时。
 */
function deckDirectoryName(name: string): string {
  const leaf = safeName(name)
  const stem = isDeckDirectoryName(leaf) ? leaf.slice(0, -NOTE_DECK_SUFFIX.length) : leaf
  // 后缀同样计入 120 字节的安全名预算，避免目录名超出与文件一致的名称上限。
  let limited = ''
  for (const character of stem) {
    if (Buffer.byteLength(limited + character + NOTE_DECK_SUFFIX, 'utf8') > 120) break
    limited += character
  }
  limited = limited.replace(/[ .]+$/u, '')
  if (limited === '' || limited === '.' || limited === '..') throw new TypeError('幻灯片名称无效')
  return `${limited}${NOTE_DECK_SUFFIX}`
}

/**
 * Markdown 是原文读写和全局文件索引支持的笔记格式。
 * @param name - 文件名或路径。
 * @returns 扩展名是否属于 Markdown。
 */
export function isMarkdownNoteName(name: string): boolean {
  return NOTE_EXTENSIONS.has(extname(name).toLowerCase())
}

/** 文件库内部的笔记存储；根目录在每次操作时由文件库校验。 */
export class NoteStore {
  readonly mindmaps: MindmapNotes
  readonly office: OfficeNotes

  constructor(private readonly root: string, private readonly openRoot: () => Promise<string>) {
    this.mindmaps = new MindmapNotes(root, openRoot, action => this.scheduleNotesWrite(action))
    this.office = new OfficeNotes(root, openRoot, action => this.scheduleNotesWrite(action))
  }

  /** 笔记写操作串行队列，避免改名/删除后的迟到保存重建旧路径。 */
  private notesWriteQueue: Promise<void> = Promise.resolve()
  private scheduleNotesWrite<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.notesWriteQueue.then(fn, fn)
    this.notesWriteQueue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * 确认真实笔记文件：父链 realpath 不逃出笔记根目录（拦符号链接子目录），
   * 条目本身是真实文件且扩展名为 Markdown。
   * @param relativePath - 相对笔记根目录的路径。
   * @returns 绝对路径与规范化相对路径。
   */
  private async safeNoteFile(relativePath: string): Promise<{ target: string; rel: string }> {
    const { rel, target } = noteTarget(this.root, relativePath)
    const notesDir = await this.openRoot()
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
      const target = await this.openRoot()
      return { target, rel: '' }
    }
    const { rel, target } = noteTarget(this.root, relativePath)
    const notesDir = await this.openRoot()
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
   * 扫描真实目录、笔记文件和幻灯片工程，不跟随符号链接。
   * 幻灯片工程目录只出现为一行 `deck` 条目，其内部的工程文件不参与扫描与节点预算。
   * 深度与节点总数超限视为结构异常，整棵树拒绝。
   * @returns 根级条目数组；每个目录按手工顺序排列，未记录的条目再按名称排序。
   */
  async notesTree(): Promise<NotesTreeNode[]> {
    const notesDir = await this.openRoot()
    let count = 0
    const scan = async (dirPath: string, prefix: string, depth: number): Promise<NotesTreeNode[]> => {
      if (depth > NOTE_MAX_DEPTH) throw new TypeError('笔记目录层级过深')
      const allEntries = await readdir(dirPath, { withFileTypes: true })
      const entries = allEntries.filter(entry => entry.name !== NOTE_ORDER_FILE).sort((a, b) => a.name.localeCompare(b.name))
      const nodes: NotesTreeNode[] = []
      for (const entry of entries) {
        count += 1
        if (count > NOTE_MAX_NODES) throw new TypeError('笔记条目过多')
        if (entry.isSymbolicLink()) continue
        const full = join(dirPath, entry.name)
        const rel = `${prefix}${entry.name}`
        if (entry.isDirectory() && isDeckDirectoryName(entry.name)) {
          const info = await lstat(full)
          if (info.isDirectory() && !info.isSymbolicLink()) nodes.push({ name: entry.name, kind: 'deck', path: rel, mtimeMs: info.mtimeMs })
        } else if (entry.isDirectory()) {
          const info = await lstat(full)
          if (info.isDirectory()) {
            nodes.push({ name: entry.name, kind: 'dir', path: rel, mtimeMs: info.mtimeMs, children: await scan(full, `${rel}/`, depth + 1) })
          }
        } else if (entry.isFile()) {
          const kind = officeKindOfName(entry.name)
            ?? (isMindmapName(entry.name) ? 'mindmap' : isMarkdownNoteName(entry.name) ? 'file' : undefined)
          if (kind === undefined) continue
          const info = await lstat(full)
          if (info.isFile() && !info.isSymbolicLink()) nodes.push({ name: entry.name, kind, path: rel, mtimeMs: info.mtimeMs })
        }
      }
      return orderNoteNodes(nodes, await readNoteOrder(dirPath))
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
      const { rel, target } = noteTarget(this.root, relativePath)
      if (!NOTE_EXTENSIONS.has(extname(target).toLowerCase())) throw new TypeError('笔记必须使用 Markdown 扩展名')
      if (Buffer.byteLength(content, 'utf8') > NOTE_MAX_BYTES) throw new TypeError('笔记超过大小上限')
      const notesDir = await this.openRoot()
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
      await writeNoteBytes(target, Buffer.from(content, 'utf8'))
      if (dir !== notesDir) await syncDirectory(notesDir)
      return { path: rel, mtimeMs: (await lstat(target)).mtimeMs }
    })
  }

  /**
   * 在指定笔记目录创建笔记；名称按文件库规则净化，缺省扩展名补 `.md`，同名已存在时拒绝。
   * 传入 `content` 时把导入的原文与文件一并落盘，避免「先建空文件再写入」留下半个结果。
   * @param name - 用户提交的文件名。
   * @param directory - 相对笔记根目录的父目录，空字符串表示根目录。
   * @param content - 初始原文；省略时创建空笔记。
   * @returns 相对笔记根目录的路径。
   * @throws TypeError 名称、父目录或内容不安全，或同名条目已存在时。
   */
  async createNote(name: string, directory: string = '', content?: string): Promise<{ path: string }> {
    return this.scheduleNotesWrite(async () => {
      const leaf = safeName(name)
      const fileName = NOTE_EXTENSIONS.has(extname(leaf).toLowerCase()) ? leaf : `${leaf}.md`
      if (content !== undefined && typeof content !== 'string') throw new TypeError('笔记内容无效')
      if (content !== undefined && Buffer.byteLength(content, 'utf8') > NOTE_MAX_BYTES) {
        throw new TypeError('笔记超过大小上限')
      }
      const parent = await this.safeNoteDirectory(directory)
      const target = join(parent.target, fileName)
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
      const handle = await open(target, flags, 0o600).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TypeError('笔记已存在')
        throw error
      })
      let writeFailure: unknown
      try {
        if (content !== undefined && content !== '') {
          await handle.writeFile(Buffer.from(content, 'utf8'))
          await handle.sync()
        }
      } catch (error) {
        writeFailure = error
      } finally {
        await handle.close()
      }
      if (writeFailure !== undefined) {
        try { await unlink(target) } catch { /* 只清理本次独占创建且写入失败的条目。 */ }
        throw writeFailure instanceof Error ? writeFailure : new Error('笔记写入失败')
      }
      await syncDirectory(parent.target)
      await appendNoteOrder(parent.target, fileName).catch(() => undefined)
      return { path: parent.rel === '' ? fileName : `${parent.rel}/${fileName}` }
    })
  }

  /**
   * 在笔记树中独占创建一份幻灯片工程目录（`{name}.codingppt`）；这是只供 Host 调用的 PPT 服务 seam。
   * 目录由本方法以 `0o700` 独占创建并同步父目录，工程内容由调用方在自己的目录句柄里写入。
   * @param name - 用户提交的名称；缺省补 `.codingppt` 后缀。
   * @param directory - 相对笔记根目录的真实私有父目录，空字符串表示根目录。
   * @returns 相对笔记根目录的目录路径，以及只在仍拥有本次创建的目录时递归清理的句柄。
   * @throws TypeError 名称或父目录不安全，或同名条目已存在时。
   */
  async createNoteDeck(name: string, directory: string = ''): Promise<{ path: string; remove: () => Promise<void> }> {
    return this.scheduleNotesWrite(async () => {
      const leaf = deckDirectoryName(name)
      const parent = await this.safeNoteDirectory(directory)
      const parentSegments = parent.rel === '' ? [] : parent.rel.split('/')
      if (parentSegments.length + 1 > NOTE_MAX_DEPTH) throw new TypeError('笔记目录层级过深')
      if (countTreeNodes(await this.notesTree()) >= NOTE_MAX_NODES) throw new TypeError('笔记条目过多')
      const target = join(parent.target, leaf)
      try { await mkdir(target, { mode: 0o700 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TypeError('幻灯片已存在')
        throw error
      }
      const owned = await lstat(target)
      try {
        await syncDirectory(parent.target)
        const notesDir = await this.openRoot()
        if (parent.target !== notesDir) await syncDirectory(notesDir)
      } catch (error) {
        try { await rmdir(target) } catch { /* 原错误是同步失败；只回滚本次仍为空的目录。 */ }
        throw error
      }
      await appendNoteOrder(parent.target, leaf).catch(() => undefined)
      return {
        path: parent.rel === '' ? leaf : `${parent.rel}/${leaf}`,
        // 只在目录仍是本次创建的那一个时递归清理，避免误删后来被替换或被填满的目录。
        remove: async () => {
          try {
            const current = await lstat(target)
            if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) return
            await rm(target, { recursive: true })
            await syncDirectory(parent.target)
            await removeNoteOrder(parent.target, leaf).catch(() => undefined)
          } catch { /* 清理不能覆盖原始创建错误。 */ }
        },
      }
    })
  }

  /**
   * 在指定笔记目录创建子目录；只接受单个目录名，拒绝覆盖现有条目。
   * @param name - 用户提交的目录名。
   * @param parent - 相对笔记根目录的父目录，空字符串表示根目录。
   * @returns 相对笔记根目录的新目录路径。
   */
  async createNoteDirectory(name: string, parent: string = ''): Promise<{ path: string }> {
    return this.scheduleNotesWrite(async () => {
      if (typeof name !== 'string' || name.length === 0 || name.length > 1024 || name.includes('\0')
        || /[\u0001-\u001f\u007f]/u.test(name) || /[\\/]/u.test(name) || name === '.' || name === '..'
        || /^[a-zA-Z]:/u.test(name)) {
        throw new TypeError('目录名无效')
      }
      const leaf = safeName(name)
      const parentDirectory = await this.safeNoteDirectory(parent)
      const parentSegments = parentDirectory.rel === '' ? [] : parentDirectory.rel.split('/')
      if (parentSegments.length + 1 > NOTE_MAX_DEPTH) throw new TypeError('笔记目录层级过深')
      if (countTreeNodes(await this.notesTree()) >= NOTE_MAX_NODES) throw new TypeError('笔记条目过多')
      const target = join(parentDirectory.target, leaf)
      try { await mkdir(target, { mode: 0o700 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TypeError('笔记目录已存在')
        throw error
      }
      await syncDirectory(parentDirectory.target)
      await appendNoteOrder(parentDirectory.target, leaf).catch(() => undefined)
      return { path: parentDirectory.rel === '' ? leaf : `${parentDirectory.rel}/${leaf}` }
    })
  }

  /**
   * 在原文件或目录的同一父目录内改名；笔记文件与幻灯片工程保留自己的后缀，不覆盖已有条目。
   * @param relativePath - 要改名的笔记文件或目录路径。
   * @param name - 新的单段名称；可省略原有文件后缀，但不能更改格式。
   * @returns 改名后的相对路径。
   */
  async renameNote(relativePath: string, name: string): Promise<{ path: string }> {
    return this.scheduleNotesWrite(async () => {
      const { rel, segments, target } = noteTarget(this.root, relativePath)
      if (typeof name !== 'string' || name.length === 0 || name.length > 1024
        || name.includes('\0') || /[\\/]/u.test(name) || name === '.' || name === '..'
        || /^[a-zA-Z]:/u.test(name)) throw new TypeError('名称无效')
      const notesDir = await this.openRoot()
      const realNotes = await realpath(notesDir)
      const parent = dirname(target)
      const officeKind = officeKindOfName(basename(target))
      const realParent = officeKind !== undefined
        ? (await strictNoteParent(notesDir, segments.slice(0, -1))).target
        : await realpath(parent).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoteNotFoundError()
          throw error
        })
      if (realParent !== realNotes && !realParent.startsWith(realNotes + sep)) throw new TypeError('笔记路径无效')
      const entry = join(realParent, basename(target))
      const current = await lstat(entry).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoteNotFoundError()
        throw error
      })
      if (current.isSymbolicLink() || !current.isFile() && !current.isDirectory()) throw new TypeError('笔记条目无效')
      const mindmap = current.isFile() && isMindmapName(basename(target))
      const office = current.isFile() && officeKind !== undefined
      const sourceExtension = current.isFile() ? extname(target) : ''
      if (current.isFile() && !office && !mindmap && !isMarkdownNoteName(target)) throw new TypeError('笔记扩展名无效')
      const leaf = safeName(name)
      const requestedExtension = current.isFile() ? extname(leaf) : ''
      if (current.isFile() && requestedExtension !== '' && requestedExtension.toLowerCase() !== sourceExtension.toLowerCase()) {
        throw new TypeError('文件扩展名不可更改')
      }
      const fileName = current.isFile()
        ? `${requestedExtension === '' ? leaf : leaf.slice(0, -requestedExtension.length)}${sourceExtension}`
        // 幻灯片工程目录与文件一样保留自己的后缀，用户只改名称部分。
        : isDeckDirectoryName(basename(target)) ? deckDirectoryName(leaf) : leaf
      const source = office ? await this.office.confirmEntry(rel, current)
        : mindmap ? await this.mindmaps.confirmEntry(rel, current) : target
      const writeParent = dirname(source)
      const targetPath = join(writeParent, office || mindmap ? safeName(fileName) : fileName)
      if (targetPath === source) return { path: rel }
      try { await lstat(targetPath); throw new NoteConflictError('笔记已存在') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
      await rename(source, targetPath)
      await syncDirectory(writeParent)
      // 排序清单只是显示增强；写入失败不撤销已经成功的改名。
      await replaceNoteOrderName(writeParent, basename(source), basename(targetPath)).catch(() => undefined)
      return { path: `${rel.slice(0, rel.lastIndexOf('/') + 1)}${basename(targetPath)}` }
    })
  }

  /**
   * 移动笔记条目并写入目标目录顺序；同目录移动只更新排序，不重命名磁盘条目。
   * `before` 为目标目录中的直属条目路径，缺省或 null 表示追加到末尾。
   * @param relativePath - 要移动的文件或真实目录的相对路径。
   * @param directory - 目标目录的相对路径，空字符串表示笔记根目录。
   * @param before - 可选的插入位置；必须与目标目录直属。
   * @returns 移动后的相对路径。
   */
  async moveNote(relativePath: string, directory: string, before?: string | null): Promise<{ path: string }> {
    return this.scheduleNotesWrite(async () => {
      const sourcePath = noteTarget(this.root, relativePath)
      const notesDir = await this.openRoot()
      const sourceParentSegments = sourcePath.segments.slice(0, -1)
      const sourceParent = await strictNoteParent(notesDir, sourceParentSegments, true)
      const sourceParentRel = sourceParentSegments.join('/')
      const sourceName = sourcePath.segments.at(-1)
      if (sourceName === undefined) throw new TypeError('笔记路径无效')
      const sourceEntryPath = join(sourceParent.target, sourceName)
      const current = await lstat(sourceEntryPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoteNotFoundError()
        throw error
      })
      if (current.isSymbolicLink() || !current.isFile() && !current.isDirectory()) throw new TypeError('笔记条目无效')

      const tree = await this.notesTree()
      const sourceEntry = findTreeEntry(tree, sourcePath.rel)
      if (sourceEntry === undefined) throw new NoteNotFoundError()
      const destinationSegments = directory === '' ? [] : noteTarget(this.root, directory).segments
      const destinationParent = await strictNoteParent(notesDir, destinationSegments, true)
      const destinationRel = destinationSegments.join('/')
      const destinationNode = destinationRel === '' ? undefined : findTreeEntry(tree, destinationRel)
      if (destinationRel !== '' && destinationNode?.kind !== 'dir') throw new TypeError('笔记目录无效')
      const destinationChildren = destinationRel === '' ? tree : destinationNode?.children
      if (destinationChildren === undefined) throw new TypeError('笔记目录无效')

      let beforeName: string | undefined
      if (before !== undefined && before !== null) {
        const insertion = noteTarget(this.root, before)
        const insertionParent = insertion.segments.slice(0, -1).join('/')
        if (insertionParent !== destinationRel) throw new TypeError('插入位置无效')
        if (insertion.rel === sourcePath.rel) return { path: sourcePath.rel }
        if (!destinationChildren.some(entry => entry.path === insertion.rel)) throw new NoteConflictError('插入位置已变化')
        beforeName = insertion.segments.at(-1)
      }

      const sameDirectory = sourceParentRel === destinationRel
      if (!sameDirectory && current.isDirectory()
        && (destinationRel === sourcePath.rel || destinationRel.startsWith(`${sourcePath.rel}/`))) {
        throw new TypeError('不能将目录移入自身或其子目录')
      }
      if (!sameDirectory && current.isDirectory()
        && destinationSegments.length + subtreeDepth(sourceEntry) > NOTE_MAX_DEPTH) {
        throw new TypeError('笔记目录层级过深')
      }

      const currentNames = destinationChildren.map(entry => entry.name).filter(name => !sameDirectory || name !== sourceName)
      const insertionIndex = beforeName === undefined ? currentNames.length : currentNames.indexOf(beforeName)
      if (insertionIndex < 0) throw new NoteConflictError('插入位置已变化')
      const orderedNames = [...currentNames.slice(0, insertionIndex), sourceName, ...currentNames.slice(insertionIndex)]
      const latestSourceParent = await strictNoteParent(notesDir, sourceParentSegments, true)
      const latestDestinationParent = await strictNoteParent(notesDir, destinationSegments, true)
      if (latestSourceParent.target !== sourceParent.target || latestDestinationParent.target !== destinationParent.target
        || !sameEntry(latestSourceParent.info, sourceParent.info) || !sameEntry(latestDestinationParent.info, destinationParent.info)
        || !sameEntry(latestSourceParent.rootInfo, sourceParent.rootInfo)) {
        throw new NoteConflictError('笔记目录已更换')
      }
      if (sameDirectory) {
        if (orderedNames.every((name, index) => name === destinationChildren[index]?.name)) return { path: sourcePath.rel }
        await writeNoteOrder(destinationParent.target, orderedNames)
        return { path: sourcePath.rel }
      }

      const officeKind = current.isFile() ? officeKindOfName(sourceName) : undefined
      const mindmap = current.isFile() && isMindmapName(sourceName)
      if (current.isFile() && officeKind === undefined && !mindmap && !isMarkdownNoteName(sourceName)) {
        throw new TypeError('笔记扩展名无效')
      }
      const source = officeKind !== undefined ? await this.office.confirmEntry(sourcePath.rel, current)
        : mindmap ? await this.mindmaps.confirmEntry(sourcePath.rel, current) : sourceEntryPath
      if (!sameEntry(await lstat(source), current)) throw new NoteConflictError('笔记条目已更换')
      const targetPath = join(destinationParent.target, sourceName)
      try {
        await lstat(targetPath)
        throw new NoteConflictError('笔记已存在')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await rename(source, targetPath)
      await syncDirectory(sourceParent.target)
      if (destinationParent.target !== sourceParent.target) await syncDirectory(destinationParent.target)
      if (sourceParent.target !== notesDir || destinationParent.target !== notesDir) await syncDirectory(notesDir)
      await writeNoteOrder(destinationParent.target, orderedNames)
      await removeNoteOrder(sourceParent.target, sourceName).catch(() => undefined)
      return { path: destinationRel === '' ? sourceName : `${destinationRel}/${sourceName}` }
    })
  }

  /**
   * 删除单个笔记文件或整个目录；拒绝将符号链接作为目标，目录中的链接只移除链接本身。
   * @param relativePath - 要删除的文件或目录路径。
   * @returns 删除完成后兑现；目标不存在或路径越界时拒绝。
   */
  async deleteNote(relativePath: string): Promise<void> {
    return this.scheduleNotesWrite(async () => {
      const { rel, segments, target } = noteTarget(this.root, relativePath)
      const notesDir = await this.openRoot()
      const realNotes = await realpath(notesDir)
      const parent = dirname(target)
      const officeKind = officeKindOfName(basename(target))
      const realParent = officeKind !== undefined
        ? (await strictNoteParent(notesDir, segments.slice(0, -1))).target
        : await realpath(parent).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoteNotFoundError()
          throw error
        })
      if (realParent !== realNotes && !realParent.startsWith(realNotes + sep)) throw new TypeError('笔记路径无效')
      const entry = join(realParent, basename(target))
      const current = await lstat(entry).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoteNotFoundError()
        throw error
      })
      if (current.isSymbolicLink() || !current.isFile() && !current.isDirectory()) throw new TypeError('笔记条目无效')
      if (current.isDirectory()) {
        // 递归前确认实际目录是根目录的真子路径，不能通过文件系统别名选中根目录本身。
        if (!(await realpath(entry)).startsWith(realNotes + sep)) throw new TypeError('笔记路径无效')
        await rm(entry, { recursive: true })
      } else {
        if (officeKind !== undefined) await unlink(await this.office.confirmEntry(rel, current))
        else if (isMindmapName(basename(entry))) await unlink(await this.mindmaps.confirmEntry(rel, current))
        else if (!isMarkdownNoteName(entry)) throw new TypeError('笔记扩展名无效')
        else await unlink(entry)
      }
      await syncDirectory(realParent)
      await removeNoteOrder(realParent, basename(entry)).catch(() => undefined)
    })
  }
}
