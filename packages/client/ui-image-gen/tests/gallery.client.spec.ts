import { afterEach, describe, expect, it, vi } from 'vitest'
import { GalleryController } from '../src/client/gallery.ts'

const item = { id: 'first', attachmentId: 'att', prompt: '云海', model: 'model', createdAt: 1,
  mediaType: 'image/png', width: 512, height: 512 }
const state = { enabled: true, available: true, model: 'model' }
const json = (value: unknown) => ({ ok: true, json: async () => value }) as Response

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('会话图库', () => {
  it('显隐时取消旧请求；可见期间定时刷新来自对话工具的新图', async () => {
    vi.useFakeTimers()
    let count = 0
    const requests: RequestInit[] = []
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      requests.push(init)
      if (url.includes('/state')) return json(state)
      if (url.includes('/gallery')) return json({ enabled: true, items: count++ ? [item] : [] })
      throw Error('unexpected URL')
    })
    vi.stubGlobal('fetch', fetch)
    const gallery = new GalleryController('one')
    gallery.show(true)
    await vi.waitFor(() => { expect(gallery.view.getSnapshot().phase).toBe('ready') })
    expect(gallery.view.getSnapshot().items).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(gallery.view.getSnapshot().items).toEqual([item])
    gallery.show(false)
    expect(requests.at(-1)?.signal?.aborted).toBe(true)
    const before = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(9_000)
    expect(fetch).toHaveBeenCalledTimes(before)
    gallery.dispose()
  })

  it('生成后重新读取并限制 image 查询在当前会话', async () => {
    let galleryItems = [item]
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/state')) return json(state)
      if (url.includes('/gallery')) return json({ enabled: true, items: galleryItems })
      if (url.includes('/edit')) {
        expect(JSON.parse(init.body as string)).toEqual({ sessionId: 'one', prompt: '云层', imageId: 'first' })
        galleryItems = [...galleryItems, { ...item, id: 'second' }]
        return json({ item: galleryItems[1] })
      }
      throw Error('unexpected URL')
    })
    vi.stubGlobal('fetch', fetch)
    const gallery = new GalleryController('one')
    gallery.show(true)
    await vi.waitFor(() => { expect(gallery.view.getSnapshot().phase).toBe('ready') })
    expect(gallery.url('first')).toContain('sessionId=one&id=first')
    expect(await gallery.generate(' 云层 ', 'first')).toBe(true)
    expect(gallery.view.getSnapshot().items).toHaveLength(2)
    gallery.dispose()
  })

  it('Host 不可用时保留目录而阻止生成', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/state')
      ? json({ enabled: false, available: false, model: '' }) : json({ enabled: false, items: [item] })))
    const gallery = new GalleryController('one')
    gallery.show(true)
    await vi.waitFor(() => { expect(gallery.view.getSnapshot().phase).toBe('ready') })
    expect(gallery.view.getSnapshot().items).toEqual([item])
    expect(await gallery.generate('云')).toBe(false)
    gallery.dispose()
  })
})
