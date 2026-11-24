/** Office 原生笔记的磁盘边界：文件类型、父链身份和版本核对均在文件库内。 */
import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { NoteConflictError, NoteNotFoundError, noteTarget, StaleNoteError, strictNoteParent, type NoteParent } from './note-path.ts'
import { safeName, sameEntry, syncDirectory, writeNoteBytes } from './private-files.ts'
import type { OfficeDocument, OfficeExport, OfficeKind, OfficeSnapshot } from './types.ts'
import { blankOfficeDocument, decodeOfficeDocument, encodeOfficeDocument, officeKind, parseOfficeDocument } from './office/document.ts'
import { applyOfficeEdits, parseOfficeEdits } from './office/edits.ts'
import { exportExcel, importExcel } from './office/excel.ts'
import { OFFICE_FORMAT, openOfficePackage } from './office/package.ts'
import { exportWord, importWord } from './office/word.ts'

/** Word 原生文件的后缀；`.docx` 只用于导入、导出。 */
export const NOTE_WORD_SUFFIX = '.codingword'
/** Excel 原生文件的后缀；`.xlsx` 只用于导入、导出。 */
export const NOTE_EXCEL_SUFFIX = '.codingexcel'
const SUFFIX = { word: NOTE_WORD_SUFFIX, excel: NOTE_EXCEL_SUFFIX } as const

/** 通过具有非空名称的原生文件后缀识别 Office 类型；不检查磁盘类型。 */
export function officeKindOfName(name: string): OfficeKind | undefined {
  const lower = name.toLowerCase()
  if (name.length > NOTE_WORD_SUFFIX.length && lower.endsWith(NOTE_WORD_SUFFIX)) return 'word'
  if (name.length > NOTE_EXCEL_SUFFIX.length && lower.endsWith(NOTE_EXCEL_SUFFIX)) return 'excel'
  return undefined
}

function nativeName(kind: OfficeKind, name: string, importing: boolean): string {
  const leaf = safeName(name)
  const native = officeKindOfName(leaf)
  if (native !== undefined && native !== kind) throw new TypeError('办公笔记文件名与类型不匹配')
  if (native === kind) return safeName(`${leaf.slice(0, -SUFFIX[kind].length)}${SUFFIX[kind]}`)
  if (importing) {
    const lower = leaf.toLowerCase()
    const sourceSuffix = OFFICE_FORMAT[kind].suffix
    if (lower.endsWith(sourceSuffix)) return safeName(`${leaf.slice(0, -sourceSuffix.length)}${SUFFIX[kind]}`)
    if (/\.(?:docx|xlsx|docm|xlsm|xlsb|xlam|dotm|dotx|doc|xls)$/u.test(lower)) throw new TypeError('不支持这种办公文件后缀')
  }
  return safeName(`${leaf}${SUFFIX[kind]}`)
}

function actualVersion(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function assertRevision(revision: string): void {
  if (typeof revision !== 'string' || revision.length === 0 || revision.length > 128 || /[\u0000-\u001f\u007f]/u.test(revision)) {
    throw new TypeError('办公笔记版本无效')
  }
}

function normalizeFileError(error: unknown): never {
  const { code } = error as NodeJS.ErrnoException
  if (code === 'ENOENT') throw new NoteNotFoundError()
  if (code === 'ELOOP' || code === 'ENOTDIR') throw new TypeError('办公笔记路径无效')
  throw error
}

async function regularOfficeFile(path: string): Promise<Stats> {
  const info = await lstat(path).catch(normalizeFileError)
  if (!info.isFile() || info.isSymbolicLink()) throw new TypeError('办公笔记不是真实文件')
  return info
}

async function readOfficeBytes(target: string): Promise<{ bytes: Buffer; info: Stats }> {
  const expected = await regularOfficeFile(target)
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(normalizeFileError)
  try {
    const info = await handle.stat()
    if (!info.isFile() || !sameEntry(info, expected)) throw new StaleNoteError()
    // 文件可能增长：读到预期大小后的额外一个字节即可确认快照已失效，不继续分配。
    const buffer = Buffer.allocUnsafe(info.size + 1)
    let count = 0
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count)
      if (bytesRead === 0) break
      count += bytesRead
    }
    const after = await handle.stat()
    if (count !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      throw new StaleNoteError()
    }
    return { bytes: buffer.subarray(0, count), info }
  } finally { await handle.close() }
}

interface LocatedOffice {
  rel: string
  kind: OfficeKind
  segments: string[]
  parent: NoteParent
  target: string
}

/** Office 写操作使用 NoteStore 提供的队列，不另设能与改名或删除竞争的锁。 */
export class OfficeNotes {
  constructor(
    private readonly root: string,
    private readonly openRoot: () => Promise<string>,
    private readonly write: <T>(action: () => Promise<T>) => Promise<T>,
  ) {}

  private async locate(path: string): Promise<LocatedOffice> {
    const { rel, segments, target } = noteTarget(this.root, path)
    const leaf = basename(target)
    const kind = officeKindOfName(leaf)
    if (kind === undefined) throw new TypeError('办公笔记扩展名无效')
    const directories = segments.slice(0, -1)
    const parent = await strictNoteParent(await this.openRoot(), directories)
    return { rel, kind, segments: directories, parent, target: join(parent.target, leaf) }
  }

