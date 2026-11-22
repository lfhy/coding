/** 笔记磁盘操作：路径准入、目录与文件的写入顺序由同一实例持有。 */
import { constants, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { isMindmapName } from './mindmap.ts'
import { MindmapNotes } from './mindmap-notes.ts'
import {
  isDeckDirectoryName, NOTE_DECK_SUFFIX, NOTE_MAX_DEPTH, NoteConflictError, NoteNotFoundError, noteTarget, StaleNoteError,
} from './note-path.ts'
import { safeName, syncDirectory, writeNoteBytes } from './private-files.ts'
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

  constructor(private readonly root: string, private readonly openRoot: () => Promise<string>) {
    this.mindmaps = new MindmapNotes(root, openRoot, action => this.scheduleNotesWrite(action))
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
   * 扫描真实目录、Markdown、思维导图和幻灯片工程，不跟随符号链接。
   * 幻灯片工程目录只出现为一行 `deck` 条目，其内部的工程文件不参与扫描与节点预算。
   * 深度与节点总数超限视为结构异常，整棵树拒绝。
   * @returns 根级条目数组；子节点按名称排序。
   */
  async notesTree(): Promise<NotesTreeNode[]> {
    const notesDir = await this.openRoot()
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
        if (entry.isDirectory() && isDeckDirectoryName(entry.name)) {
          const info = await lstat(full)
          if (info.isDirectory() && !info.isSymbolicLink()) nodes.push({ name: entry.name, kind: 'deck', path: rel, mtimeMs: info.mtimeMs })
        } else if (entry.isDirectory()) {
          const info = await lstat(full)
          if (info.isDirectory()) {
            nodes.push({ name: entry.name, kind: 'dir', path: rel, mtimeMs: info.mtimeMs, children: await scan(full, `${rel}/`, depth + 1) })
          }
        } else if (entry.isFile()) {
          const kind = isMindmapName(entry.name) ? 'mindmap' : isMarkdownNoteName(entry.name) ? 'file' : undefined
          if (kind === undefined) continue
          const info = await lstat(full)
          if (info.isFile() && !info.isSymbolicLink()) nodes.push({ name: entry.name, kind, path: rel, mtimeMs: info.mtimeMs })
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
    return { path: parent.rel === '' ? fileName : `${parent.rel}/${fileName}` }
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
      return {
        path: parent.rel === '' ? leaf : `${parent.rel}/${leaf}`,
        // 只在目录仍是本次创建的那一个时递归清理，避免误删后来被替换或被填满的目录。
        remove: async () => {
          try {
            const current = await lstat(target)
            if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) return
            await rm(target, { recursive: true })
            await syncDirectory(parent.target)
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
    return { path: parentDirectory.rel === '' ? leaf : `${parentDirectory.rel}/${leaf}` }
  }

  /**
   * 在原文件或目录的同一父目录内改名；笔记文件与幻灯片工程保留自己的后缀，不覆盖已有条目。
   * @param relativePath - 要改名的笔记文件或目录路径。
   * @param name - 新的单段名称；可省略原有文件后缀，但不能更改格式。
   * @returns 改名后的相对路径。
   */
  async renameNote(relativePath: string, name: string): Promise<{ path: string }> {
    return this.scheduleNotesWrite(async () => {
      const { rel, target } = noteTarget(this.root, relativePath)
      if (typeof name !== 'string' || name.length === 0 || name.length > 1024
        || name.includes('\0') || /[\\/]/u.test(name) || name === '.' || name === '..'
        || /^[a-zA-Z]:/u.test(name)) throw new TypeError('名称无效')
      const notesDir = await this.openRoot()
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
      const mindmap = current.isFile() && isMindmapName(basename(target))
      const sourceExtension = current.isFile() ? extname(target) : ''
      if (current.isFile() && !mindmap && !isMarkdownNoteName(target)) throw new TypeError('笔记扩展名无效')
      const leaf = safeName(name)
      const requestedExtension = current.isFile() ? extname(leaf) : ''
      if (current.isFile() && requestedExtension !== '' && requestedExtension.toLowerCase() !== sourceExtension.toLowerCase()) {
        throw new TypeError('文件扩展名不可更改')
      }
      const fileName = current.isFile()
        ? `${requestedExtension === '' ? leaf : leaf.slice(0, -requestedExtension.length)}${sourceExtension}`
        // 幻灯片工程目录与文件一样保留自己的后缀，用户只改名称部分。
        : isDeckDirectoryName(basename(target)) ? deckDirectoryName(leaf) : leaf
      const source = mindmap ? await this.mindmaps.confirmEntry(rel, current) : target
      const writeParent = dirname(source)
      const targetPath = join(writeParent, mindmap ? safeName(fileName) : fileName)
      if (targetPath === source) return { path: rel }
      try { await lstat(targetPath); throw new NoteConflictError('笔记已存在') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
      await rename(source, targetPath)
      await syncDirectory(writeParent)
      return { path: `${rel.slice(0, rel.lastIndexOf('/') + 1)}${basename(targetPath)}` }
    })
  }

  /**
   * 删除单个笔记文件或整个目录；拒绝将符号链接作为目标，目录中的链接只移除链接本身。
   * @param relativePath - 要删除的文件或目录路径。
   * @returns 删除完成后兑现；目标不存在或路径越界时拒绝。
   */
  async deleteNote(relativePath: string): Promise<void> {
    return this.scheduleNotesWrite(async () => {
      const { rel, target } = noteTarget(this.root, relativePath)
      const notesDir = await this.openRoot()
      const realNotes = await realpath(notesDir)
      const parent = dirname(target)
      const realParent = await realpath(parent).catch((error: unknown) => {
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
        if (isMindmapName(basename(entry))) await unlink(await this.mindmaps.confirmEntry(rel, current))
        else if (!isMarkdownNoteName(entry)) throw new TypeError('笔记扩展名无效')
        else await unlink(entry)
      }
      await syncDirectory(realParent)
    })
  }
}
