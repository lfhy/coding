/**
 * 字体嵌入：找出工程用到的字体族、在系统字体目录里找到对应字形文件、按 OS/2.fsType
 * 的许可位决定能不能嵌，最后包成 PowerPoint 认识的 EOT（`.fntdata`）。
 *
 * 许可永远先于技术：`fsType` 的 Restricted(0x0002) 与 BitmapOnly(0x0200) 一律跳过，
 * Preview&Print(0x0004) 只写只读嵌入，Installable/Editable(0x0000/0x0008) 正常嵌入。
 * 读不到 OS/2 表时同样跳过——「读不出许可」不等于「允许」。
 * @module coding-ppt-workbench/fonts
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import subsetFont from 'subset-font'

/** 一个可以写进 .pptx 的字体。 */
export interface EmbeddedFont {
  /** 字体族名（与 `a:latin typeface` 取值一致）。 */
  readonly family: string
  /** `ppt/fonts/fontN.fntdata`。 */
  readonly part: string
  readonly bytes: Uint8Array
  readonly fsType: number
  /** Preview&Print：目标机只能看与打印，不能编辑。 */
  readonly readonly: boolean
  /** 字体文件路径，写进导出摘要便于排查。 */
  readonly path: string
  /** 是否写入了子集而不是整字体。 */
  readonly subset: boolean
}

/** 被跳过的字体与原因。 */
export interface SkippedFont {
  readonly family: string
  readonly reason: string
}

/** 解析出的字形文件元数据。 */
interface FontFace {
  readonly path: string
  readonly family: string
  readonly fsType: number | null
  readonly weight: number
  readonly bytes: Uint8Array
}

const FS_RESTRICTED = 0x0002
const FS_PREVIEW_PRINT = 0x0004
const FS_BITMAP_ONLY = 0x0200

/**
 * 平台默认的系统字体目录。
 * @returns 需要扫描的目录列表（不存在的目录会被自动跳过）。
 */
export function systemFontDirs(): string[] {
  if (process.platform === 'darwin') {
    return ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts',
      join(homedir(), 'Library/Fonts')]
  }
  if (process.platform === 'win32') {
    return [join(process.env['WINDIR'] ?? 'C:\\Windows', 'Fonts'), join(homedir(), 'AppData/Local/Microsoft/Windows/Fonts')]
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', join(homedir(), '.fonts'), join(homedir(), '.local/share/fonts')]
}

function u16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) * 0x1000000)
    + ((bytes[offset + 1] ?? 0) << 16)
    + ((bytes[offset + 2] ?? 0) << 8)
    + (bytes[offset + 3] ?? 0)
}

interface Tables {
  readonly [tag: string]: { offset: number; length: number }
}

const TTC_MAGIC = 0x74746366

/**
 * 从一个 `.ttc` 集合里取出第一个 face，重建成独立的 TTF。
 * 表目录里的偏移在集合中是相对整个文件的绝对偏移，重建时按 4 字节对齐重新排布。
 * @param bytes - 集合文件字节。
 * @returns 单 face 的 TTF；不是集合时返回原字节。
 */
export function extractFirstFace(bytes: Uint8Array): Uint8Array {
  if (u32(bytes, 0) !== TTC_MAGIC) return bytes
  const faceCount = u32(bytes, 8)
  if (faceCount === 0) return bytes
  const faceOffset = u32(bytes, 12)
  const numTables = u16(bytes, faceOffset + 4)
  const records: { tag: number; checksum: number; offset: number; length: number }[] = []
  for (let index = 0; index < numTables; index += 1) {
    const record = faceOffset + 12 + index * 16
    records.push({
      tag: u32(bytes, record),
      checksum: u32(bytes, record + 4),
      offset: u32(bytes, record + 8),
      length: u32(bytes, record + 12),
    })
  }
  const searchRange = 2 ** Math.floor(Math.log2(numTables)) * 16
  const headerSize = 12 + numTables * 16
  let size = headerSize
  for (const record of records) size += Math.ceil(record.length / 4) * 4
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x00010000, false)
  view.setUint16(4, numTables, false)
  view.setUint16(6, searchRange, false)
  view.setUint16(8, Math.log2(searchRange / 16), false)
  view.setUint16(10, numTables * 16 - searchRange, false)
  let cursor = headerSize
  records.forEach((record, index) => {
    const entry = 12 + index * 16
    view.setUint32(entry, record.tag, false)
    view.setUint32(entry + 4, record.checksum, false)
    view.setUint32(entry + 8, cursor, false)
    view.setUint32(entry + 12, record.length, false)
    out.set(bytes.subarray(record.offset, record.offset + record.length), cursor)
    cursor += Math.ceil(record.length / 4) * 4
  })
  return out
}

