import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HostConnectionService } from 'coding-client-connection'
import { WebServer } from 'coding-host-webserver'
import SessionStore, { SessionId } from 'coding-session'
import { parseDeck, PPT_FORMAT, type PptDeck } from 'coding-ppt-model'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDeck } from '../src/check.ts'
import PptProjects from '../src/index.ts'
import { createProjectFromDeck } from '../src/store.ts'
import { PPT_TEMPLATES } from '../src/templates.ts'

const SESSION = 'catalog-fixture-session'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9fb8sAAAAASUVORK5CYII=', 'base64')
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** 用 Loader 挂载真实 HTTP、连接信任栅栏和隔离的模板仓库。 */
async function boot(): Promise<{ base: string; projects: PptProjects }> {
  root = await mkdtemp(join(tmpdir(), 'ppt-catalog-routes-'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(SessionStore)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (specifier === 'coding-host-webserver') return WebServer
    if (specifier === 'coding-ppt-workbench') return PptProjects
    if (specifier === 'test-connection') return {
      inject: ['webServer'], apply(host: Context) { new HostConnectionService(host, []) },
    }
    throw new Error(`unknown test plugin: ${specifier}`)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: coding-host-webserver',
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    '- name: test-connection',
    '- name: coding-ppt-workbench',
    '  config:',
    `    templatesDir: ${JSON.stringify(join(root, 'templates'))}`,
    '',
  ].join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  return { base: `http://127.0.0.1:${ctx.webServer.port}`, projects: ctx.pptProjects }
}

function request(base: string, route: string, query: Record<string, string> = {}, init?: RequestInit): Promise<Response> {
  return fetch(`${base}/api/ppt/${route}${Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : ''}`, init)
}

function reboundStatus(base: string, route: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/ppt/${route}?id=broken`, { headers: { host: 'evil.invalid' } }, (res) => {
      res.resume()
      res.on('end', () => { resolve(res.statusCode) })
    })
    req.on('error', reject)
    req.end()
  })
}

async function fixture(projects: PptProjects): Promise<{ id: string; deck: PptDeck; createdAt: number }> {
  const deck: PptDeck = {
    format: PPT_FORMAT, title: '图库', size: '16:9', theme: 'ink',
    pages: [{ id: 'cover', name: '封面', background: null, transition: 'none', elements: [
      { id: 'photo', kind: 'image', x: 0, y: 0, w: 100, h: 100, fit: 'contain', source: 'media/photo.png' },
      { id: 'vector', kind: 'image', x: 100, y: 0, w: 100, h: 100, fit: 'contain', source: 'media/vector.svg' },
    ] }],
  }
  const dir = join(root!, 'ppt', 'fixture')
  await createProjectFromDeck(dir, deck)
  await mkdir(join(dir, 'media'))
  await writeFile(join(dir, 'media', 'photo.png'), png)
  await writeFile(join(dir, 'media', 'vector.svg'), svg)
  const template = await projects.saveTemplate(SESSION, { name: '可复用图库', dir: 'ppt/fixture' })
  return { id: template.id, deck: template.deck, createdAt: template.createdAt }
}

describe('PPT 用户模板只读 HTTP 目录', () => {
  it('无会话时展示默认整稿预览，不创建持久工程或模板', async () => {
    const { base, projects } = await boot()
    const response = await request(base, 'templates/default')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const payload = await response.json() as { ok: boolean; deck: PptDeck }
    const preview = parseDeck(payload.deck)
    expect(preview.theme).toBe('inference')
    expect(preview.pages).toHaveLength(6)
    // 默认整稿的文字与表格一律黑体；字体写进 deck.json，导出时同时落到 a:latin 与 a:ea。
    const previewFonts = preview.pages.flatMap(page => page.elements)
      .flatMap(element => element.kind === 'text' || element.kind === 'table' ? [element.text.font] : [])
    expect(previewFonts.length).toBeGreaterThan(0)
    expect(previewFonts.every(font => font === '黑体')).toBe(true)
    expect(checkDeck(preview).ok).toBe(true)
    expect(projects.activeDir(SESSION)).toBeUndefined()
    expect(await stat(join(root!, 'ppt')).then(() => true, () => false)).toBe(false)
    expect(await stat(join(root!, 'templates')).then(() => true, () => false)).toBe(false)
  })

  it('内置版式预览复用七种单页元素，且不创建工程或用户模板', async () => {
    const { base, projects } = await boot()
    const first = await request(base, 'templates/builtins')
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('no-store')
    const response = await first.json() as { ok: boolean; deck: PptDeck }
    expect(response.ok).toBe(true)
    const deck = parseDeck(response.deck)
    expect(deck).toEqual(response.deck)
    expect(deck.size).toBe('16:9')
    expect(deck.theme).toBe('paper')
    expect(deck.pages).toHaveLength(7)
    expect(deck.pages.map(page => ({ id: page.id, label: page.name }))).toEqual(PPT_TEMPLATES)
    expect(deck.pages.every(page => page.elements.length > 0 && page.elements.every(element => element.kind !== 'image'))).toBe(true)
    expect(deck.pages.find(page => page.id === 'data')?.elements.some(element => element.kind === 'table')).toBe(true)
    const builtinFonts = deck.pages.flatMap(page => page.elements)
      .flatMap(element => element.kind === 'text' || element.kind === 'table' ? [element.text.font] : [])
    expect(builtinFonts.length).toBeGreaterThan(0)
    expect(builtinFonts.every(font => font === '黑体')).toBe(true)
    const chart = deck.pages.find(page => page.id === 'chart')?.elements.find(element => element.kind === 'chart')
    expect(chart?.kind === 'chart' ? chart.series[0]?.values : undefined).toEqual([32, 45, 38, 56])
    expect(checkDeck(deck).issues.filter(issue => issue.severity === 'error')).toEqual([])
    expect(await (await request(base, 'templates/builtins')).json()).toEqual(response)
    expect(projects.activeDir(SESSION)).toBeUndefined()
    expect(await stat(join(root!, 'ppt')).then(() => true, () => false)).toBe(false)
    expect(await stat(join(root!, 'templates')).then(() => true, () => false)).toBe(false)
  })

  it('无会话时仍能列出摘要、读取完整详情和被引用的栅格图', async () => {
    const { base, projects } = await boot()
    const sessionFiber = await ctx!.plugin(Object.assign((inner: Context) => {
      inner.sessions.create(SessionId(SESSION), { meta: { cwd: root! } })
    }, { inject: ['sessions'] }))
    const { id, deck, createdAt } = await fixture(projects)
    // 模板目录可在会话关闭后独立浏览。
    await sessionFiber.dispose()

    const list = await request(base, 'templates')
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ ok: true, templates: [{
      id, name: '可复用图库', pages: 1, createdAt, sourceName: null, dropped: [],
    }] })
    const detail = await request(base, 'templates/detail', { id })
    expect(detail.status).toBe(200)
    expect(await detail.json()).toEqual({ ok: true, template: {
      id, name: '可复用图库', pages: 1, createdAt, sourceName: null, dropped: [], deck,
    } })
    const image = await request(base, 'templates/media', { id, path: 'media/photo.png' })
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(image.headers.get('x-content-type-options')).toBe('nosniff')
    expect(image.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png)
    expect(projects.activeDir(SESSION)).toBeUndefined()
  })

  it('拒绝缺失、不合法和未引用媒体，SVG 不经同源路由输出', async () => {
    const { base, projects } = await boot()
    ctx!.sessions.create(SessionId(SESSION), { meta: { cwd: root! } })
    const { id } = await fixture(projects)
    const cases = [
      ['templates/detail', {}, 400, 'bad-request'],
      ['templates/detail', { id: '../escape' }, 400, 'bad-request'],
      ['templates/detail', { id: '00000000-0000-4000-8000-000000000000' }, 404, 'not-found'],
      ['templates/media', { id }, 400, 'bad-request'],
      ['templates/media', { id: '../escape', path: 'media/photo.png' }, 400, 'bad-request'],
      ['templates/media', { id, path: 'media/../photo.png' }, 400, 'bad-request'],
      ['templates/media', { id, path: 'media/not-referenced.png' }, 404, 'not-found'],
      ['templates/media', { id, path: 'media/vector.svg' }, 403, 'forbidden'],
      ['templates/media', { id, path: 'template.json' }, 403, 'forbidden'],
    ] as const
    for (const [route, query, status, code] of cases) {
      const response = await request(base, route, query)
      expect(response.status, `${route} ${JSON.stringify(query)}`).toBe(status)
      expect(await response.json()).toMatchObject({ ok: false, error: { code } })
    }
  })

  it('信任栅栏先于 id 解析，非 GET 和写入路径不可用', async () => {
    const { base, projects } = await boot()
    ctx!.sessions.create(SessionId(SESSION), { meta: { cwd: root! } })
    await fixture(projects)
    for (const route of ['templates', 'templates/default', 'templates/builtins', 'templates/detail', 'templates/media']) {
      const foreign = await request(base, route, { id: 'broken', path: 'media/a.png' }, {
        headers: { origin: 'http://evil.invalid' },
      })
      expect(foreign.status).toBe(403)
      expect(await foreign.text()).toBe('')
      expect(await reboundStatus(base, route)).toBe(403)
      const crossSite = await request(base, route, { id: 'broken', path: 'media/a.png' }, {
        headers: { 'sec-fetch-site': 'cross-site' },
      })
      expect(crossSite.status).toBe(403)
      const post = await request(base, route, {}, { method: 'POST', body: 'not json' })
      expect(post.status).toBe(405)
      expect(await post.json()).toMatchObject({ ok: false, error: { code: 'method' } })
    }
    for (const route of ['templates/import', 'templates/upload', 'templates/create', 'templates/rename', 'templates/delete']) {
      expect((await request(base, route, {}, { method: 'POST' })).status).toBe(404)
    }
    expect(await projects.listTemplates()).toHaveLength(1)
  })
})
