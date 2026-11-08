import { mkdtemp, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PPT_FORMAT, type PptDeck } from 'coding-ppt-model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PptTemplateStore } from '../src/template-store.ts'

const openedMedia = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => {
    if (String(args[0]).includes('/media/')) openedMedia.push(String(args[0]))
    return actual.open(...args)
  } }
})

let base: string
let root: string
let store: PptTemplateStore
const first = Uint8Array.from([1, 2, 3])
const second = Uint8Array.from([4, 5, 6])
const deck: PptDeck = {
  format: PPT_FORMAT, title: '媒体按需读取', size: '16:9', theme: 'ink',
  pages: [{ id: 'cover', name: '封面', background: null, transition: 'none', elements: [
    { id: 'first', kind: 'image', x: 0, y: 0, w: 100, h: 100, fit: 'contain', source: 'media/first.png' },
    { id: 'second', kind: 'image', x: 100, y: 0, w: 100, h: 100, fit: 'contain', source: 'media/second.png' },
  ] }],
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ppt-template-media-'))
  root = join(base, 'templates')
  store = new PptTemplateStore(root)
  openedMedia.length = 0
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function fixture(): Promise<string> {
  const template = await store.create({ name: '两张图', deck, media: [
    { part: 'media/first.png', bytes: first }, { part: 'media/second.png', bytes: second },
  ] })
  return template.id
}

describe('模板媒体按需读取与完整结构校验', () => {
  it('单图请求只打开目标图片，完整快照仍加载所有媒体', async () => {
    const id = await fixture()
    const mediaDir = join(root, id, 'media')
    openedMedia.length = 0
    expect(await store.readMedia(id, 'media/first.png')).toEqual(first)
    expect(openedMedia).toEqual([join(mediaDir, 'first.png')])
    openedMedia.length = 0
    expect(await store.read(id)).toMatchObject({ id, deck })
    expect(await store.list()).toHaveLength(1)
    expect(openedMedia).toEqual([])
    expect((await store.readWithMedia(id)).media).toEqual([
      { part: 'media/first.png', bytes: first }, { part: 'media/second.png', bytes: second },
    ])
    expect(openedMedia).toEqual([join(mediaDir, 'first.png'), join(mediaDir, 'second.png')])
  })

  it('未引用路径、未知条目、符号链接和总大小超限仍失败关闭', async () => {
    const id = await fixture()
    const mediaDir = join(root, id, 'media')
    await expect(store.readMedia('../outside', 'media/first.png')).rejects.toMatchObject({ code: 'bad-request' })
    await expect(store.readMedia(id, 'media/../first.png')).rejects.toMatchObject({ code: 'bad-request' })
    await expect(store.readMedia(id, 'media/missing.png')).rejects.toMatchObject({ code: 'not-found' })
    await writeFile(join(mediaDir, 'unreferenced.png'), first)
    await expect(store.readMedia(id, 'media/first.png')).rejects.toMatchObject({ code: 'bad-request' })
    await expect(store.delete(id)).rejects.toMatchObject({ code: 'bad-request' })
    await rm(join(mediaDir, 'unreferenced.png'))
    await rm(join(mediaDir, 'second.png'))
    await symlink(join(mediaDir, 'first.png'), join(mediaDir, 'second.png'))
    await expect(store.readMedia(id, 'media/first.png')).rejects.toMatchObject({ code: 'forbidden' })
    await rm(join(mediaDir, 'second.png'))
    await writeFile(join(mediaDir, 'second.png'), second)
    await truncate(join(mediaDir, 'first.png'), 60 * 1024 * 1024)
    await truncate(join(mediaDir, 'second.png'), 60 * 1024 * 1024)
    openedMedia.length = 0
    await expect(store.readMedia(id, 'media/first.png')).rejects.toMatchObject({ code: 'bad-request' })
    expect(openedMedia).toEqual([])
    expect((await readdir(join(root, id))).sort()).toEqual(['media', 'template.json'])
  })
})
