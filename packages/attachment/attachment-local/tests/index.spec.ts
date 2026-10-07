import { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { prepareImageFile } from '../src/store.ts'
import LocalAttachmentStore, {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  DEFAULT_MAX_SOURCE_IMAGE_BYTES,
  DEFAULT_MAX_SOURCE_MESSAGE_IMAGE_BYTES,
  DEFAULT_MAX_SOURCE_IMAGE_PIXELS,
  DEFAULT_MAX_SOURCE_IMAGE_FRAMES,
} from '../src/index.ts'

describe('local attachment service', () => {
  it('resolves every omitted admission limit explicitly', () => {
    const service = new LocalAttachmentStore(new Context(), {})
    expect(DEFAULT_MAX_IMAGE_BYTES).toBe(3.5 * 1024 * 1024)
    expect(service.imageLimits).toEqual({
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      maxSourceImageBytes: DEFAULT_MAX_SOURCE_IMAGE_BYTES,
      maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxSourceMessageImageBytes: DEFAULT_MAX_SOURCE_MESSAGE_IMAGE_BYTES,
      maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
      maxSourceImagePixels: DEFAULT_MAX_SOURCE_IMAGE_PIXELS,
      maxSourceImageFrames: DEFAULT_MAX_SOURCE_IMAGE_FRAMES,
      maxImageDimension: DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    })
  })

  it('saves and reads through the service boundary', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-service-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      const data = Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ))
      const ref = await service.saveImage({ data, mediaType: 'image/png' })
      await expect(service.readImage(ref)).resolves.toEqual({ ref, data })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('validates without persisting: a rejected image leaves no storage root behind', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-validate-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      await expect(service.validateImage({ data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' }))
        .rejects.toThrow(/Unsupported or malformed image data/)
      const valid = Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ))
      const limited = new LocalAttachmentStore(new Context(), { dshHome, maxImageBytes: 1 })
      await expect(limited.validateImage({ data: valid, mediaType: 'image/png' }))
        .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
      await expect(service.validateImage({ data: valid, mediaType: 'image/png' })).resolves.toBeUndefined()
      expect(existsSync(service.root)).toBe(false)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('accepts two 2560px screenshots after batch normalization and deduplicates their stored bytes', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-screenshots-'))
    try {
      const data = new Uint8Array(await sharp({
        create: { width: 2560, height: 1440, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 1 } },
      }).png({ compressionLevel: 3 }).toBuffer())
      expect(data.byteLength).toBeLessThan(2 * 1024 * 1024)
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      const input = { data, mediaType: 'image/png' as const }
      const prepared = await prepareImageFile(input, service.imageLimits)
      expect(prepared.data.byteLength * 2).toBeLessThan(data.byteLength * 2)
      const limited = new LocalAttachmentStore(new Context(), {
        dshHome,
        maxMessageImageBytes: prepared.data.byteLength * 2,
      })
      await expect(limited.validateImage(input)).resolves.toBeUndefined()
      expect(existsSync(limited.root)).toBe(false)
      const refs = await limited.saveImages([input, input])
      expect(refs).toHaveLength(2)
      expect(refs[0]?.attachmentId).toBe(refs[1]?.attachmentId)
      expect(refs[0]).toMatchObject({ width: 2000, height: 1125, bytes: prepared.data.byteLength })
      const stored = await limited.readImage(refs[0]!)
      expect(stored.data).toEqual(prepared.data)

      const stricter = new LocalAttachmentStore(new Context(), { dshHome, maxImageDimension: 1, maxImageBytes: 1 })
      await expect(stricter.readImage(refs[0]!)).resolves.toEqual(stored)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('does not publish the first normalized image when a later batch member is invalid', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-batch-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      const data = await sharp({
        create: { width: 2560, height: 1440, channels: 4, background: '#abcdef' },
      }).png().toBuffer()
      await expect(service.saveImages([
        { data, mediaType: 'image/png' },
        { data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' },
      ])).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
      expect(existsSync(service.root)).toBe(false)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('reprocesses only large members under a stricter final aggregate budget', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-budget-'))
    try {
      const data = new Uint8Array(await sharp({
        create: { width: 2560, height: 1440, channels: 4, background: '#abcdef' },
      }).png({ compressionLevel: 3 }).toBuffer())
      const small = new Uint8Array(await sharp({
        create: { width: 1, height: 1, channels: 4, background: '#123456' },
      }).png().toBuffer())
      const baseline = new LocalAttachmentStore(new Context(), { dshHome })
      const standard = await prepareImageFile({ data, mediaType: 'image/png' }, baseline.imageLimits)
      const aggregate = Math.floor(standard.data.byteLength * 0.8) + small.byteLength
      const service = new LocalAttachmentStore(new Context(), { dshHome, maxMessageImageBytes: aggregate })
      const refs = await service.saveImages([
        { data: small, mediaType: 'image/png' },
        { data, mediaType: 'image/png' },
      ])
      expect(refs[0]?.bytes).toBe(small.byteLength)
      expect((await service.readImage(refs[0]!)).data).toEqual(small)
      expect(refs[0]!.bytes + refs[1]!.bytes).toBeLessThanOrEqual(aggregate)
      expect(refs[1]!.bytes).toBeLessThan(standard.data.byteLength)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('rejects an impossible final aggregate budget before publishing objects', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-impossible-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome, maxMessageImageBytes: 1 })
      const data = new Uint8Array(await sharp({
        create: { width: 1, height: 1, channels: 4, background: '#abcdef' },
      }).png().toBuffer())
      await expect(service.saveImages([
        { data, mediaType: 'image/png' },
        { data, mediaType: 'image/png' },
      ])).rejects.toMatchObject({ code: 'IMAGES_TOO_LARGE' })
      expect(existsSync(service.root)).toBe(false)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('accepts output larger than the source cap when compact JPEG bytes expand during resizing', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-compact-source-'))
    try {
      const data = new Uint8Array(await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#ff0000' },
      }).jpeg({ quality: 1 }).toBuffer())
      const service = new LocalAttachmentStore(new Context(), {
        dshHome,
        maxSourceImageBytes: data.byteLength,
        maxSourceMessageImageBytes: data.byteLength * 2,
        maxImageBytes: 1024,
        maxMessageImageBytes: 2048,
        maxImageDimension: 1,
      })
      const input = { data, mediaType: 'image/jpeg' as const }
      const single = await service.saveImage(input)
      expect(single.bytes).toBeGreaterThan(data.byteLength)
      expect(single.bytes).toBeLessThanOrEqual(service.imageLimits.maxImageBytes)
      expect(single).toMatchObject({ width: 1, height: 1 })
      const batch = await service.saveImages([input, input])
      expect(batch.map(ref => ref.attachmentId)).toEqual([single.attachmentId, single.attachmentId])
      expect(batch[0]?.bytes).toBe(single.bytes)
      await expect(service.readImage(single)).resolves.toMatchObject({ ref: single })
      await expect(service.saveImage({ ...input, data: Uint8Array.from([...data, 0]) }))
        .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })
})
