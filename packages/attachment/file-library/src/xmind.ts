/** 只读取现代 XMind ZIP 中根级的 `content.json`；其余成员的数据不解包，也不落盘。 */
import { crc32, inflateRawSync } from 'node:zlib'

/** 从 HTTP 流和 Host 字节对象接受的 XMind 原始大小上限。 */
export const XMIND_UPLOAD_MAX_BYTES = 16 * 1024 * 1024
const MAX_CONTENT_BYTES = 2 * 1024 * 1024
const MAX_MEMBERS = 4096
const CONTENT_NAME = Buffer.from('content.json')

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50
const DATA_DESCRIPTOR = 0x08074b50

function invalidArchive(): never {
  throw new TypeError('XMind 压缩包无效或使用了不支持的格式')
}

interface Member {
  method: number
  flags: number
  crc: number
  compressed: number
  size: number
  local: number
}

function contentDirectory(bytes: Uint8Array, view: DataView): { member: Member; directory: number } {
  const u16 = (at: number) => view.getUint16(at, true)
  const u32 = (at: number) => view.getUint32(at, true)
  let end = bytes.length - 22
  for (; end >= Math.max(0, bytes.length - 65557); end -= 1) {
    if (u32(end) === END_OF_CENTRAL && end + 22 + u16(end + 20) === bytes.length) break
  }
  if (end < Math.max(0, bytes.length - 65557) || u16(end + 4) !== 0 || u16(end + 6) !== 0
    || u16(end + 8) !== u16(end + 10)) invalidArchive()
  const count = u16(end + 10)
  const directory = u32(end + 16)
  if (count > MAX_MEMBERS || directory + u32(end + 12) !== end) invalidArchive()
  let member: Member | undefined
  let pos = directory
  for (let index = 0; index < count; index += 1) {
    if (pos + 46 > end || u32(pos) !== CENTRAL_HEADER || u16(pos + 34) !== 0) invalidArchive()
    const length = u16(pos + 28)
    const next = pos + 46 + length + u16(pos + 30) + u16(pos + 32)
    if (next > end) invalidArchive()
    if (length === CONTENT_NAME.length && CONTENT_NAME.every((byte, i) => byte === bytes[pos + 46 + i])) {
      const attributes = u32(pos + 38)
      const fileType = attributes >>> 16 & 0xf000
      if (member !== undefined || (attributes & 0x10) !== 0 || fileType !== 0 && fileType !== 0x8000) invalidArchive()
      member = { method: u16(pos + 10), flags: u16(pos + 8), crc: u32(pos + 16),
        compressed: u32(pos + 20), size: u32(pos + 24), local: u32(pos + 42) }
    }
    pos = next
  }
  if (pos !== end) invalidArchive()
  if (member === undefined) throw new TypeError('XMind 文件缺少现代格式的 content.json')
  return { member, directory }
}

function memberBytes(bytes: Uint8Array, view: DataView, member: Member, directory: number): Uint8Array {
  const u16 = (at: number) => view.getUint16(at, true)
  const u32 = (at: number) => view.getUint32(at, true)
  const { method, flags, crc, compressed, size, local } = member
  if (size === 0 || size > MAX_CONTENT_BYTES) throw new TypeError('XMind 主题文件为空或超过 2 MiB')
  if (method !== 0 && method !== 8 || (flags & ~(method === 8 ? 0x080e : 0x0808)) !== 0
    || local + 30 + CONTENT_NAME.length > directory || u32(local) !== LOCAL_HEADER
    || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== CONTENT_NAME.length
    || !CONTENT_NAME.every((byte, i) => byte === bytes[local + 30 + i])) invalidArchive()
  const start = local + 30 + CONTENT_NAME.length + u16(local + 28)
  const end = start + compressed
  if (end > directory || method === 0 && compressed !== size) invalidArchive()
  if ((flags & 8) === 0) {
    if (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size) invalidArchive()
  } else {
    // 流式 ZIP 的 CRC 和大小可在数据描述符给出，不依赖本地头中的占位值。
    const matches = (pos: number) => pos + 12 <= directory && u32(pos) === crc
      && u32(pos + 4) === compressed && u32(pos + 8) === size
    if (!matches(end) && !(end + 4 <= directory && u32(end) === DATA_DESCRIPTOR && matches(end + 4))) invalidArchive()
  }
  return bytes.subarray(start, end)
}

/**
 * 核对 ZIP 中央目录、本地头和目标成员的 CRC。声明长度只能收紧实际解压预算，不能取代解压限额。
 * @param bytes - 已限制原始字节数的 XMind ZIP。
 * @returns 根级 `content.json` 的解压字节；不支持分卷、加密或 ZIP64 主题文件。
 */
export function readXMindContent(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const { member, directory } = contentDirectory(bytes, view)
  const compressed = memberBytes(bytes, view, member, directory)
  let output: Uint8Array
  try {
    output = member.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: member.size })
  } catch {
    throw new TypeError('XMind 主题文件解压失败或超出大小上限')
  }
  if (output.byteLength !== member.size || crc32(output) !== member.crc) invalidArchive()
  return output
}
