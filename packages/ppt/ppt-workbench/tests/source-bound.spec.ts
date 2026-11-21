import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from 'coding-session'
import { PPT_FORMAT, type PptDeck } from 'coding-ppt-model'
import { REMOTE_WORKSPACE_MARKER } from 'coding-subprocess'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPptx } from '../src/export/pptx.ts'
import { zip, type ZipEntry } from '../src/export/zip.ts'
import { importPptx } from '../src/import.ts'
import PptProjects from '../src/index.ts'

const SESSION = 'linked-source-session'
const deck: PptDeck = {
  format: PPT_FORMAT, title: '原稿', size: '16:9', theme: 'ink',
  pages: [{ id: 'first', name: '第一页', background: null, transition: 'none', elements: [
    { id: 'heading', kind: 'text', x: 40, y: 40, w: 700, h: 120,
      text: { content: '原始标题', size: 50, color: '#112233', bold: false,
        align: 'left', valign: 'middle', font: '' } },
  ] }],
}
const encode = (value: string) => new TextEncoder().encode(value)

let root: string
let ctx: Context
let service: PptProjects

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ppt-source-bound-'))
  ctx = new Context()
  await ctx.plugin(SessionStore)
  ctx.sessions.create(SessionId(SESSION), { meta: { cwd: root } })
  ctx.provide('fileLibrary', {
    notesRootPath: () => root,
    createNoteDeck: async (name: string, directory: string) => {
      const stem = name.toLowerCase().endsWith('.codingppt') ? name.slice(0, -'.codingppt'.length) : name
      const fileName = `${stem}.codingppt`
      const notesRoot = resolve(root)
      const target = resolve(notesRoot, directory, fileName)
      if (target !== notesRoot && !target.startsWith(`${notesRoot}/`)) throw new TypeError('笔记路径无效')
      await mkdir(dirname(target), { recursive: true })
      try { await mkdir(target, { mode: 0o700 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TypeError('幻灯片已存在'); throw error }
      return {
        path: directory === '' ? fileName : `${directory}/${fileName}`,
        remove: async () => { await rm(target, { recursive: true, force: true }) },
      }
    },
    deleteNote: async (path: string) => { await rm(resolve(root, path), { force: true }) },
  } as never)
  ctx.provide('webServer', { register: () => () => undefined } as never)
  ctx.provide('connection', { requestRejection: () => undefined } as never)
  await ctx.plugin(PptProjects)
  service = ctx.pptProjects
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

/** 断言原件保持可打开，且标题确由工作台已落盘的那份工程生成。 */
async function sourceText(path: string): Promise<string> {
  const parsed = importPptx(await readFile(path), { title: '回读' })
  const first = parsed.deck.pages[0]?.elements[0]
  return first?.kind === 'text' ? first.text.content : ''
}

describe('源 PPTX 原位编辑', () => {
  it('源文件、服务编辑及撤销重做保持同源，重挂后从持久关联恢复', async () => {
    const source = join(root, 'talk.pptx')
    await writeFile(source, buildPptx(deck))
    const opened = await service.openSource(SESSION, 'talk.pptx')
    expect(opened).toMatchObject({ revision: 1, title: 'talk' })
    expect(await service.state(SESSION)).toMatchObject({ active: { dir: opened.dir, revision: 1 } })
    expect(await readFile(join(opened.dir, 'source.json'), 'utf8')).toContain(source)
    const changed = await service.edit(SESSION, undefined, [
      { op: 'update_element', page: opened.deck.pages[0]?.id, element: opened.deck.pages[0]?.elements[0]?.id,
        text: { content: '立即写回' } },
    ], 1)
    expect(changed.revision).toBe(2)
    expect(await sourceText(source)).toBe('立即写回')
    expect((await service.undo(SESSION, undefined, 1)).revision).toBe(1)
    expect(await sourceText(source)).toBe('原始标题')
    expect((await service.redo(SESSION, undefined, 1)).revision).toBe(2)
    expect(await sourceText(source)).toBe('立即写回')
    expect((await service.read(SESSION)).revision).toBe(2)
    expect((await service.open(SESSION, opened.dir)).revision).toBe(2)
  })

  it('源在外部变化时轮询、编辑和撤销一律冲突，工程版本与源文件不受覆盖', async () => {
    const source = join(root, 'talk.pptx')
    await writeFile(source, buildPptx(deck))
    const opened = await service.openSource(SESSION, 'talk.pptx')
    const heading = deck.pages[0]?.elements[0]
    if (heading?.kind !== 'text') throw new Error('测试源缺少标题')
    const externallyChanged = buildPptx({ ...deck, pages: [
      { ...deck.pages[0]!, elements: [{ ...heading,
        text: { ...heading.text, content: '外部版本' } }] },
    ] })
    await writeFile(source, externallyChanged)
    await expect(service.state(SESSION)).rejects.toMatchObject({ code: 'conflict' })
    await expect(service.edit(SESSION, undefined, [{ op: 'add_page' }], 1))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(service.undo(SESSION, undefined, 1)).rejects.toMatchObject({ code: 'conflict' })
    expect((await readFile(source)).equals(Buffer.from(externallyChanged))).toBe(true)
    const saved = JSON.parse(await readFile(join(opened.dir, 'deck.json'), 'utf8')) as { revision: number }
    expect(saved.revision).toBe(1)
  })

  it('缺失图片或原件回写不可写时不更新工程历史', async () => {
    const source = join(root, 'talk.pptx')
    await writeFile(source, buildPptx(deck))
    const opened = await service.openSource(SESSION, 'talk.pptx')
    await expect(service.edit(SESSION, undefined, [{ op: 'add_element', page: opened.deck.pages[0]?.id,
      element: { kind: 'image', x: 5, y: 5, w: 60, h: 60, source: 'media/missing.png', fit: 'contain' } }], 1))
      .rejects.toMatchObject({ code: 'not-found' })
    expect((await service.read(SESSION)).revision).toBe(1)
    expect(await sourceText(source)).toBe('原始标题')
    expect((await readdir(opened.dir)).some(file => file.startsWith('.source-transaction'))).toBe(false)
  })

  it('拒绝目录外、绝对路径、符号链接与远程工作区，失败不换焦点', async () => {
    const source = join(root, 'talk.pptx')
    await writeFile(source, buildPptx(deck))
    await symlink(source, join(root, 'link.pptx'))
    await mkdir(join(root, 'nested'))
    await symlink(root, join(root, 'nested', 'linked'))
    for (const [path, code] of ([
      ['../escape.pptx', 'bad-request'], [source, 'bad-request'], ['link.pptx', 'forbidden'],
      ['nested/linked/talk.pptx', 'forbidden'],
    ] as const)) await expect(service.openSource(SESSION, path)).rejects.toMatchObject({ code })
    expect(service.activeDir(SESSION)).toBeUndefined()
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode: 'agent',
    }))
    await expect(service.openSource(SESSION, 'talk.pptx')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('已知图表导入损失不允许原位覆写，但允许保留原件的普通导入', async () => {
    const chart: ZipEntry[] = [
      { path: 'ppt/presentation.xml', data: encode('<p:presentation><p:sldIdLst><p:sldId r:id="rSlide"/></p:sldIdLst></p:presentation>') },
      { path: 'ppt/_rels/presentation.xml.rels', data: encode('<Relationships><Relationship Id="rSlide" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>') },
      { path: 'ppt/slides/slide1.xml', data: encode('<p:sld><p:cSld><p:spTree><p:graphicFrame><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rChart"/></a:graphicData></p:graphicFrame></p:spTree></p:cSld></p:sld>') },
    ]
    const bytes = zip(chart)
    await writeFile(join(root, 'chart.pptx'), bytes)
    await expect(service.openSource(SESSION, 'chart.pptx')).rejects.toThrow('不能原位编辑')
    expect(await readFile(join(root, 'chart.pptx'))).toEqual(Buffer.from(bytes))
    expect(service.activeDir(SESSION)).toBeUndefined()
    expect(await readdir(root)).not.toContain('ppt')
  })
})

describe('笔记幻灯片工程目录', () => {
  it('在笔记目录生成可解析的整稿工程并设为当前工程', async () => {
    const created = await service.createNoteDeck(SESSION, { name: '会议汇报' })
    expect(created).toEqual({ dir: '会议汇报.codingppt' })
    const snapshot = await service.read(SESSION, created.dir)
    expect(snapshot.deck.pages.length).toBeGreaterThan(0)
    expect(snapshot.deck.title).toBe('会议汇报')
    expect(service.activeDir(SESSION)).toBe('会议汇报.codingppt')
    expect(await readdir(join(root, '会议汇报.codingppt'))).toContain('deck.json')
    // 工程直接落在笔记目录，不再生成单文件幻灯片或额外的 ppt/ 工作区目录。
    expect(await readdir(root)).toEqual(['会议汇报.codingppt'])
  })

  it('导入 pptx 生成同名工程目录，媒体随页面引用一起落盘', async () => {
    const bytes = buildPptx(deck)
    const imported = await service.importNoteDeck(SESSION, { name: '外部稿', data: new Uint8Array(bytes) })
    expect(imported).toEqual({ dir: '外部稿.codingppt' })
    const snapshot = await service.read(SESSION, imported.dir)
    expect(snapshot.deck.pages).toHaveLength(1)
    expect(snapshot.deck.pages[0]?.elements).toHaveLength(1)
    await expect(service.importNoteDeck(SESSION, { name: '外部稿', data: new Uint8Array(bytes) }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(service.importNoteDeck(SESSION, { name: '空稿', data: new Uint8Array() }))
      .rejects.toMatchObject({ code: 'bad-request' })
  })

  it('限制笔记会话、重复名和越界目录，失败不留下半成品目录', async () => {
    await service.createNoteDeck(SESSION, { name: '重复稿' })
    await expect(service.createNoteDeck(SESSION, { name: '重复稿' })).rejects.toMatchObject({ code: 'conflict' })
    expect(await readdir(root)).toEqual(['重复稿.codingppt'])

    const other = 'other-session'
    ctx.sessions.create(SessionId(other), { meta: { cwd: join(root, 'other') } })
    await expect(service.createNoteDeck(other, { name: '越界' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(service.createNoteDeck(SESSION, { name: '越界', directory: '../outside' }))
      .rejects.toMatchObject({ code: 'bad-request' })
    expect(await readdir(root)).toEqual(['重复稿.codingppt'])
  })
})