function tableDirectory(bytes: Uint8Array): Tables | null {
  if (bytes.length < 12) return null
  const sfnt = u32(bytes, 0)
  // 只处理 glyf 轮廓的 TrueType（EOT 的既定约束）；OTTO/CFF 与集合不在这里猜。
  if (sfnt !== 0x00010000) return null
  const count = u16(bytes, 4)
  const tables: Record<string, { offset: number; length: number }> = {}
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16
    if (record + 16 > bytes.length) return null
    const tag = String.fromCharCode(bytes[record] ?? 0, bytes[record + 1] ?? 0, bytes[record + 2] ?? 0, bytes[record + 3] ?? 0)
    tables[tag] = { offset: u32(bytes, record + 8), length: u32(bytes, record + 12) }
  }
  return tables
}

function familyName(bytes: Uint8Array, tables: Tables): string {
  const table = tables['name']
  if (table === undefined) return ''
  const count = u16(bytes, table.offset + 2)
  const base = table.offset + u16(bytes, table.offset + 4)
  let fallback = ''
  for (let index = 0; index < count; index += 1) {
    const record = table.offset + 6 + index * 12
    const platform = u16(bytes, record)
    const language = u16(bytes, record + 4)
    const nameId = u16(bytes, record + 6)
    if (nameId !== 1) continue
    const length = u16(bytes, record + 8)
    const offset = u16(bytes, record + 10)
    const raw = bytes.subarray(base + offset, base + offset + length)
    if (platform === 3) {
      let text = ''
      for (let cursor = 0; cursor + 1 < raw.length; cursor += 2) {
        text += String.fromCharCode(((raw[cursor] ?? 0) << 8) | (raw[cursor + 1] ?? 0))
      }
      if (language === 0x0409) return text
      if (fallback === '') fallback = text
    } else if (platform === 1 && fallback === '') {
      fallback = String.fromCharCode(...raw)
    }
  }
  return fallback
}

/**
 * 解析一个字体文件。
 * @param path - 文件路径。
 * @returns 字体元数据；不是 glyf TrueType 时 null。
 */
export async function readFontFace(path: string): Promise<FontFace | null> {
  const bytes = await readFile(path).catch(() => null)
  if (bytes === null) return null
  // 集合字体取第一个 face：EOT 只能封装单 face 的 glyf TrueType。
  const data = extractFirstFace(new Uint8Array(bytes))
  const tables = tableDirectory(data)
  if (tables === null) return null
  const os2 = tables['OS/2']
  return {
    path,
    family: familyName(data, tables),
    fsType: os2 === undefined ? null : u16(data, os2.offset + 8),
    weight: os2 === undefined ? 400 : u16(data, os2.offset + 4),
    bytes: data,
  }
}

/**
 * 按 `fsType` 判断能否嵌入。
 * @param fsType - OS/2.fsType，读不到时为 null。
 * @returns 可嵌入时 `readonly` 表示只能只读嵌入；不可嵌入时 `reason` 说明原因。
 */
export function licenceOf(fsType: number | null): { embeddable: true; readonly: boolean } | { embeddable: false; reason: string } {
  if (fsType === null) return { embeddable: false, reason: '字体没有 OS/2 表，读不出嵌入许可' }
  if ((fsType & FS_RESTRICTED) !== 0) return { embeddable: false, reason: '字体声明禁止嵌入（fsType 0x0002）' }
  if ((fsType & FS_BITMAP_ONLY) !== 0) return { embeddable: false, reason: '字体只允许位图嵌入（fsType 0x0200）' }
  return { embeddable: true, readonly: (fsType & FS_PREVIEW_PRINT) !== 0 }
}

