import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { WebServer } from 'coding-host-webserver'
import { HostConnectionService } from 'coding-client-connection'
import SessionStore, { SessionId } from 'coding-session'
import PptProjects from '../src/index.ts'

const SESSION = 'ppt-route-session'
let ctx: Context | undefined
let root: string | undefined

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
