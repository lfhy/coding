/** 安全读取 Office ZIP：验证索引与成员身份，在任何 Office XML 解析之前限额解包，不写磁盘。 */
import { crc32, inflateRawSync } from 'node:zlib'

/** 同一 Office 导入字节上限用于 HTTP 收流和 Host 解包。 */
export const OFFICE_UPLOAD_MAX_BYTES = 16 * 1024 * 1024
const ZIP_TOTAL_MAX_BYTES = 64 * 1024 * 1024
const ZIP_PART_MAX_BYTES = 32 * 1024 * 1024
const ZIP_MAX_MEMBERS = 2_048
const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50
const DATA_DESCRIPTOR = 0x08074b50
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

interface Member {
  name: string
  directory: boolean
  encodedName: Uint8Array
  method: number
  flags: number
  crc: number
  compressedSize: number
  size: number
  local: number
}

function invalidArchive(): never {
  throw new TypeError('Office 压缩包无效或使用了不支持的格式')
}

/** 核对 Office 部件的单段名称；调用方须自行解析关系目标的相对层级。 */
export function validOfficePartSegment(segment: string): boolean {
  return segment !== '' && !/[\u0000-\u001f\u007f\\/%:?#]|[. ]$/u.test(segment)
}

/** 只接受非空、无别名、斜杠分隔的包内路径。 */
export function validOfficePartPath(path: string): boolean {
  return path.length <= 512 && path.split('/').every(validOfficePartSegment)
}

function extraFields(bytes: Buffer, start: number, end: number): void {
  for (let pos = start; pos < end;) {
    if (pos + 4 > end) invalidArchive()
    const kind = bytes.readUInt16LE(pos)
    // ZIP64 与 Unicode 路径覆写会产生两份不一致的索引解释。
    if (kind === 0x0001 || kind === 0x7075) invalidArchive()
    pos += 4 + bytes.readUInt16LE(pos + 2)
    if (pos > end) invalidArchive()
  }
}

function centralMembers(bytes: Buffer): { members: Member[]; directory: number } {
  const u16 = (at: number) => bytes.readUInt16LE(at)
  const u32 = (at: number) => bytes.readUInt32LE(at)
  const earliest = Math.max(0, bytes.length - 65_557)
  let end = bytes.length - 22
  for (; end >= earliest; end -= 1) {
    if (u32(end) === END_OF_CENTRAL && end + 22 + u16(end + 20) === bytes.length) break
  }
  if (end < earliest || u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== u16(end + 10)) invalidArchive()
  const count = u16(end + 10)
  const directory = u32(end + 16)
  if (count === 0 || count > ZIP_MAX_MEMBERS || directory + u32(end + 12) !== end) invalidArchive()

  const members: Member[] = []
  const seen = new Set<string>()
  const files = new Set<string>()
  const paths = new Set<string>()
  let declaredBytes = 0
  let position = directory
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > end || u32(position) !== CENTRAL_HEADER || u16(position + 34) !== 0) invalidArchive()
    const nameStart = position + 46
    const nameEnd = nameStart + u16(position + 28)
    const extraEnd = nameEnd + u16(position + 30)
    const next = extraEnd + u16(position + 32)
    if (next > end) invalidArchive()
    extraFields(bytes, nameEnd, extraEnd)
    const encodedName = bytes.subarray(nameStart, nameEnd)
    let rawName: string
    try { rawName = utf8.decode(encodedName) }
    catch { invalidArchive() }
    const isDirectory = rawName.endsWith('/')
    const name = isDirectory ? rawName.slice(0, -1) : rawName
    if (!validOfficePartPath(name)) invalidArchive()
    const key = name.toLowerCase()
    if (seen.has(key)) invalidArchive()
    seen.add(key)
    if (isDirectory) paths.add(key)
    else files.add(key)
    const segments = key.split('/')
    for (let i = 1; i < segments.length; i += 1) paths.add(segments.slice(0, i).join('/'))

    const method = u16(position + 10)
    const flags = u16(position + 8)
    const attributes = u32(position + 38)
    const fileType = attributes >>> 16 & 0xf000
    const size = u32(position + 24)
    const crc = u32(position + 16)
    const local = u32(position + 42)
    declaredBytes += size
    if (local >= directory || method !== 0 && method !== 8 || (flags & ~(method === 8 ? 0x080e : 0x0808)) !== 0
      || fileType !== 0 && fileType !== (isDirectory ? 0x4000 : 0x8000) || !isDirectory && (attributes & 0x10) !== 0
      || isDirectory && (size !== 0 || crc !== 0)) invalidArchive()
    if (size > ZIP_PART_MAX_BYTES || declaredBytes > ZIP_TOTAL_MAX_BYTES) throw new TypeError('Office 解压内容超过大小上限')
    members.push({ name, directory: isDirectory, encodedName, method, flags, crc, size, compressedSize: u32(position + 20), local })
    position = next
  }
  if (position !== end || [...files].some(file => paths.has(file))) invalidArchive()
  return { members, directory }
}