/**
 * 扫描字体目录，建立族名到文件的索引。
 * @param dirs - 目录列表；不存在或不可读的目录跳过。
 * @returns 族名（小写）到字形的映射，同族取常规字重。
 */
export async function indexFonts(dirs: readonly string[]): Promise<Map<string, FontFace>> {
  const index = new Map<string, FontFace>()
  for (const dir of dirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (index.size < 4000) {
          for (const [family, face] of await indexFonts([path])) {
            if (!index.has(family)) index.set(family, face)
          }
        }
        continue
      }
      if (!/\.ttf$/iu.test(entry.name)) continue
      const info = await stat(path).catch(() => null)
      if (info === null || info.size > 24 * 1024 * 1024) continue
      const face = await readFontFace(path)
      if (face === null || face.family === '') continue
      const key = face.family.toLowerCase()
      const current = index.get(key)
      if (current === undefined || Math.abs(face.weight - 400) < Math.abs(current.weight - 400)) {
        index.set(key, face)
      }
    }
  }
  return index
}

const EOT_VERSION = 0x00020001
const EOT_MAGIC = 0x504c

function utf16leNull(text: string): Uint8Array {
  const out = new Uint8Array((text.length + 1) * 2)
  const view = new DataView(out.buffer)
  for (let index = 0; index < text.length; index += 1) view.setUint16(index * 2, text.charCodeAt(index), true)
  return out
}

/**
 * 把 TrueType 包成 PowerPoint 认的 EOT（版本 0x00020001，不子集、不压缩、不加密）。
 * @param face - 已解析的字体。
 * @returns `.fntdata` 字节；不是 glyf TrueType 时 null。
 */
export function wrapEot(face: FontFace): Uint8Array | null {
  const tables = tableDirectory(face.bytes)
  if (tables === null) return null
  const head = tables['head']
  const os2 = tables['OS/2']
  if (head === undefined || os2 === undefined) return null
  const bytes = new Uint8Array(face.bytes)
  const checkSumAdjustment = u32(bytes, head.offset + 8)
  bytes.fill(0, head.offset + 8, head.offset + 12)
  const panose = bytes.subarray(os2.offset + 32, os2.offset + 42)
  const italic = (u16(bytes, os2.offset + 62) & 0x01) === 1 ? 1 : 0
  const unicodeRange = [0, 1, 2, 3].map(index => u32(bytes, os2.offset + 42 + index * 4))
  const codePageRange = [u32(bytes, os2.offset + 78), u32(bytes, os2.offset + 82)]
  const charset = (codePageRange[0] ?? 0) & 0x00040000 ? 134 : 0
  const names = [face.family, 'Regular', '', face.family].map(utf16leNull)
  const namesLength = names.reduce((sum, name) => sum + 4 + name.length, 0)
  const size = 80 + namesLength + 24 + bytes.length
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let cursor = 0
  const put16 = (value: number): void => { view.setUint16(cursor, value & 0xffff, true); cursor += 2 }
  const put32 = (value: number): void => { view.setUint32(cursor, value >>> 0, true); cursor += 4 }
  put32(size)
  put32(bytes.length)
  put32(EOT_VERSION)
  put32(0)
  out.set(panose, cursor)
  cursor += 10
  out[cursor++] = charset
  out[cursor++] = italic
  put32(face.weight)
  put16(face.fsType ?? 0)
  put16(EOT_MAGIC)
  for (const value of unicodeRange) put32(value)
  for (const value of codePageRange) put32(value)
  put32(checkSumAdjustment)
  put32(0)
  put32(0)
  put32(0)
  put32(0)
  for (const name of names) {
    put16(0)
    put16(name.length)
    out.set(name, cursor)
    cursor += name.length
  }
  put16(0)
  put16(0)
  put32(0)
  put32(0)
  put16(0)
  put16(0)
  put32(0)
  put32(0)
  out.set(bytes, cursor)
  cursor += bytes.length
  return cursor === size ? out : null
}

/**
 * 收集工程里出现过的字体族。
 * @param deck - 演示文稿。
 * @returns 需要嵌入的族名集合（空串代表主题默认字体，不嵌入）。
 */
