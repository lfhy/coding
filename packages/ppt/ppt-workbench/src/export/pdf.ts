/**
 * 最小 PDF 导出：把每页渲染出的 PNG 解成像素、重新 Flate 压缩后写成一页一图的 PDF。
 *
 * 不引入 PDF 库：PNG 解码只覆盖 8 位深、非隔行的 RGB/RGBA/灰度（Chromium 截图就是这几种），
 * PDF 结构只写必需的对象（Catalog、Pages、每页的 Page + 图片 XObject + 内容流）。
 * 页面尺寸按 96 DPI 把像素换算成点：1280×720 → 960×540 pt。
 * @module coding-ppt-workbench/export/pdf
 */

import { deflateSync, unzlibSync } from 'fflate'

/** 一张要写进 PDF 的页面图。 */
export interface PdfPageImage {
  readonly bytes: Uint8Array
  /** 像素尺寸；缺省时按 PNG 头里的宽高。 */
  readonly width?: number
  readonly height?: number
}

interface DecodedImage {
  readonly width: number
  readonly height: number
  /** 每像素 3 或 1 字节的原始数据。 */
  readonly rgb: Uint8Array
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 24 | (bytes[offset + 1] ?? 0) << 16
    | (bytes[offset + 2] ?? 0) << 8 | (bytes[offset + 3] ?? 0)) >>> 0
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

/**
 * 解码非隔行的 8 位 PNG。
 * @param bytes - PNG 文件字节。
 * @returns 宽高与按行解滤波后的像素。
 * @throws Error - 不是受支持的 PNG 形态时。
 */
export function decodePng(bytes: Uint8Array): DecodedImage {
  if (readUint32(bytes, 0) !== 0x89504e47) throw new Error('不是 PNG 文件')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  let interlace = 0
  const idat: Uint8Array[] = []
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset)
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0,
    )
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = readUint32(data, 0)
      height = readUint32(data, 4)
      const bitDepth = data[8] ?? 8
      colorType = data[9] ?? 6
      interlace = data[12] ?? 0
      if (bitDepth !== 8) throw new Error('只支持 8 位深的 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (width === 0 || height === 0) throw new Error('PNG 缺少 IHDR')
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (channels === 0) throw new Error('只支持 RGB／RGBA／灰度 PNG')
  const merged = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0))
  let cursor = 0
  for (const part of idat) {
    merged.set(part, cursor)
    cursor += part.length
  }
  const raw = unzlibSync(merged)
  const stride = width * channels
  const out = new Uint8Array(stride * height)
  let previous = new Uint8Array(stride)
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] ?? 0
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1))
    const current = new Uint8Array(stride)
    for (let index = 0; index < stride; index += 1) {
      const value = line[index] ?? 0
      const left = index >= channels ? current[index - channels] ?? 0 : 0
      const up = previous[index] ?? 0
      const upLeft = index >= channels ? previous[index - channels] ?? 0 : 0
      current[index] = filter === 1 ? (value + left) & 0xff
        : filter === 2 ? (value + up) & 0xff
          : filter === 3 ? (value + ((left + up) >> 1)) & 0xff
            : filter === 4 ? (value + paeth(left, up, upLeft)) & 0xff
              : value
    }
    out.set(current, row * stride)
    previous = current
  }
  if (channels === 4) {
    const rgb = new Uint8Array(width * height * 3)
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      rgb[pixel * 3] = out[pixel * 4] ?? 0
      rgb[pixel * 3 + 1] = out[pixel * 4 + 1] ?? 0
      rgb[pixel * 3 + 2] = out[pixel * 4 + 2] ?? 0
    }
    return { width, height, rgb }
  }
  if (channels === 1) {
    const rgb = new Uint8Array(width * height * 3)
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const value = out[pixel] ?? 0
      rgb[pixel * 3] = value
      rgb[pixel * 3 + 1] = value
      rgb[pixel * 3 + 2] = value
    }
    return { width, height, rgb }
  }
  return { width, height, rgb: out }
}

const encoder = new TextEncoder()

/**
 * 把若干页面图拼成一份 PDF。
 * @param pages - 按顺序排列的页面图。
 * @returns PDF 文件字节。
 * @throws Error - 没有任何页面时。
 */
export function buildPdf(pages: readonly PdfPageImage[]): Uint8Array {
  if (pages.length === 0) throw new Error('PDF 至少需要一页')
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (part: string | Uint8Array): void => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part
    chunks.push(bytes)
    length += bytes.length
  }
  const object = (id: number, body: string): void => {
    offsets[id] = length
    push(`${id} 0 obj\n${body}\nendobj\n`)
  }
  const streamObject = (id: number, dictionary: string, data: Uint8Array): void => {
    offsets[id] = length
    push(`${id} 0 obj\n<< ${dictionary} /Length ${data.length} >>\nstream\n`)
    push(data)
    push('\nendstream\nendobj\n')
  }

  push('%PDF-1.4\n')
  const pageIds = pages.map((_, index) => 4 + index * 3)
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`)
  object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  pages.forEach((page, index) => {
    const image = decodePng(page.bytes)
    const widthPx = page.width ?? image.width
    const heightPx = page.height ?? image.height
    const widthPt = (widthPx * 72 / 96).toFixed(2)
    const heightPt = (heightPx * 72 / 96).toFixed(2)
    const pageId = pageIds[index] ?? 0
    const imageId = pageId + 1
    const contentId = pageId + 2
    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] `
      + `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`)
    streamObject(
      imageId,
      `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} `
      + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode',
      deflateSync(image.rgb),
    )
    const content = `q ${widthPt} 0 0 ${heightPt} 0 0 cm /Im0 Do Q\n`
    streamObject(contentId, '', encoder.encode(content))
  })
  const xrefOffset = length
  const count = 4 + pages.length * 3
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let id = 1; id < count; id += 1) {
    xref += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`
  }
  push(xref)
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
  const out = new Uint8Array(length)
  let cursor = 0
  for (const chunk of chunks) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return out
}
