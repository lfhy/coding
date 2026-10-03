// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImagePreparationError, prepareImage } from '../src/client/skeleton/prepare-image.ts'

const limits = {
  maxImageBytes: 100, maxImagesPerMessage: 2, maxMessageImageBytes: 200,
  maxImagePixels: 1_000_000, maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
}
const original = globalThis.createImageBitmap

afterEach(() => {
  globalThis.createImageBitmap = original
  vi.restoreAllMocks()
})

function bitmap(width: number, height: number) {
  const close = vi.fn()
  globalThis.createImageBitmap = vi.fn(async () => ({ width, height, close }))
  return close
}

function canvas(type: string, bytes = 10) {
  const drawImage = vi.fn()
  const toBlob = vi.fn((callback: BlobCallback, _type?: string, _quality?: number) => {
    callback(new Blob([new Uint8Array(bytes)], { type }))
  })
  const element = document.createElement('canvas')
  vi.spyOn(element, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
  vi.spyOn(element, 'toBlob').mockImplementation(toBlob)
  vi.spyOn(document, 'createElement').mockReturnValue(element)
  return { element, drawImage, toBlob }
}

describe('image preparation', () => {
  it('leaves a compliant image unchanged without upscaling or transcoding', async () => {
    const close = bitmap(100, 200)
    const file = new File(['x'], 'tiny.png', { type: 'image/png' })
    expect(await prepareImage(file, limits)).toBe(file)
    expect(close).toHaveBeenCalledOnce()
  })

  it('downscales both the side and pixel bound while preserving JPEG metadata', async () => {
    const close = bitmap(4000, 3000)
    const { element, drawImage, toBlob } = canvas('image/jpeg')
    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg', lastModified: 123 })
    const result = await prepareImage(file, limits)
    expect(element.width * element.height).toBeLessThanOrEqual(limits.maxImagePixels)
    expect(Math.max(element.width, element.height)).toBeLessThanOrEqual(limits.maxImageDimension)
    expect(element.width / element.height).toBeCloseTo(4 / 3, 2)
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, element.width, element.height)
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.85)
    expect(result).toMatchObject({ name: 'photo.jpg', type: 'image/jpeg', lastModified: 123 })
    expect(close).toHaveBeenCalledOnce()
  })

  it('preserves PNG and WebP formats when resizing', async () => {
    for (const type of ['image/png', 'image/webp']) {
      bitmap(3000, 1000)
      const { toBlob } = canvas(type)
      expect((await prepareImage(new File(['x'], 'image', { type }), limits)).type).toBe(type)
      expect(toBlob).toHaveBeenCalledWith(expect.any(Function), type, type === 'image/png' ? undefined : 0.85)
      vi.restoreAllMocks()
    }
  })

  it('does not flatten animated GIFs and fails explicitly when dimensions exceed the limit', async () => {
    bitmap(3000, 200)
    const gif = new File(['x'], 'animation.gif', { type: 'image/gif' })
    await expect(prepareImage(gif, limits)).rejects.toEqual(new ImagePreparationError('gif'))
    bitmap(200, 200)
    expect(await prepareImage(gif, limits)).toBe(gif)
  })

  it('reports undecodable files and failed encoders rather than accepting their bytes', async () => {
    globalThis.createImageBitmap = vi.fn().mockRejectedValue(new Error('bad raster'))
    const png = new File(['x'], 'bad.png', { type: 'image/png' })
    await expect(prepareImage(png, limits)).rejects.toEqual(new ImagePreparationError('decode'))
    bitmap(4000, 3000)
    canvas('image/jpeg')
    await expect(prepareImage(png, limits)).rejects.toEqual(new ImagePreparationError('encode'))
  })
})
