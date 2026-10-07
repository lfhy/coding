import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment/types'

const PNG = 'AAAA' // canonical base64, 3 bytes

/** Delegation double: records the exact saveImages batch and answers ordered refs. */
function storeOf(limits: Partial<ImageAttachmentLimits> = {}) {
  const store = {
    imageLimits: {
      maxImageBytes: 3,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 6,
      maxImagePixels: 10,
      maxImageDimension: 10,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      ...limits,
    },
    saveImages: vi.fn((inputs: readonly SaveImageAttachment[]) => Promise.resolve(inputs.map((input, index): ImageAttachmentRef => ({
      attachmentId: `att-${index + 1}` as ImageAttachmentRef['attachmentId'],
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    })))),
  }
  return { store: store as unknown as AttachmentStore, mocks: store }
}

describe('admitEncodedImages', () => {
  it('decodes every member and delegates one ordered batch to saveImages', async () => {
    const { store, mocks } = storeOf()
    const refs = await admitEncodedImages(store, [
      { mediaType: 'image/png', data: PNG, name: 'first.png' },
      { mediaType: 'image/jpeg', data: PNG, name: 'second.jpg' },
    ])
    expect(mocks.saveImages).toHaveBeenCalledTimes(1)
    const batch = mocks.saveImages.mock.calls[0]?.[0] as readonly SaveImageAttachment[]
    expect(batch.map(input => [input.name, input.mediaType, input.data.byteLength]))
      .toEqual([['first.png', 'image/png', 3], ['second.jpg', 'image/jpeg', 3]])
    expect(refs.map(ref => ref.attachmentId)).toEqual(['att-1', 'att-2'])
  })

  it('omits the name from store inputs when the upload has none', async () => {
    const { store, mocks } = storeOf()
    const refs = await admitEncodedImages(store, [{ mediaType: 'image/webp', data: PNG }])
    const batch = mocks.saveImages.mock.calls[0]?.[0] as readonly SaveImageAttachment[]
    expect('name' in (batch[0] as object)).toBe(false)
    expect(refs[0]?.name).toBeUndefined()
  })

  it('delegates an empty batch unchanged', async () => {
    const { store, mocks } = storeOf()
    await expect(admitEncodedImages(store, [])).resolves.toEqual([])
    expect(mocks.saveImages).toHaveBeenCalledWith([])
  })

  it('rejects non-canonical and empty base64 payloads before any store call', async () => {
    const { store, mocks } = storeOf({ maxSourceImageBytes: 8, maxSourceMessageImageBytes: 8 })
    for (const data of ['', 'AAA', '!!!!', 'AB==', 'AAB=', 'AQ=/', 'AA=A', 'AAAA=AAA', 'AQ==\n']) {
      await expect(admitEncodedImages(store, [{ mediaType: 'image/png', data }]))
        .rejects.toMatchObject({ name: 'AttachmentError', code: 'INVALID_IMAGE_BASE64' })
    }
    expect(mocks.saveImages).not.toHaveBeenCalled()
  })

  it('admits an eight-megabyte canonical string without a regex stack overflow', async () => {
    const { store, mocks } = storeOf({
      maxSourceImageBytes: 8 * 1024 * 1024,
      maxSourceMessageImageBytes: 8 * 1024 * 1024,
    })
    const data = 'A'.repeat(8 * 1024 * 1024)
    const refs = await admitEncodedImages(store, [{ mediaType: 'image/png', data }])
    expect(refs[0]?.bytes).toBe(6 * 1024 * 1024)
    expect(mocks.saveImages).toHaveBeenCalledOnce()
  })

  it('identifies the invalid member without decoding an otherwise valid batch', async () => {
    const { store, mocks } = storeOf()
    await expect(admitEncodedImages(store, [
      { mediaType: 'image/png', data: PNG },
      { mediaType: 'image/png', data: 'AB==' },
    ])).rejects.toMatchObject({ code: 'INVALID_IMAGE_BASE64', imageIndex: 1 })
    expect(mocks.saveImages).not.toHaveBeenCalled()
  })

  it('bounds count, each source, and the raw aggregate before allocating decoded bytes', async () => {
    const { store, mocks } = storeOf({
      maxSourceImageBytes: 6,
      maxSourceMessageImageBytes: 7,
    })
    const decode = vi.spyOn(Buffer, 'from')
    try {
      await expect(admitEncodedImages(store, Array(3).fill({ mediaType: 'image/png', data: PNG })))
        .rejects.toMatchObject({ code: 'TOO_MANY_IMAGES' })
      await expect(admitEncodedImages(store, [{ mediaType: 'image/png', data: 'AAAAAAAAAAAA' }]))
        .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
      await expect(admitEncodedImages(store, [{ mediaType: 'image/png', data: 'A'.repeat(8 * 1024 * 1024) }]))
        .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
      await expect(admitEncodedImages(store, [
        { mediaType: 'image/png', data: 'AAAAAAAA' },
        { mediaType: 'image/png', data: 'AAAAAAAA' },
      ])).rejects.toMatchObject({ code: 'IMAGES_TOO_LARGE' })
      expect(decode).not.toHaveBeenCalled()
      expect(mocks.saveImages).not.toHaveBeenCalled()
    } finally {
      decode.mockRestore()
    }
  })

  it('falls back to final-byte limits when a store does not specify source limits', async () => {
    const { store, mocks } = storeOf()
    await expect(admitEncodedImages(store, [{ mediaType: 'image/png', data: PNG }]))
      .resolves.toHaveLength(1)
    await expect(admitEncodedImages(store, [{ mediaType: 'image/png', data: 'AAAAAAAA' }]))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    expect(mocks.saveImages).toHaveBeenCalledTimes(1)
  })

  it('propagates the store batch rejection unchanged', async () => {
    const { store, mocks } = storeOf()
    const refused = Object.assign(new Error('Image batch exceeds the configured image-count limit.'), { code: 'TOO_MANY_IMAGES' })
    mocks.saveImages.mockRejectedValueOnce(refused)
    await expect(admitEncodedImages(store, [{ mediaType: 'image/png', data: PNG }])).rejects.toBe(refused)
  })
})
