import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PPT_FORMAT, type PptDeck } from 'coding-ppt-model'
import { PptTemplateStore } from '../src/template-store.ts'

let base: string
let root: string
let store: PptTemplateStore

const deck: PptDeck = {
  format: PPT_FORMAT, title: '季度报告', size: '16:9', theme: 'ink',
  pages: [{ id: 'page', name: '封面', background: null, transition: 'none', elements: [] }],
}
const execFileAsync = promisify(execFile)

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ppt-template-'))
  root = join(base, 'templates')
  store = new PptTemplateStore(root)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('用户模板仓库', () => {
  it('创建、重启读取、重命名、删除后列表持久一致', async () => {
    expect(await store.list()).toEqual([])
    const created = await store.create({ name: ' 季度模板 ', deck, media: [], sourceName: '原稿.pptx', dropped: ['动画'] })
    expect(created.id).toMatch(/^[0-9a-f]{8}-/u)
    expect(created).toMatchObject({ name: '季度模板', pages: 1, sourceName: '原稿.pptx', dropped: ['动画'] })
    store = new PptTemplateStore(root)
    expect(await store.read(created.id)).toEqual(created)
    expect(await store.list()).toEqual([{ id: created.id, name: '季度模板', pages: 1,
      createdAt: created.createdAt, sourceName: '原稿.pptx', dropped: ['动画'] }])
    const renamed = await store.rename(created.id, '新模板')
    expect(renamed.name).toBe('新模板')
    expect((await store.read(created.id)).deck).toEqual(deck)
    await expect(store.delete(created.id, '季度模板')).rejects.toMatchObject({ code: 'conflict' })
    expect((await store.read(created.id)).name).toBe('新模板')
    await store.delete(created.id, '新模板')
    expect(await store.list()).toEqual([])
    await expect(store.read(created.id)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('图片原始字节保持不变，且只允许被页面引用的媒体', async () => {
    const bytes = Uint8Array.from([0, 255, 6, 17, 128])
    const withImage: PptDeck = { ...deck, pages: [{ ...deck.pages[0]!, elements: [{
      id: 'img', kind: 'image', x: 0, y: 0, w: 100, h: 100, fit: 'contain', source: 'media/image.png',
    }] }] }
    const created = await store.create({ name: '含图', deck: withImage, media: [{ part: 'media/image.png', bytes }] })
    expect(await store.readMedia(created.id, 'media/image.png')).toEqual(bytes)
    expect(await store.readWithMedia(created.id)).toEqual({ detail: created,
      media: [{ part: 'media/image.png', bytes }] })
    expect(await readFile(join(root, created.id, 'media', 'image.png'))).toEqual(Buffer.from(bytes))
    await expect(store.readMedia(created.id, 'media/other.png')).rejects.toMatchObject({ code: 'not-found' })
    await expect(store.readMedia(created.id, 'media/../image.png')).rejects.toMatchObject({ code: 'bad-request' })
    await expect(store.create({ name: '遗漏', deck: withImage, media: [] })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(store.create({ name: '多余', deck, media: [{ part: 'media/image.png', bytes }] }))
      .rejects.toMatchObject({ code: 'bad-request' })
  })

  it('非法名称、格式和路径不产生半成品目录', async () => {
    await expect(store.create({ name: '  ', deck, media: [] })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(store.create({ name: '好', deck: { ...deck, title: '' }, media: [] }))
      .rejects.toMatchObject({ code: 'bad-request' })
    await expect(store.create({ name: '好', deck, media: [], dropped: [''] }))
      .rejects.toMatchObject({ code: 'bad-request' })
    expect(await store.list()).toEqual([])
    await expect(store.read('../outside')).rejects.toMatchObject({ code: 'bad-request' })
    await expect(store.delete('../outside')).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('并发读写串行、重命名文件原子替换', async () => {
    const { id } = await store.create({ name: '旧', deck, media: [] })
    const [changed, read] = await Promise.all([store.rename(id, '新'), store.read(id)])
    expect(changed.name).toBe('新')
    expect(read.name).toBe('新')
    expect((await readdir(join(root, id))).sort()).toEqual(['template.json'])
    const persisted = JSON.parse(await readFile(join(root, id, 'template.json'), 'utf8')) as {
      metadata: { name: string }
    }
    expect(persisted.metadata.name).toBe('新')
  })

  it('拒绝删除含未知文件、目录或残留临时文件的模板并保留其字节', async () => {
    const { id } = await store.create({ name: '已知', deck, media: [] })
    const path = join(root, id)
    const extra = join(path, 'important.txt')
    const bytes = Uint8Array.from([0, 255, 42])
    await writeFile(extra, bytes)
    await expect(store.delete(id)).rejects.toMatchObject({ code: 'bad-request' })
    await expect(store.read(id)).rejects.toThrow(/important\.txt/u)
    expect(await readFile(extra)).toEqual(Buffer.from(bytes))
    await rm(extra)

    const extraDir = join(path, 'other')
    await mkdir(extraDir)
    await writeFile(join(extraDir, 'data.bin'), bytes)
    await expect(store.delete(id)).rejects.toMatchObject({ code: 'bad-request' })
    expect(await readFile(join(extraDir, 'data.bin'))).toEqual(Buffer.from(bytes))
    await rm(extraDir, { recursive: true })

    const orphan = join(path, '.template-interrupted.tmp')
    await writeFile(orphan, bytes)
    await expect(store.list()).rejects.toThrow(/\.template-interrupted\.tmp/u)
    await expect(store.delete(id)).rejects.toMatchObject({ code: 'bad-request' })
    expect(await readFile(orphan)).toEqual(Buffer.from(bytes))
    await rm(orphan)
    const [renamed, read] = await Promise.all([store.rename(id, '新名'), store.read(id)])
    expect(renamed.name).toBe('新名')
    expect(read.name).toBe('新名')
  })

  it('临近 JSON 大小上限时拒绝重命名并保留原模板', async () => {
    const maxJsonBytes = 8 * 1024 * 1024
    const count = 1700
    const largeDeck = (length: number): PptDeck => ({ ...deck, pages: Array.from({ length: 9 }, (_, pageIndex) => ({
      ...deck.pages[0]!, id: `page-${pageIndex}`,
      elements: Array.from({ length: pageIndex === 8 ? 100 : 200 }, (_, elementIndex) => ({
        id: `text-${pageIndex}-${elementIndex}`, kind: 'text' as const,
        x: 0, y: 0, w: 100, h: 100,
        text: { content: 'x'.repeat(length), size: 20, color: '#ffffff', bold: false,
          align: 'left' as const, valign: 'top' as const, font: '' },
      })),
    })) })
    const sizeOf = (value: PptDeck): number => Buffer.byteLength(`${JSON.stringify({
      version: 1,
      metadata: { id: '00000000-0000-4000-8000-000000000000', name: 'a', pages: 9,
        createdAt: 1700000000000, sourceName: null, dropped: [] },
      deck: value,
    }, null, 2)}\n`)
    const target = maxJsonBytes - 100
    const initial = largeDeck(4500)
    const length = 4500 + Math.floor((target - sizeOf(initial)) / count)
    const candidate = largeDeck(length)
    let remaining = target - sizeOf(candidate)
    const firstPage = candidate.pages[0]!
    const adjusted: PptDeck = { ...candidate, pages: [{ ...firstPage, elements: firstPage.elements.map((element) => {
      if (element.kind !== 'text' || remaining === 0) return element
      const delta = Math.sign(remaining) * Math.min(Math.abs(remaining),
        remaining > 0 ? 5000 - element.text.content.length : element.text.content.length - 1)
      remaining -= delta
      return { ...element, text: { ...element.text, content: 'x'.repeat(length + delta) } }
    }) }, ...candidate.pages.slice(1)] }
    expect(remaining).toBe(0)
    expect(sizeOf(adjusted)).toBe(target)
    const { id } = await store.create({ name: 'a', deck: adjusted, media: [] })
    const path = join(root, id, 'template.json')
    const before = await readFile(path)
    expect(before.byteLength).toBe(target)
    await expect(store.rename(id, 'b'.repeat(200))).rejects.toMatchObject({ code: 'bad-request' })
    expect(await readFile(path)).toEqual(before)
    expect((await store.read(id)).name).toBe('a')
    expect((await store.list())[0]?.name).toBe('a')
    expect(await readdir(join(root, id))).toEqual(['template.json'])
  }, 30_000)

  it('两个 Host 进程同时触及数量上限时至多发布第 100 个模板', async () => {
    for (let index = 0; index < 99; index += 1) {
      await store.create({ name: `模板${index}`, deck, media: [] })
    }
    const childCode = `
      import { writeFile, access } from 'node:fs/promises'
      import { join } from 'node:path'
      import { PptTemplateStore } from './packages/ppt/ppt-workbench/src/template-store.ts'
      const root = process.argv[1]
      await writeFile(join(root, '.ready-' + process.pid), '')
      while (!await access(join(root, '.go')).then(() => true, () => false)) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      try {
        await new PptTemplateStore(root).create({ name: '并发', deck: ${JSON.stringify(deck)}, media: [] })
        process.stdout.write('created')
      } catch (error) {
        if (error.code !== 'conflict') throw error
        process.stdout.write('conflict')
      }
    `
    const create = () => execFileAsync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', childCode, root,
    ], { cwd: process.cwd() }).then(({ stdout }) => stdout)
    const processes = [create(), create()]
    let ready = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      ready = (await readdir(root)).filter(name => name.startsWith('.ready-')).length === 2
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await writeFile(join(root, '.go'), '')
    expect(ready).toBe(true)
    expect((await Promise.all(processes)).sort()).toEqual(['conflict', 'created'])
    expect(await store.list()).toHaveLength(100)
  }, 20_000)

  it('坏模板报告 id，非模板文件不影响列表', async () => {
    const { id } = await store.create({ name: '好', deck, media: [] })
    await writeFile(join(root, 'other.txt'), '无关')
    expect(await store.list()).toHaveLength(1)
    await writeFile(join(root, id, 'template.json'), '{bad')
    await expect(store.list()).rejects.toThrow(id)
    await expect(store.read(id)).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('拒绝模板目录、媒体与根目录符号链接', async () => {
    const { id } = await store.create({ name: '好', deck, media: [] })
    const alias = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await symlink(join(root, id), join(root, alias), 'dir')
    await expect(store.read(alias)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(store.list()).rejects.toMatchObject({ code: 'forbidden' })
    await rm(join(root, alias))
    const mediaDeck: PptDeck = { ...deck, pages: [{ ...deck.pages[0]!, elements: [{
      id: 'img', kind: 'image', x: 0, y: 0, w: 100, h: 100, fit: 'cover', source: 'media/a.png',
    }] }] }
    const image = await store.create({ name: '图', deck: mediaDeck,
      media: [{ part: 'media/a.png', bytes: Uint8Array.from([1]) }] })
    await rm(join(root, image.id, 'media', 'a.png'))
    await symlink(join(root, id, 'template.json'), join(root, image.id, 'media', 'a.png'))
    await expect(store.readMedia(image.id, 'media/a.png')).rejects.toMatchObject({ code: 'forbidden' })
    await rm(root, { recursive: true })
    await symlink(base, root, 'dir')
    await expect(store.list()).rejects.toMatchObject({ code: 'forbidden' })
    expect((await lstat(root)).isSymbolicLink()).toBe(true)
  })

  it('磁盘元数据篡改和无关媒体不能被接受', async () => {
    const { id } = await store.create({ name: '原名', deck, media: [] })
    const file = join(root, id, 'template.json')
    const value = JSON.parse(await readFile(file, 'utf8')) as { metadata: { pages: number } }
    value.metadata.pages = 42
    await writeFile(file, JSON.stringify(value))
    await expect(store.read(id)).rejects.toMatchObject({ code: 'bad-request' })
    value.metadata.pages = 1
    await writeFile(file, JSON.stringify(value))
    await symlink(file, join(root, id, 'media'), 'dir')
    await expect(store.read(id)).rejects.toMatchObject({ code: 'forbidden' })
  })
})
