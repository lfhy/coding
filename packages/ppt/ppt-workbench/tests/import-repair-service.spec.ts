import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from 'coding-session'
import { PPT_FORMAT, type PptDeck } from 'coding-ppt-model'
import { REMOTE_WORKSPACE_MARKER } from 'coding-subprocess'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPptx } from '../src/export/pptx.ts'
import PptProjects from '../src/index.ts'

const SESSION = 'import-repair-session'
const deck: PptDeck = {
  format: PPT_FORMAT, title: '源演示', size: '16:9', theme: 'ink',
  pages: [
    { id: 'source-one', name: '封面', background: null, transition: 'none', elements: [
      { id: 'heading', kind: 'text', x: 80, y: 100, w: 800, h: 100,
        text: { content: '第一页的源文案', size: 48, color: '#000000', bold: false,
          align: 'left', valign: 'middle', font: '' } },
    ] },
    { id: 'source-two', name: '第二页', background: null, transition: 'none', elements: [] },
  ],
}

let root: string
let libraryRoot: string | undefined
let ctx: Context
let projects: PptProjects

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ppt-import-repair-'))
  ctx = new Context()
  await ctx.plugin(SessionStore)
  ctx.sessions.create(SessionId(SESSION), { meta: { cwd: root } })
  ctx.provide('webServer', { register: () => () => undefined } as never)
  ctx.provide('connection', { requestRejection: () => undefined } as never)
  await ctx.plugin(PptProjects, { templatesDir: join(root, 'templates') })
  projects = ctx.pptProjects
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  if (libraryRoot !== undefined) await rm(libraryRoot, { recursive: true, force: true })
  libraryRoot = undefined
})

