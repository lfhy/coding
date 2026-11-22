/** 思维导图的磁盘边界：与普通笔记改名和删除共用写入队列。 */
import { constants, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  applyMindmapEdits, decodeMindmap, decodeXMind, encodeMindmap, isMindmapName, MINDMAP_MAX_BYTES,
  mindmapRevision, newMindmap, NOTE_MINDMAP_SUFFIX, parseMindmapEdits,
} from './mindmap.ts'
import { NoteConflictError, NoteNotFoundError, noteTarget, StaleNoteError, strictNoteParent, type NoteParent } from './note-path.ts'
import { safeName, sameEntry, syncDirectory, writeNoteBytes } from './private-files.ts'
import type { MindMapDocument, MindMapSnapshot } from './types.ts'
import { XMIND_UPLOAD_MAX_BYTES } from './xmind.ts'

const XMIND_SUFFIX = '.xmind'

function fileError(error: unknown): never {
  const { code } = error as NodeJS.ErrnoException
  if (code === 'ENOENT') throw new NoteNotFoundError()
  if (code === 'ELOOP' || code === 'ENOTDIR') throw new TypeError('笔记路径无效')
  throw error
}

async function realFile(target: string): Promise<Stats> {
  const info = await lstat(target).catch(fileError)
  if (!info.isFile() || info.isSymbolicLink()) throw new TypeError('思维导图不是真实笔记文件')
  return info
}

async function readMindmapBytes(target: string): Promise<{ bytes: Buffer; info: Stats }> {
  const expected = await realFile(target)
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  const handle = await open(target, flags).catch(fileError)
  try {
    const info = await handle.stat()
    if (!info.isFile() || !sameEntry(info, expected)) throw new StaleNoteError()
    if (info.size > MINDMAP_MAX_BYTES) throw new TypeError('原生思维导图超过 1 MiB')
    // 文件可在 fstat 后增长，限制从已打开句柄实际读取的字节数。
    const buffer = Buffer.allocUnsafe(MINDMAP_MAX_BYTES + 1)
    let count = 0
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count)
      if (bytesRead === 0) break
      count += bytesRead
    }
    if (count > MINDMAP_MAX_BYTES) throw new TypeError('原生思维导图超过 1 MiB')
    return { bytes: buffer.subarray(0, count), info }
  } finally { await handle.close() }
}

function nativeName(name: string): string {
  const leaf = safeName(name)
  const stem = isMindmapName(leaf) ? leaf.slice(0, -NOTE_MINDMAP_SUFFIX.length) : leaf
  return safeName(`${stem}${NOTE_MINDMAP_SUFFIX}`)
}

function importSource(name: string): { leaf: string; xmind: boolean } {
  const leaf = safeName(name)
  if (isMindmapName(leaf)) return { leaf, xmind: false }
  if (leaf.toLowerCase().endsWith(XMIND_SUFFIX)) return { leaf: leaf.slice(0, -XMIND_SUFFIX.length), xmind: true }
  throw new TypeError('仅支持导入原生思维导图或 XMind 文件')
}

/**
 * 返回与实际导入校验相同的收流上限；传输层在聚合字节前使用。
 * @param name - 来源文件名。
 * @returns 格式对应的字节上限；不支持的后缀抛出 `TypeError`。
 */
export function mindmapImportByteLimit(name: string): number {
  return importSource(name).xmind ? XMIND_UPLOAD_MAX_BYTES : MINDMAP_MAX_BYTES
}

interface LocatedMindmap {
  rel: string
  parent: NoteParent
  segments: string[]
  target: string
}

/** 文件库内部的思维导图存储；所有写入通过笔记存储持有的独占队列。 */
export class MindmapNotes {
  constructor(
    private readonly root: string,
    private readonly openRoot: () => Promise<string>,
    private readonly write: <T>(action: () => Promise<T>) => Promise<T>,
  ) {}

  private async locate(path: string): Promise<LocatedMindmap> {
    const { rel, segments, target } = noteTarget(this.root, path)
    const leaf = basename(target)
    if (!isMindmapName(leaf)) throw new TypeError('思维导图扩展名无效')
    const directories = segments.slice(0, -1)
    const parent = await strictNoteParent(await this.openRoot(), directories)
    return { rel, parent, segments: directories, target: join(parent.target, leaf) }
  }

