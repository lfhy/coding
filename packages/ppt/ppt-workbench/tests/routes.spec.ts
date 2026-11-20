import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { WebServer } from 'coding-host-webserver'
import { HostConnectionService } from 'coding-client-connection'
import SessionStore, { SessionId } from 'coding-session'
import { buildPptx } from '../src/export/pptx.ts'
import { importPptx } from '../src/import.ts'
import PptProjects from '../src/index.ts'

const SESSION = 'ppt-route-session'
let ctx: Context | undefined
let root: string | undefined

function noteLibrary(notesRoot: string): object {
  return {
    notesRootPath: () => notesRoot,
    createNotePptx: async (name: string, directory: string, bytes: Uint8Array) => {
      const fileName = name.toLowerCase().endsWith('.pptx') ? name : `${name}.pptx`
      const rootPath = resolve(notesRoot)
      const target = resolve(rootPath, directory, fileName)
      if (target !== rootPath && !target.startsWith(`${rootPath}/`)) throw new TypeError('笔记路径无效')
      await mkdir(dirname(target), { recursive: true })
      try { await writeFile(target, bytes, { flag: 'wx' }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TypeError('笔记已存在'); throw error }
      return { path: directory === '' ? fileName : `${directory}/${fileName}` }
    },
    deleteNote: async (path: string) => { await rm(resolve(notesRoot, path), { force: true }) },
  }
}

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** 经 Loader 挂载真实 WebServer、连接信任栅栏与 PPT 路由，不读取本机已有会话。 */
async function boot(): Promise<{ base: string; projects: PptProjects }> {
  root = await mkdtemp(join(tmpdir(), 'coding-ppt-routes-'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(SessionStore)
  ctx.sessions.create(SessionId(SESSION), { meta: { cwd: root } })
  ctx.provide('fileLibrary', noteLibrary(root) as never)
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
    '',
  ].join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  return { base: `http://127.0.0.1:${ctx.webServer.port}`, projects: ctx.pptProjects }
}

async function state(base: string, sessionId = SESSION, init?: RequestInit): Promise<Response> {
  return fetch(`${base}/api/ppt/state?${new URLSearchParams({ sessionId }).toString()}`, init)
}

describe('PPT 状态路由的真实 HTTP 组合', () => {
  it('笔记源创建校验载荷并返回相对 source', async () => {
    const { base } = await boot()
    const post = (body: Record<string, unknown>) => fetch(`${base}/api/ppt/notes/create`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const created = await post({ sessionId: SESSION, name: '笔记演示' })
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({ ok: true, source: '笔记演示.pptx' })
    const duplicate = await post({ sessionId: SESSION, name: '笔记演示' })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toMatchObject({ ok: false, error: { code: 'conflict' } })
    const missing = await post({ sessionId: SESSION })
    expect(missing.status).toBe(400)
    const escaped = await post({ sessionId: SESSION, name: '越界', directory: '../outside' })
    expect(escaped.status).toBe(400)
  })

  it('来源打开路由复用面板编辑，并在源文件外部变化时轮询返回冲突', async () => {
    const { base } = await boot()
    const source = join(root!, 'presentation.pptx')
    const deck = {
      format: 1 as const, title: '讲稿', size: '16:9' as const, theme: 'ink' as const,
      pages: [{ id: 'slide', name: '标题页', background: null, transition: 'none' as const, elements: [] }],
    }
    await writeFile(source, buildPptx(deck))
    const post = (path: string, body: Record<string, unknown>) => fetch(`${base}/api/ppt/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION, ...body }),
    })
    const opened = await post('source/open', { source: 'presentation.pptx' })
    expect(opened.status).toBe(200)
    const result = await opened.json() as { project: { revision: number; deck: { pages: { id: string }[] } } }
    expect(result.project.revision).toBe(1)
    const edited = await post('edit', { baseRevision: 1, ops: [
      { op: 'add_page', title: '新页' },
    ] })
    expect(edited.status).toBe(200)
    expect(importPptx(await readFile(source), { title: '回读' }).deck.pages).toHaveLength(2)
    const legacy = await post('source/open', {})
    expect(legacy.status).toBe(400)
    expect(await legacy.json()).toMatchObject({ ok: false, error: { code: 'bad-request', message: 'source 必须提供' } })
    await writeFile(source, buildPptx(deck))
    const conflict = await state(base)
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: 'conflict' } })
  })

  it('上传图片由工程服务统一校验，成功路径可从媒体路由读回', async () => {
    const { base, projects } = await boot()
    const created = await projects.create(SESSION, { title: '配图' })
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    const send = (name: string, bytes: Buffer) => fetch(`${base}/api/ppt/upload?sessionId=${SESSION}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, base64: bytes.toString('base64') }),
    })
    const uploaded = await send('art.png', png)
    expect(uploaded.status).toBe(200)
    const result = await uploaded.json() as { source: string }
    expect(result.source).toMatch(/^media\/up-[\w-]+\.png$/u)
    expect(await readFile(join(created.dir, result.source))).toEqual(png)
    const media = await fetch(`${base}/api/ppt/media?${new URLSearchParams({
      sessionId: SESSION, path: result.source,
    })}`)
    expect(media.status).toBe(200)
    expect(Buffer.from(await media.arrayBuffer())).toEqual(png)
    expect((await send('art.jpg', png)).status).toBe(400)
    expect((await send('art.svg', Buffer.from('<svg/>'))).status).toBe(400)
  })

  it('通过真实路由上传并原位替换截图占位，拒绝失效版本而不覆盖工程', async () => {
    const { base, projects } = await boot()
    const created = await projects.create(SESSION, { title: '截图占位' })
    const page = created.deck.pages[0]!.id
    const seeded = await projects.edit(SESSION, undefined, [
      { op: 'add_element', page, element: { id: 'frame', kind: 'rect', x: 96, y: 188, w: 254, h: 143, fill: '#e8e5dc' } },
      { op: 'add_element', page, element: { id: 'label', kind: 'text', x: 96, y: 188, w: 254, h: 143,
        text: { content: '代码截图', size: 14, color: '#75736c', align: 'center', valign: 'middle' } } },
    ], created.revision)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    const uploaded = await fetch(`${base}/api/ppt/upload?sessionId=${SESSION}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'shot.png', base64: png.toString('base64') }),
    })
    expect(uploaded.status).toBe(200)
    const { source } = await uploaded.json() as { source: string }
    const send = (baseRevision: number) => fetch(`${base}/api/ppt/edit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION, baseRevision,
        ops: [{ op: 'replace_image', page, element: 'frame', label: 'label', source }] }),
    })
    expect((await send(created.revision)).status).toBe(409)
    expect((await projects.read(SESSION)).revision).toBe(seeded.revision)
    const edited = await send(seeded.revision)
    expect(edited.status).toBe(200)
    const elements = (await projects.read(SESSION)).deck.pages[0]!.elements
    expect(elements.find(element => element.id === 'frame')).toMatchObject({
      kind: 'image', x: 96, y: 188, w: 254, h: 143, source, fit: 'cover',
    })
    expect(elements.some(element => element.id === 'label')).toBe(false)
    expect(await readFile(join(created.dir, source))).toEqual(png)
  })

  it('空工程成功返回可用状态，模型新建与打开后各会话独立', async () => {
    const { base, projects } = await boot()
    const initial = await state(base)
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({ ok: true, state: {
      root, projects: [], active: null, openRequest: null,
    } })

    const created = await projects.create(SESSION, { title: '季度汇报' })
    const loaded = await state(base)
    expect(loaded.status).toBe(200)
    const payload = await loaded.json() as {
      ok: boolean
      state: {
        active: { dir: string; title: string }
        openRequest: { dir: string; at: number }
      }
    }
    expect(payload.state.active).toMatchObject({ dir: created.dir, title: '季度汇报' })
    expect(payload.state.openRequest.dir).toBe(projects.activeDir(SESSION))
    expect(Number.isSafeInteger(payload.state.openRequest.at)).toBe(true)
    const missing = await state(base, 'another-session')
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('HTTP 编辑接受一次编码的 ops 数组并保持失败请求原子性', async () => {
    const { base, projects } = await boot()
    const created = await projects.create(SESSION, { title: 'HTTP 编辑' })
    const send = (ops: unknown, baseRevision = 1) => fetch(`${base}/api/ppt/edit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION, ops, baseRevision }),
    })
    const edited = await send(JSON.stringify([{ op: 'add_page', title: '追加' }]))
    expect(edited.status).toBe(200)
    expect((await projects.read(SESSION)).deck.pages).toHaveLength(created.pages + 1)
    expect((await send([{ op: 'add_page', title: '再追加' }], 2)).status).toBe(200)
    for (const invalid of ['not json', JSON.stringify(JSON.stringify([{ op: 'add_page' }])), '{}', '[]',
      JSON.stringify([{ op: 'bad' }]), 'x'.repeat(1024 * 1024 + 1)]) {
      const response = await send(invalid, 3)
      expect(response.status).toBe(400)
    }
    expect((await send(JSON.stringify([{ op: 'add_page' }]), 1)).status).toBe(409)
    const latest = await projects.read(SESSION)
    expect(latest.revision).toBe(3)
    expect(latest.deck.pages).toHaveLength(created.pages + 2)
  })

  it('跨源请求先被拒绝，不暴露工程状态', async () => {
    const { base } = await boot()
    const foreign = await state(base, SESSION, { headers: { origin: 'http://elsewhere.invalid' } })
    expect(foreign.status).toBe(403)
  })
})