export function usedFamilies(deck: { pages: readonly { elements: readonly unknown[] }[] }): string[] {
  const families = new Set<string>()
  for (const page of deck.pages) {
    for (const element of page.elements) {
      const record = element as { kind?: string; text?: { font?: string }; [key: string]: unknown }
      if (record.kind === 'text' && typeof record.text?.font === 'string' && record.text.font !== '') {
        families.add(record.text.font)
      }
      if (record.kind === 'table') {
        const style = record['text']
        if (typeof style?.font === 'string' && style.font !== '') families.add(style.font)
      }
    }
  }
  return [...families]
}

/**
 * 收集某个字体族在工程里实际用到的字符。
 * @param deck - 演示文稿。
 * @param family - 字体族名。
 * @returns 去重后的字符（含大小写与标点），子集化按它保留字形。
 */
export function charactersFor(
  deck: { pages: readonly { elements: readonly unknown[] }[] },
  family: string,
): string {
  const characters = new Set<string>()
  for (const page of deck.pages) {
    for (const element of page.elements) {
      const record = element as {
        kind?: string
        text?: { content?: string; font?: string }
        cells?: readonly (readonly { readonly content: string }[])[]
        [key: string]: unknown
      }
      if (record.kind === 'text' && record.text?.font === family
        && typeof record.text.content === 'string') {
        for (const character of record.text.content) characters.add(character)
      }
      if (record.kind === 'table') {
        if (record.text?.font !== family) continue
        for (const row of record.cells ?? []) {
          for (const cell of row) for (const character of cell.content) characters.add(character)
        }
      }
    }
  }
  return [...characters].join('')
}

/**
 * 按实际用到的字符把字体子集化。
 * @param bytes - 原始 TTF 字节。
 * @param text - 需要保留的字符。
 * @returns 子集 TTF；子集化失败（例如字体不带对应轮廓）时返回 null，调用方回退整字体。
 */
export async function subsetFace(bytes: Uint8Array, text: string): Promise<Uint8Array | null> {
  if (text.trim() === '') return null
  try {
    const result = await subsetFont(Buffer.from(bytes), text, { targetFormat: 'truetype' })
    return new Uint8Array(result)
  } catch {
    return null
  }
}

/**
 * 为工程准备要嵌入的字体：优先写子集，子集化失败时退回整字体。
 * @param deck - 演示文稿。
 * @param dirs - 字体目录；缺省用平台默认目录。
 * @param options.subset - 是否尝试子集化，缺省开启（测试或排障时可关掉）。
 * @returns 可嵌入的字体与被跳过的族（含原因）。
 */
export async function collectFonts(
  deck: { pages: readonly { elements: readonly unknown[] }[] },
  dirs: readonly string[] = systemFontDirs(),
  options: { subset?: boolean } = {},
): Promise<{ fonts: EmbeddedFont[]; skipped: SkippedFont[] }> {
  const families = usedFamilies(deck)
  if (families.length === 0) return { fonts: [], skipped: [] }
  const index = await indexFonts(dirs)
  const fonts: EmbeddedFont[] = []
  const skipped: SkippedFont[] = []
  for (const family of families) {
    const face = index.get(family.toLowerCase())
    if (face === undefined) {
      skipped.push({ family, reason: '这台机器上没有找到这个字体，未嵌入' })
      continue
    }
    const licence = licenceOf(face.fsType)
    if (!licence.embeddable) {
      skipped.push({ family, reason: licence.reason })
      continue
    }
    const characters = charactersFor(deck, family)
    const subset = options.subset === false ? null : await subsetFace(face.bytes, characters)
    const source: FontFace = subset === null
      ? face
      : { ...face, bytes: subset }
    const bytes = wrapEot(source)
    if (bytes === null) {
      skipped.push({ family, reason: '字体不是可封装的 TrueType 轮廓' })
      continue
    }
    fonts.push({
      family,
      part: `ppt/fonts/font${fonts.length + 1}.fntdata`,
      bytes,
      fsType: face.fsType ?? 0,
      readonly: licence.readonly,
      path: face.path,
      subset: subset !== null,
    })
  }
  return { fonts, skipped }
}