  private async assertParent(parent: NoteParent, segments: readonly string[]): Promise<void> {
    const current = await strictNoteParent(await this.openRoot(), segments)
    if (parent.target !== current.target || !sameEntry(parent.rootInfo, current.rootInfo) || !sameEntry(parent.info, current.info)) {
      throw new NoteConflictError('笔记目录已更换')
    }
  }

  /** 改名和删除的真实文件确认；不要求内容仍是有效原生文档。 */
  async confirmEntry(path: string, expected: Stats): Promise<string> {
    const { target, parent, segments } = await this.locate(path)
    if (!sameEntry(await regularOfficeFile(target), expected)) throw new StaleNoteError()
    await this.assertParent(parent, segments)
    return target
  }

  /** 生成完整空白文档并独占发布。 */
  async create(requestedKind: OfficeKind, name: string, directory = ''): Promise<{ path: string }> {
    const kind = officeKind(requestedKind)
    return this.createFile(nativeName(kind, name, false), directory, blankOfficeDocument(kind))
  }

  /** 全部解包与校验完成后，只写转换后的独立原生副本。 */
  async import(requestedKind: OfficeKind, name: string, bytes: Uint8Array, directory = ''): Promise<{ path: string }> {
    const kind = officeKind(requestedKind)
    const leaf = nativeName(kind, name, true)
    const source = openOfficePackage(bytes, kind)
    const document = parseOfficeDocument(kind === 'word' ? importWord(source) : importExcel(source), kind)
    return this.createFile(leaf, directory, document)
  }

  private async createFile(leaf: string, directory: string, document: OfficeDocument): Promise<{ path: string }> {
    const bytes = encodeOfficeDocument(document)
    const segments = directory === '' ? [] : noteTarget(this.root, directory).segments
    return this.write(async () => {
      const parent = await strictNoteParent(await this.openRoot(), segments, true)
      if (parent.target !== parent.root) await syncDirectory(parent.root)
      await this.assertParent(parent, segments)
      try {
        await writeNoteBytes(join(parent.target, leaf), bytes, { exclusive: true, beforeCommit: () => this.assertParent(parent, segments) })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new NoteConflictError('笔记已存在')
        normalizeFileError(error)
      }
      return { path: [...segments, leaf].join('/') }
    })
  }

  /** 读取与原始磁盘内容版本相匹配的文件快照。 */
  async read(path: string): Promise<OfficeSnapshot> {
    const { rel, kind, parent, segments, target } = await this.locate(path)
    const { bytes } = await readOfficeBytes(target)
    await this.assertParent(parent, segments)
    return { path: rel, revision: actualVersion(bytes), document: decodeOfficeDocument(bytes, kind) }
  }

  /** 替换整份文档；版本失配、文件缺失或类型不符时均不写入。 */
  async save(path: string, revision: string, document: unknown): Promise<OfficeSnapshot> {
    return this.update(path, revision, (_previous, kind) => parseOfficeDocument(document, kind))
  }

  /** 按顺序应用已校验的编辑操作，只有最终结果被发布。 */
  async edit(path: string, revision: string, edits: unknown): Promise<OfficeSnapshot> {
    const batch = parseOfficeEdits(edits)
    return this.update(path, revision, (previous, kind) => applyOfficeEdits(decodeOfficeDocument(previous, kind), batch))
  }

  private async update(
    path: string, revision: string, change: (previous: Uint8Array, kind: OfficeKind) => OfficeDocument,
  ): Promise<OfficeSnapshot> {
    assertRevision(revision)
    return this.write(async () => {
      const { rel, kind, parent, segments, target } = await this.locate(path)
      const base = await readOfficeBytes(target)
      if (actualVersion(base.bytes) !== revision) throw new StaleNoteError()
      const document = change(base.bytes, kind)
      const bytes = encodeOfficeDocument(document)
      await this.assertParent(parent, segments)
      await writeNoteBytes(target, bytes, { beforeCommit: async () => {
        await this.assertParent(parent, segments)
        const current = await readOfficeBytes(target)
        if (!sameEntry(current.info, base.info) || actualVersion(current.bytes) !== revision) throw new StaleNoteError()
        await this.assertParent(parent, segments)
      } }).catch(normalizeFileError)
      return { path: rel, revision: actualVersion(bytes), document }
    })
  }

  /** 一次读取后仅转换该快照；导出不占用写队列，也不写入文件库。 */
  async export(path: string, revision?: string): Promise<OfficeExport> {
    if (revision !== undefined) assertRevision(revision)
    const snapshot = await this.read(path)
    if (revision !== undefined && revision !== snapshot.revision) throw new StaleNoteError()
    const { document } = snapshot
    const { suffix, mediaType } = OFFICE_FORMAT[document.kind]
    const name = `${basename(snapshot.path).slice(0, -SUFFIX[document.kind].length)}${suffix}`
    const bytes = document.kind === 'word' ? await exportWord(document) : exportExcel(document)
    return { name, mediaType, bytes }
  }
}