describe('PPT 导入修复的宿主服务', () => {
  it('仅从已登记的本机上传绝对路径导入、取证和提取模板，工程仍写在工作区', async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), 'ppt-managed-upload-'))
    await mkdir(join(libraryRoot, 'uploads'))
    const uploadId = '123e4567-e89b-42d3-a456-426614174000'
    const source = join(libraryRoot, 'uploads', `${uploadId}-brand.pptx`)
    const unregistered = join(libraryRoot, 'uploads', 'other.pptx')
    const bytes = buildPptx(deck)
    await writeFile(source, bytes)
    await writeFile(unregistered, bytes)
    const registered = new Map([[source, { id: uploadId, name: 'brand.pptx' }]])
    ctx.provide('fileLibrary', {
      root: libraryRoot, getUpload: async (path: string) => registered.get(path),
    } as never)

    const imported = await projects.import(SESSION, source, { dir: 'ppt/from-upload' })
    expect(imported.snapshot.dir).toBe(join(root, 'ppt', 'from-upload'))
    expect(imported.snapshot.title).toBe('brand')
    const evidence = await projects.importEvidence(SESSION, source, {
      sourceIndex: 1, sourceSha256: imported.sourceSha256,
    })
    expect(evidence.content).toContain('第一页的源文案')
    const template = await projects.importTemplateFromFile(SESSION, source)
    expect(template).toMatchObject({ name: 'brand', sourceName: 'brand.pptx' })
    await expect(projects.import(SESSION, source, { dir: join(libraryRoot, 'project') }))
      .rejects.toMatchObject({ code: 'forbidden' })

    for (const rejected of [unregistered, join(libraryRoot, 'uploads', 'unknown.pptx')]) {
      await expect(projects.import(SESSION, rejected, {})).rejects.toMatchObject({ code: 'forbidden' })
      await expect(projects.importEvidence(SESSION, rejected, { sourceIndex: 1, sourceSha256: imported.sourceSha256 }))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(projects.importTemplateFromFile(SESSION, rejected)).rejects.toMatchObject({ code: 'forbidden' })
    }
    await expect(projects.import(SESSION, `${libraryRoot}/uploads/../uploads/${uploadId}-brand.pptx`, {}))
      .rejects.toMatchObject({ code: 'forbidden' })
    await writeFile(source, new Uint8Array(8 * 1024 * 1024 + 1))
    await expect(projects.importTemplateFromFile(SESSION, source)).rejects.toMatchObject({ code: 'bad-request' })
    await rm(source)
    await symlink(unregistered, source)
    await expect(projects.import(SESSION, source, {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(projects.importEvidence(SESSION, source, { sourceIndex: 1, sourceSha256: imported.sourceSha256 }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect(projects.importTemplateFromFile(SESSION, source)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('读取期间上传登记撤销时拒绝来源', async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), 'ppt-managed-upload-'))
    await mkdir(join(libraryRoot, 'uploads'))
    const source = join(libraryRoot, 'uploads', 'brand.pptx')
    await writeFile(source, buildPptx(deck))
    let checks = 0
    ctx.provide('fileLibrary', {
      root: libraryRoot, getUpload: async () => ++checks === 1 ? { id: 'one', name: 'brand.pptx' } : undefined,
    } as never)
    await expect(projects.import(SESSION, source, {})).rejects.toMatchObject({ code: 'forbidden' })
    expect(checks).toBe(2)
  })

  it('登记检查后源文件变为符号链接时仍拒绝读取', async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), 'ppt-managed-upload-'))
    await mkdir(join(libraryRoot, 'uploads'))
    const source = join(libraryRoot, 'uploads', 'brand.pptx')
    const replacement = join(libraryRoot, 'uploads', 'replacement.pptx')
    await writeFile(source, buildPptx(deck))
    await writeFile(replacement, buildPptx(deck))
    ctx.provide('fileLibrary', {
      root: libraryRoot,
      getUpload: async () => {
        await rm(source)
        await symlink(replacement, source)
        return { id: 'one', name: 'brand.pptx' }
      },
    } as never)
    await expect(projects.import(SESSION, source, {})).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('返回源页对照、工程页 ID 和真实源文件哈希，准备阶段不写模板库', async () => {
    const bytes = buildPptx(deck)
    await writeFile(join(root, 'source.pptx'), bytes)
    const result = await projects.import(SESSION, 'source.pptx', { title: '待修复', dir: 'ppt/repair' })
    expect(result.sourceSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(result.report).toMatchObject({ sourceSlides: 2, importedPages: 2 })
    expect(result.snapshot.pages).toBe(2)
    expect(result.report.pages.map(page => page.sourceIndex)).toEqual([1, 2])
    expect(result.report.pages.map(page => page.pageId)).toEqual(result.snapshot.deck.pages.map(page => page.id))
    expect(result.report.pages[0]).toMatchObject({ slidePart: 'ppt/slides/slide1.xml' })
    expect(result.report.pages[0]?.textPreview.join('')).toContain('第一页的源文案')
    expect(await projects.listTemplates()).toEqual([])
    expect(projects.activeDir(SESSION)).toBe('ppt/repair')
  })

  it('证据按同一源页有界续读，源文件变化拒绝旧哈希', async () => {
    const bytes = buildPptx(deck)
    await writeFile(join(root, 'source.pptx'), bytes)
    const { sourceSha256 } = await projects.import(SESSION, 'source.pptx', {})
    let offset = 0
    let content = ''
    let firstCache: unknown
    for (;;) {
      const chunk = await projects.importEvidence(SESSION, 'source.pptx', { sourceIndex: 1, sourceSha256, offset, limit: 64 })
      if (firstCache === undefined) firstCache = projects['evidenceCache']
      else expect(projects['evidenceCache']).toBe(firstCache)
      expect(chunk.sourceSha256).toBe(sourceSha256)
      expect(chunk.content.length).toBeLessThanOrEqual(64)
      content += chunk.content
      if (chunk.nextOffset === null) {
        expect(content.length).toBe(chunk.totalChars)
        break
      }
      expect(chunk.nextOffset).toBeGreaterThan(offset)
      offset = chunk.nextOffset
    }
    expect(JSON.parse(content)).toMatchObject({ slidePart: 'ppt/slides/slide1.xml' })
    expect(content).toContain('第一页的源文案')
    const secondPage = await projects.importEvidence(SESSION, 'source.pptx', { sourceIndex: 2, sourceSha256 })
    expect(secondPage.content).toContain('ppt/slides/slide2.xml')
    expect(projects['evidenceCache']).not.toBe(firstCache)
    expect(projects['evidenceCache']?.sourceIndex).toBe(2)
    const secondCache = projects['evidenceCache']
    await writeFile(join(root, 'copy.pptx'), bytes)
    await projects.importEvidence(SESSION, 'copy.pptx', { sourceIndex: 2, sourceSha256 })
    expect(projects['evidenceCache']).not.toBe(secondCache)
    await expect(projects.importEvidence(SESSION, 'source.pptx', { sourceIndex: 1, sourceSha256: 'bad' }))
      .rejects.toMatchObject({ code: 'bad-request' })
    const changed: PptDeck = { ...deck, pages: [
      { ...deck.pages[0]!, elements: [{ ...deck.pages[0]!.elements[0]!, kind: 'text',
        text: { content: '改动后的源文案', size: 48, color: '#000000', bold: false,
          align: 'left', valign: 'middle', font: '' } }] },
      deck.pages[1]!,
    ] }
    await writeFile(join(root, 'source.pptx'), buildPptx(changed))
    await expect(projects.importEvidence(SESSION, 'source.pptx', { sourceIndex: 1, sourceSha256 }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(projects['evidenceCache']?.sourcePath).toBe(join(root, 'copy.pptx'))
    await rm(join(root, 'source.pptx'))
    await expect(projects.importEvidence(SESSION, 'source.pptx', { sourceIndex: 1, sourceSha256 }))
      .rejects.toMatchObject({ code: 'not-found' })
  })

  it('导入与取证都沿用本机工作区、后缀、大小及符号链接准入', async () => {
    const bytes = buildPptx(deck)
    await writeFile(join(root, 'source.pptx'), bytes)
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
    await symlink(join(root, 'source.pptx'), join(root, 'alias.pptx'))
    for (const source of ['../outside.pptx', join(tmpdir(), 'outside.pptx'), 'alias.pptx']) {
      await expect(projects.import(SESSION, source, {})).rejects.toMatchObject({ code: 'forbidden' })
      await expect(projects.importEvidence(SESSION, source, { sourceIndex: 1, sourceSha256 }))
        .rejects.toMatchObject({ code: 'forbidden' })
    }
    for (const source of ['source.pptm', 'source.potx']) {
      await expect(projects.import(SESSION, source, {})).rejects.toMatchObject({ code: 'bad-request' })
      await expect(projects.importEvidence(SESSION, source, { sourceIndex: 1, sourceSha256 }))
        .rejects.toMatchObject({ code: 'bad-request' })
    }
    await writeFile(join(root, 'large.pptx'), new Uint8Array(8 * 1024 * 1024 + 1))
    await expect(projects.importEvidence(SESSION, 'large.pptx', { sourceIndex: 1, sourceSha256 }))
      .rejects.toMatchObject({ code: 'bad-request' })
    await mkdir(join(root, 'nested'))
    await symlink(join(root, 'source.pptx'), join(root, 'nested', 'source.pptx'))
    await expect(projects.importEvidence(SESSION, 'nested/source.pptx', { sourceIndex: 1, sourceSha256 }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode: 'agent',
    }))
    await expect(projects.import(SESSION, 'source.pptx', {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(projects.importEvidence(SESSION, 'source.pptx', { sourceIndex: 1, sourceSha256 }))
      .rejects.toMatchObject({ code: 'forbidden' })
  })
})
