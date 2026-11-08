import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REMOTE_WORKSPACE_MARKER } from 'coding-subprocess'
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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ppt-template-service-'))
  ctx = new Context()
  ctx.provide('sessions', { get: (id: string) => id === SESSION ? { header: { cwd: root } } : undefined } as never)
  ctx.provide('webServer', { register: () => () => undefined } as never)
  ctx.provide('connection', { requestRejection: () => undefined } as never)
  await ctx.plugin(PptProjects, { templatesDir: join(root, 'templates') })
  projects = ctx.pptProjects
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('PPT 模板服务', () => {
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
