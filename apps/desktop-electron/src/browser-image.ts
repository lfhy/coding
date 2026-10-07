/** 将 CDP 的 PNG 截图送入共享图片限额策略；原生解码仅在 Electron 主进程进行。 */

import { nativeImage } from 'electron'
import { fitImage } from '@deepseek-ai/dsh-attachment/image-processing'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_SOURCE_BYTES = 100 * 1024 * 1024
const MAX_SOURCE_PIXELS = 80_000_000

function dimensions(bytes: Uint8Array): { width: number; height: number } {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (source.length < 33 || !source.subarray(0, 8).equals(PNG_SIGNATURE) ||
    source.readUInt32BE(8) !== 13 || source.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('browser screenshot is not a PNG with an IHDR header')
  }
  const width = source.readUInt32BE(16)
  const height = source.readUInt32BE(20)
  if (!width || !height || width * height > MAX_SOURCE_PIXELS) {
    throw new Error(`browser screenshot dimensions exceed ${MAX_SOURCE_PIXELS} pixels`)
  }
  return { width, height }
}

/**
 * 验证截图的传输、格式与真实解码尺寸，超出发布限额时借助原生 PNG 编码器缩小。
 * 无需处理的有效 PNG 原样返回；任何不可压入限额的图片都会拒绝发布。
 * @param encoded - CDP 返回的 base64 PNG 字符串。
 * @param maxBytes - 浏览器桥容许的 PNG 字节数。
 * @returns 经验证且不超过限额的 PNG 字节。
 */
export async function fitBrowserPng(encoded: unknown, maxBytes: number): Promise<Uint8Array> {
  const maxBase64Length = Math.ceil(MAX_SOURCE_BYTES / 3) * 4
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > maxBase64Length ||
    encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new Error(`browser screenshot base64 exceeds ${MAX_SOURCE_BYTES} bytes or is invalid`)
  }
  const source = Buffer.from(encoded, 'base64')
  if (source.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`browser screenshot source exceeds ${MAX_SOURCE_BYTES} bytes`)
  }
  const sourceSize = dimensions(source)
  const native = nativeImage.createFromBuffer(source)
  const nativeSize = native.getSize()
  if (native.isEmpty() || nativeSize.width !== sourceSize.width || nativeSize.height !== sourceSize.height) {
    throw new Error('browser screenshot PNG dimensions do not match decoded image')
  }
  const result = await fitImage(source, sourceSize, { maxBytes }, { lossy: false,
    encode: (target) => {
      const resized = native.resize({ width: target.width, height: target.height, quality: 'best' })
      const encoded = resized.toPNG()
      const encodedSize = dimensions(encoded)
      const decodedSize = resized.getSize()
      if (encodedSize.width !== target.width || encodedSize.height !== target.height ||
        decodedSize.width !== target.width || decodedSize.height !== target.height) {
        throw new Error('browser screenshot resized PNG dimensions are invalid')
      }
      return Promise.resolve(encoded)
    },
  })
  if (result.byteLength > maxBytes) throw new Error(`browser screenshot exceeds ${maxBytes} bytes`)
  const resultSize = dimensions(result)
  const decoded = nativeImage.createFromBuffer(Buffer.from(result))
  const decodedSize = decoded.getSize()
  if (decoded.isEmpty() || decodedSize.width !== resultSize.width ||
    decodedSize.height !== resultSize.height ||
    resultSize.width > sourceSize.width || resultSize.height > sourceSize.height) {
    throw new Error('browser screenshot output PNG dimensions are invalid')
  }
  return result
}