  private async assertParent(parent: NoteParent, segments: readonly string[]): Promise<void> {
    const current = await strictNoteParent(await this.openRoot(), segments)
    if (parent.target !== current.target || !sameEntry(parent.rootInfo, current.rootInfo) || !sameEntry(parent.info, current.info)) {
      throw new NoteConflictError('笔记目录已更换')
    }
  }

  /**
   * 改名或删除前核对同一真实对象，不透过链接提交。
   * @param path - 客户端路径。
   * @param expected - 识别文件类型时获得的条目身份。
   * @returns 经核对的实际文件路径。
   */
  async confirmEntry(path: string, expected: Stats): Promise<string> {
    const { target, parent, segments } = await this.locate(path)
    if (!sameEntry(await realFile(target), expected)) throw new StaleNoteError()
    await this.assertParent(parent, segments)
    return target
  }

  /** 新建只有中心主题的原生文件；最终名称和中心文字均来自规范化文件名。 */
  async create(name: string, directory: string = ''): Promise<{ path: string }> {
    const leaf = nativeName(name)
    return this.createFile(leaf, directory, newMindmap(leaf.slice(0, -NOTE_MINDMAP_SUFFIX.length)))
  }

  /** 先完全校验导入内容，再写入独占的原生笔记文件。 */
  async import(name: string, data: Uint8Array, directory: string = ''): Promise<{ path: string }> {
    if (!(data instanceof Uint8Array)) throw new TypeError('思维导图文件无效')
    const { leaf, xmind } = importSource(name)
    return this.createFile(nativeName(leaf), directory, xmind ? decodeXMind(data) : decodeMindmap(data))
  }

  private async createFile(leaf: string, directory: string, document: MindMapDocument): Promise<{ path: string }> {
    const bytes = encodeMindmap(document)
    const segments = directory === '' ? [] : noteTarget(this.root, directory).segments
    return this.write(async () => {
      const parent = await strictNoteParent(await this.openRoot(), segments, true)
      try {
        await writeNoteBytes(join(parent.target, leaf), bytes, {
          exclusive: true, beforeCommit: () => this.assertParent(parent, segments),
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new NoteConflictError('笔记已存在')
        throw error
      }
      if (parent.target !== parent.root) await syncDirectory(parent.root)
      return { path: [...segments, leaf].join('/') }
    })
  }

  /** 读取磁盘字节和对应的版本；外部直接放入的文件也必须通过结构校验。 */
  async read(path: string): Promise<MindMapSnapshot> {
    const { rel, target, parent, segments } = await this.locate(path)
    const { bytes } = await readMindmapBytes(target)
    await this.assertParent(parent, segments)
    return { path: rel, revision: mindmapRevision(bytes), document: decodeMindmap(bytes) }
  }

  /** 在锁内核对基准，验证整批编辑，最后以一次原子替换提交。 */
  async edit(path: string, revision: string, edits: unknown): Promise<MindMapSnapshot> {
    if (typeof revision !== 'string' || revision.length === 0 || revision.length > 128) throw new TypeError('思维导图版本无效')
    const batch = parseMindmapEdits(edits)
    return this.write(async () => {
      const { rel, target, parent, segments } = await this.locate(path)
      const base = await readMindmapBytes(target)
      if (mindmapRevision(base.bytes) !== revision) throw new StaleNoteError()
      const document = applyMindmapEdits(decodeMindmap(base.bytes), batch)
      const bytes = encodeMindmap(document)
      await this.assertParent(parent, segments)
      await writeNoteBytes(target, bytes, { beforeCommit: async () => {
        await this.assertParent(parent, segments)
        const current = await readMindmapBytes(target)
        if (!sameEntry(current.info, base.info) || mindmapRevision(current.bytes) !== revision) throw new StaleNoteError()
        await this.assertParent(parent, segments)
      } })
      if (parent.target !== parent.root) await syncDirectory(parent.root)
      return { path: rel, revision: mindmapRevision(bytes), document }
    })
  }
}
