/**
 * 最小 ZIP 打包器：.pptx 是 OPC 容器，导出只需要「写入若干 UTF-8 XML 部件」。
 * 用 Node 内置 zlib 做 raw deflate，不引入第三方 zip 依赖。
 * @module coding-ppt-workbench/export/zip
 */

import { deflateRawSync } from 'node:zlib'

/** 一个待写入的 ZIP 成员。 */
export interface ZipEntry {
  /** 成员路径，使用 `/` 分隔且不带前导斜杠。 */
  readonly path: string
  readonly data: Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/**
 * 计算 CRC-32（ZIP 使用的反射多项式）。
 * @param data - 待校验的字节。
 * @returns 无符号 32 位校验和。
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** DOS 时间：固定为 1980-01-01 00:00，导出结果因此可复现。 */
const DOS_TIME = 0
const DOS_DATE = 0x0021

function header(size: number, write: (view: DataView) => void): Uint8Array {
  const buffer = new Uint8Array(size)
  write(new DataView(buffer.buffer))
  return buffer
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * 打包成 ZIP 字节流（deflate 压缩、UTF-8 文件名、无目录条目）。
 * @param entries - 按写入顺序排列的成员。
 * @returns 完整的 ZIP 文件内容。
 */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.path)
    const compressed = new Uint8Array(deflateRawSync(entry.data))
    const crc = crc32(entry.data)
    const local = concat([
      header(30, (view) => {
        view.setUint32(0, 0x04034b50, true)
        view.setUint16(4, 20, true)
        view.setUint16(6, 0x0800, true)
        view.setUint16(8, 8, true)
        view.setUint16(10, DOS_TIME, true)
        view.setUint16(12, DOS_DATE, true)
        view.setUint32(14, crc, true)
        view.setUint32(18, compressed.length, true)
        view.setUint32(22, entry.data.length, true)
        view.setUint16(26, name.length, true)
        view.setUint16(28, 0, true)
      }),
      name,
      compressed,
    ])
    locals.push(local)
    centrals.push(concat([
      header(46, (view) => {
        view.setUint32(0, 0x02014b50, true)
        view.setUint16(4, 20, true)
        view.setUint16(6, 20, true)
        view.setUint16(8, 0x0800, true)
        view.setUint16(10, 8, true)
        view.setUint16(12, DOS_TIME, true)
        view.setUint16(14, DOS_DATE, true)
        view.setUint32(16, crc, true)
        view.setUint32(20, compressed.length, true)
        view.setUint32(24, entry.data.length, true)
        view.setUint16(28, name.length, true)
        view.setUint16(30, 0, true)
        view.setUint16(32, 0, true)
        view.setUint16(34, 0, true)
        view.setUint16(36, 0, true)
        view.setUint32(38, 0, true)
        view.setUint32(42, offset, true)
      }),
      name,
    ]))
    offset += local.length
  }
  const central = concat(centrals)
  const end = header(22, (view) => {
    view.setUint32(0, 0x06054b50, true)
    view.setUint16(4, 0, true)
    view.setUint16(6, 0, true)
    view.setUint16(8, entries.length, true)
    view.setUint16(10, entries.length, true)
    view.setUint32(12, central.length, true)
    view.setUint32(16, offset, true)
    view.setUint16(20, 0, true)
  })
  return concat([...locals, central, end])
}