function compressedMember(bytes: Buffer, member: Member, next: number): Uint8Array {
  const u16 = (at: number) => bytes.readUInt16LE(at)
  const u32 = (at: number) => bytes.readUInt32LE(at)
  const { method, flags, crc, compressedSize, size, local, encodedName } = member
  const nameEnd = local + 30 + encodedName.length
  if (nameEnd > next || u32(local) !== LOCAL_HEADER || u16(local + 6) !== flags || u16(local + 8) !== method
    || u16(local + 26) !== encodedName.length || !bytes.subarray(local + 30, nameEnd).equals(encodedName)) invalidArchive()
  const dataStart = nameEnd + u16(local + 28)
  const dataEnd = dataStart + compressedSize
  if (dataEnd > next || method === 0 && compressedSize !== size) invalidArchive()
  extraFields(bytes, nameEnd, dataStart)
  if ((flags & 8) === 0) {
    if (dataEnd !== next || u32(local + 14) !== crc || u32(local + 18) !== compressedSize || u32(local + 22) !== size) invalidArchive()
  } else {
    // 流式 ZIP 的真实 CRC 和长度来自数据描述符。区间必须精确衔接，不能重叠或藏有未登记成员。
    const descriptor = next - 12
    if (!(descriptor === dataEnd || descriptor === dataEnd + 4 && u32(dataEnd) === DATA_DESCRIPTOR)
      || u32(descriptor) !== crc || u32(descriptor + 4) !== compressedSize || u32(descriptor + 8) !== size) invalidArchive()
  }
  return bytes.subarray(dataStart, dataEnd)
}

/**
 * 以真实输出核对 ZIP 的预算、长度和 CRC；读取失败不会留下文件。
 * @param input - 来源 ZIP 字节；支持常规存储和 Deflate，不支持分卷、加密或 ZIP64。
 * @returns 经校验的部件映射，目录条目不进入结果。
 */
export function readOfficeZip(input: Uint8Array): Map<string, Uint8Array> {
  if (!(input instanceof Uint8Array) || input.byteLength < 22) invalidArchive()
  if (input.byteLength > OFFICE_UPLOAD_MAX_BYTES) throw new TypeError('Office 上传超过 16 MiB')
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const { members, directory } = centralMembers(bytes)
  members.sort((a, b) => a.local - b.local)
  if (members[0]?.local !== 0) invalidArchive()
  const entries = new Map<string, Uint8Array>()
  let actualBytes = 0
  for (const [i, member] of members.entries()) {
    const compressed = compressedMember(bytes, member, members[i + 1]?.local ?? directory)
    const limit = Math.min(member.size, ZIP_PART_MAX_BYTES, ZIP_TOTAL_MAX_BYTES - actualBytes)
    let output: Uint8Array
    try {
      // 声明长度只能收紧解压器的硬上限，不能靠预分配或解压后检查替代。
      output = member.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(limit, 1) })
    } catch { throw new TypeError('Office 解压失败或超出大小上限') }
    if (output.byteLength !== member.size || output.byteLength > limit || crc32(output) !== member.crc) invalidArchive()
    actualBytes += output.byteLength
    if (!member.directory) entries.set(member.name, output)
  }
  return entries
}
