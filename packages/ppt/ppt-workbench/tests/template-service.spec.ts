import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REMOTE_WORKSPACE_MARKER } from 'coding-subprocess'
import SessionStore, { SessionId } from 'coding-session'
import { PPT_FORMAT, type PptDeck } from 'coding-ppt-model'
import PptProjects from '../src/index.ts'
import { buildPptx } from '../src/export/pptx.ts'
import { zip } from '../src/export/zip.ts'
import { createProjectFromDeck, loadProject } from '../src/store.ts'

const SESSION = 'template-service-session'
const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
const deck: PptDeck = {
  format: PPT_FORMAT, title: '源工程', size: '16:9', theme: 'ink',
  pages: [{ id: 'page', name: '封面', background: null, transition: 'none', elements: [
    { id: 'image', kind: 'image', x: 10, y: 10, w: 100, h: 100, fit: 'contain', source: 'media/logo.png' },
  ] }],
}

let root: string
let ctx: Context
let projects: PptProjects
let projectFiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ppt-template-service-'))
  ctx = new Context()
  await ctx.plugin(SessionStore)
  ctx.sessions.create(SessionId(SESSION), { meta: { cwd: root } })
  ctx.provide('webServer', { register: () => () => undefined } as never)
  ctx.provide('connection', { requestRejection: () => undefined } as never)
  projectFiber = await ctx.plugin(PptProjects, { templatesDir: join(root, 'templates') })
  projects = ctx.pptProjects
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('PPT 模板服务', () => {
  it('服务重建从本会话日志恢复当前工程，不猜测其他会话的焦点', async () => {
    const first = await projects.create(SESSION, { title: '第一稿' })
    const second = await projects.create(SESSION, { title: '第二稿' })
    const session = ctx.sessions.get(SessionId(SESSION))!
    const seed = session.events
    const other = ctx.sessions.create(SessionId('other-ppt'), { meta: { cwd: root } })
    expect((await projects.read(SESSION)).dir).toBe(second.dir)
    expect((await projects.state(SESSION)).active?.dir).toBe(second.dir)
    expect(projects.activeDir(other.id)).toBeUndefined()
    await expect(projects.check(other.id)).rejects.toThrow('还没有打开任何演示文稿')
    expect((await projects.read(other.id, first.dir.slice(root.length + 1))).dir).toBe(first.dir)
    expect(projects.activeDir(other.id)).toBeUndefined()
    expect((await projects.check(other.id, first.dir.slice(root.length + 1))).ok).toBe(true)
    await projects.open(other.id, first.dir.slice(root.length + 1))
    expect((await projects.read(other.id)).dir).toBe(first.dir)
    const replay = ctx.sessions.create(SessionId('replay-ppt'), { seed, meta: { cwd: root } })
    expect(projects.activeDir(replay.id)).toBeUndefined()
    await projectFiber.dispose()
    projectFiber = await ctx.plugin(PptProjects, { templatesDir: join(root, 'templates') })
    const restored = ctx.pptProjects
    expect(restored.activeDir(SESSION)).toBe(second.dir.slice(root.length + 1))
    expect(restored.activeDir(other.id)).toBe(first.dir.slice(root.length + 1))
    expect((await restored.state(SESSION)).active?.dir).toBe(second.dir)
    expect((await restored.state(SESSION)).openRequest).toBeNull()
    expect((await restored.check(SESSION)).ok).toBe(true)
    const replayed = new Context()
    try {
      await replayed.plugin(SessionStore)
      replayed.sessions.create(SessionId(SESSION), { seed, meta: { cwd: root } })
      replayed.provide('webServer', { register: () => () => undefined } as never)
      replayed.provide('connection', { requestRejection: () => undefined } as never)
      await replayed.plugin(PptProjects, { templatesDir: join(root, 'templates') })
      expect((await replayed.pptProjects.read(SESSION)).dir).toBe(second.dir)
      expect((await replayed.pptProjects.check(SESSION)).ok).toBe(true)
    } finally {
      await replayed.fiber.dispose()
    }
    const fork = ctx.sessions.create(SessionId('fork-ppt'), { seed: session.events, meta: { cwd: root } })
    expect(restored.activeDir(fork.id)).toBeUndefined()
    expect(() => restored.resolveDir(fork.id)).toThrow('还没有打开任何演示文稿')
    expect((await restored.read(replay.id, first.dir.slice(root.length + 1))).dir).toBe(first.dir)
  })

  it('默认新建六页泛化整稿，显式主题/尺寸保留单页，副本不共用元素', async () => {
    const first = await projects.create(SESSION, { title: '春季计划' })
    const second = await projects.create(SESSION, { title: '秋季计划' })
    const custom = await projects.create(SESSION, { title: '旧式空稿', size: '4:3', theme: 'ink' })
    expect(first.deck.pages).toHaveLength(6)
    expect(first.deck.theme).toBe('inference')
    expect(second.deck.pages[0]?.id).not.toBe(first.deck.pages[0]?.id)
    expect(custom.deck.pages).toHaveLength(1)
    expect(custom.deck.theme).toBe('ink')
    expect((await loadProject(first.dir)).deck).toEqual(first.deck)
  })

  it('导入 PPTX 后持久保存来源，管理模板不改当前工程', async () => {
    const current = await projects.create(SESSION, { title: '正在编辑' })
    const source: PptDeck = { ...deck, pages: [{ ...deck.pages[0]!, elements: [] }] }
    const template = await projects.importTemplate('Quarter.PPTX', buildPptx(source), { name: ' 季度模板 ' })
    expect(template).toMatchObject({ name: '季度模板', pages: 1, sourceName: 'Quarter.PPTX' })
    expect(Number.isSafeInteger(template.createdAt)).toBe(true)
    expect(template.dropped).toEqual(expect.any(Array))
    expect(projects.activeDir(SESSION)).toBe(current.dir.slice(root.length + 1))
    expect((await projects.read(SESSION)).dir).toBe(current.dir)

    const renamed = await projects.renameTemplate(template.id, '下半年模板')
    expect(renamed).toMatchObject({ id: template.id, name: '下半年模板', sourceName: 'Quarter.PPTX' })
    expect(renamed).not.toHaveProperty('deck')
    expect(await projects.listTemplates()).toEqual([renamed])
    expect((await projects.readTemplate(template.id)).deck).toEqual(template.deck)
    await projects.deleteTemplate(template.id)
    expect(await projects.listTemplates()).toEqual([])
    await expect(projects.readTemplate(template.id)).rejects.toMatchObject({ code: 'not-found' })
    expect((await projects.read(SESSION)).dir).toBe(current.dir)
  })

  it('源文件模板仅留可编辑设计，不保存正文或媒体字节', async () => {
    const input: PptDeck = { ...deck, pages: [{ ...deck.pages[0]!, elements: [
      { id: 'secret', kind: 'text', x: 90, y: 130, w: 800, h: 90,
        text: { content: '机密客户数据', size: 42, color: '#16181d', bold: true,
          align: 'left', valign: 'middle', font: 'Arial' } },
      ...deck.pages[0]!.elements,
    ] }] }
    const saved = await projects.importTemplate('private.pptx', buildPptx(input), { name: '通用设计' })
    const content = JSON.stringify(saved.deck)
    expect(saved.sourceName).toBe('private.pptx')
    expect(saved.deck.pages[0]?.elements.some(element => element.kind === 'image')).toBe(false)
    expect(content).not.toContain('机密客户数据')
    expect(content).not.toContain('logo.png')
    expect(saved.deck.pages[0]?.elements[0]).toMatchObject({ kind: 'text', text: { size: 42, color: '#16181d' } })
    const copied = await projects.createFromTemplate(SESSION, saved.id, { title: '新稿' })
    expect(copied.deck.pages[0]?.elements.some(element => element.kind === 'text'
      && element.text.content === '机密客户数据')).toBe(false)
  })

  it('保存当前工程和媒体快照，套用时复制媒体而不覆盖目标或原稿', async () => {
    const originalDir = join(root, 'ppt', 'source')
    await createProjectFromDeck(originalDir, deck)
    await mkdir(join(originalDir, 'media'), { recursive: true })
    await writeFile(join(originalDir, 'media', 'logo.png'), image)
    await projects.open(SESSION, 'ppt/source')
    const template = await projects.saveTemplate(SESSION, { name: '项目模板' })
    expect(template).toMatchObject({ name: '项目模板', sourceName: null, dropped: [] })
    expect((await projects.readTemplate(template.id)).deck).toEqual(deck)

    const target = await projects.createFromTemplate(SESSION, template.id, { title: '副本', dir: 'ppt/copy' })
    expect(target).toMatchObject({ dir: join(root, 'ppt', 'copy'), title: '副本', pages: 1 })
    expect(await readFile(join(target.dir, 'media', 'logo.png'))).toEqual(Buffer.from(image))
    expect((await loadProject(originalDir)).deck).toEqual(deck)
    expect((await projects.readTemplate(template.id)).deck).toEqual(deck)
    expect(projects.activeDir(SESSION)).toBe('ppt/copy')
    await expect(projects.createFromTemplate(SESSION, template.id, { dir: 'ppt/source' }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(projects.activeDir(SESSION)).toBe('ppt/copy')
    const outside = join(root, 'outside.png')
    await writeFile(outside, image)
    await rm(join(originalDir, 'media', 'logo.png'))
    await symlink(outside, join(originalDir, 'media', 'logo.png'))
    await expect(projects.saveTemplate(SESSION, { name: '不安全来源', dir: 'ppt/source' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await projects.deleteTemplate(template.id)
    expect(await readFile(join(target.dir, 'media', 'logo.png'))).toEqual(Buffer.from(image))
  })

  it('从本机工作区文件导入模板不切换工程，拒绝越界、符号链接和远端来源', async () => {
    const current = await projects.create(SESSION, { title: '正在编辑' })
    const source: PptDeck = { ...deck, pages: [{ ...deck.pages[0]!, elements: [] }] }
    const pptx = buildPptx(source)
    await writeFile(join(root, 'input.pptx'), pptx)
    const imported = await projects.importTemplateFromFile(SESSION, 'input.pptx', { name: ' 工作区模板 ' })
    expect(imported).toMatchObject({ name: '工作区模板', sourceName: 'input.pptx', pages: 1 })
    expect((await projects.read(SESSION)).dir).toBe(current.dir)
    expect(projects.activeDir(SESSION)).toBe(current.dir.slice(root.length + 1))

    await expect(projects.importTemplateFromFile(SESSION, '../outside.pptx'))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect(projects.importTemplateFromFile(SESSION, join(tmpdir(), 'outside.pptx')))
      .rejects.toMatchObject({ code: 'forbidden' })
    await symlink(join(root, 'input.pptx'), join(root, 'alias.pptx'))
    await expect(projects.importTemplateFromFile(SESSION, 'alias.pptx'))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect(projects.importTemplateFromFile(SESSION, 'input.pptm'))
      .rejects.toMatchObject({ code: 'bad-request' })
    await writeFile(join(root, 'oversized.pptx'), new Uint8Array(8 * 1024 * 1024 + 1))
    await expect(projects.importTemplateFromFile(SESSION, 'oversized.pptx'))
      .rejects.toMatchObject({ code: 'bad-request' })
    expect((await projects.listTemplates()).map(template => template.id)).toEqual([imported.id])

    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode: 'agent',
    }))
    await expect(projects.importTemplateFromFile(SESSION, 'input.pptx'))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect((await projects.listTemplates()).map(template => template.id)).toEqual([imported.id])
    expect((await projects.read(SESSION)).dir).toBe(current.dir)
  })

  it('只接受安全的来源与目标，不把模板写入远程 marker 工作区', async () => {
    const bytes = buildPptx({ ...deck, pages: [{ ...deck.pages[0]!, elements: [] }] })
    for (const fileName of ['source.pptm', '../source.pptx', 'source.potx']) {
      await expect(projects.importTemplate(fileName, bytes)).rejects.toMatchObject({ code: 'bad-request' })
    }
    await expect(projects.importTemplate('empty.pptx', new Uint8Array())).rejects.toMatchObject({ code: 'bad-request' })
    await expect(projects.importTemplate('macro.pptx', zip([
      { path: 'ppt/vbaProject.bin', data: new Uint8Array() },
    ]))).rejects.toThrow(/宏/u)
    await expect(projects.importTemplate('huge.pptx', new Uint8Array(8 * 1024 * 1024 + 1)))
      .rejects.toMatchObject({ code: 'bad-request' })
    const template = await projects.importTemplate('safe.pptx', bytes)
    await expect(projects.createFromTemplate(SESSION, template.id, { dir: '../outside' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    const outside = join(root, 'outside')
    await symlink(outside, join(root, 'templates', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'dir')
    await expect(projects.readTemplate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
      .rejects.toMatchObject({ code: 'forbidden' })
    await rm(join(root, 'templates', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))

    await projects.create(SESSION, { title: '本机源工程' })

    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode: 'agent',
    }))
    await expect(projects.saveTemplate(SESSION, { name: '远端' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect(projects.createFromTemplate(SESSION, template.id, { title: '远端副本' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect(await projects.listTemplates()).toEqual([expect.objectContaining({ id: template.id })])
  })
})
