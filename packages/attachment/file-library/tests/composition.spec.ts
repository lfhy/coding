/** 通过真实 Loader、SQLite、Connection 与 WebServer 验证文件库路由。 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Storage from 'coding-storage'
import * as StorageDomain from 'coding-storage-domain'
import * as Sqlite from 'coding-storage-sqlite'
import WebServer from 'coding-host-webserver'
import * as Connection from 'coding-client-connection'
import FileLibrary, { type MindMapSnapshot, type NotesTreeNode } from '../src/index.ts'
import { xmindArchive } from './xmind-fixture.ts'

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('文件库真实装配', () => {
  async function boot() {
    const dir = await mkdtemp(join(tmpdir(), 'coding-file-library-composed-'))
    dirs.push(dir)
    const configPath = join(dir, 'cordis.yml')
    await writeFile(configPath, [
      '- name: coding-storage',
      '- name: coding-storage-sqlite',
      `  config: ${JSON.stringify({ path: join(dir, 'files.sqlite') })}`,
      '- name: coding-storage-domain',
      '  config: { backend: sqlite, routes: { files: sqlite } }',
      '- name: coding-host-webserver',
      '  config: { host: 127.0.0.1, port: 0 }',
      '- name: coding-client-connection',
      '- name: coding-file-library',
      `  config: ${JSON.stringify({ root: join(dir, 'files') })}`,
      '',
    ].join('\n'))
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = `${pathToFileURL(dir).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['coding-storage', Storage], ['coding-storage-sqlite', Sqlite],
      ['coding-storage-domain', StorageDomain], ['coding-host-webserver', WebServer],
      ['coding-client-connection', Connection], ['coding-file-library', FileLibrary],
    ])
    ctx.loader.internal = { version: 'v2', import: async (name: string) => {
      if (!modules.has(name)) throw new Error(`unexpected module ${name}`)
      return modules.get(name)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    return { ctx, origin: `http://127.0.0.1:${ctx.webServer.port}` }
  }

  it('装配 SQLite 元数据，只向可信请求提供文件列表', async () => {
    const { ctx, origin } = await boot()
    const result = await ctx.fileLibrary.saveUpload({
      name: 'app.txt', sessionId: 'one',
      stream: (async function* () { yield Buffer.from('hello') })(), verify: async () => {},
    })
    const url = `${origin}/api/files/list`
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ total: 1, items: [{ id: result.record.id, name: 'app.txt' }] })
    expect((await fetch(url, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  })

  it('同源新建笔记可携带导入原文，非法载荷不落盘', async () => {
    const { ctx, origin } = await boot()
    const url = `${origin}/api/notes/create`
    const post = (body: unknown) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
    })
    const created = await post({ name: '会议记录', content: '# 会议记录' })
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ path: '会议记录.md' })
    await expect(readFile(join(ctx.fileLibrary.notesRootPath(), '会议记录.md'), 'utf8')).resolves.toBe('# 会议记录')
    expect((await post({ name: '空稿' })).status).toBe(201)
    await expect(readFile(join(ctx.fileLibrary.notesRootPath(), '空稿.md'), 'utf8')).resolves.toBe('')
    expect((await post({ name: '坏载荷', content: 7 })).status).toBe(400)
    expect((await post({ name: '重复稿' })).status).toBe(201)
    expect((await post({ name: '重复稿' })).status).toBe(400)
  })

  it('同源 DELETE 删除非空目录，拒绝跨源、错误方法和无效载荷', async () => {
    const { ctx, origin } = await boot()
    const folder = '项目资料'
    await ctx.fileLibrary.saveNote(`${folder}/子目录/笔记.md`, '待删除')
    const target = join(ctx.fileLibrary.notesRootPath(), folder)
    const url = `${origin}/api/notes/delete`
    const request = {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ path: folder }),
    }

    // 保持 Host 和端口相同，只改变协议，覆盖笔记路由自身的严格同源检查。
    const crossOrigin = await fetch(url, {
      ...request, headers: { ...request.headers, origin: origin.replace('http:', 'https:') },
    })
    expect(crossOrigin.status).toBe(403)
    const wrongMethod = await fetch(url, { ...request, method: 'POST' })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('DELETE')
    const missingPath = await fetch(url, { ...request, body: '{}' })
    expect(missingPath.status).toBe(400)
    await expect(readFile(join(target, '子目录', '笔记.md'), 'utf8')).resolves.toBe('待删除')

    const removed = await fetch(url, request)
    expect(removed.status).toBe(204)
    expect(await removed.text()).toBe('')
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    const missing = await fetch(url, request)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: '笔记不存在' })
  })

  it('同源思维导图路由创建和导入真实笔记，公开版本冲突与文件缺失', async () => {
    const { ctx, origin } = await boot()
    const notes = `${origin}/api/notes`
    const url = `${notes}/mindmap`
    const root = ctx.fileLibrary.notesRootPath()
    await ctx.fileLibrary.createNoteDirectory('子目录')
    const send = (endpoint: string, body: unknown, method = 'POST', from = origin) => fetch(`${notes}/${endpoint}`, {
      method, headers: { origin: from, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const blocked = await send('mindmap/create', { name: '不应创建' }, 'POST', origin.replace('http:', 'https:'))
    expect(blocked.status).toBe(403)
    expect(blocked.headers.get('cache-control')).toBe('private, no-store')
    const created = await send('mindmap/create', { name: '想法', directory: '子目录' })
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('private, no-store')
    const path = '子目录/想法.codingmindmap'
    expect(await created.json()).toEqual({ path })
    expect((await send('mindmap/create', { name: '想法', directory: '子目录' })).status).toBe(409)
    expect((await send('mindmap/create', { name: '无会话', sessionId: '额外字段' })).status).toBe(400)

    const read = `${url}/read?${new URLSearchParams({ path })}`
    const readResponse = await fetch(read, { headers: { origin } })
    expect(readResponse.status).toBe(200)
    expect(readResponse.headers.get('cache-control')).toBe('private, no-store')
    const snapshot = await readResponse.json() as MindMapSnapshot
    expect(snapshot).toMatchObject({ path, document: { version: 1, root: { text: '想法', children: [] } } })
    expect((await fetch(read, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await fetch(`${read}&path=${encodeURIComponent(path)}`)).status).toBe(400)
    expect((await fetch(`${read}&sessionId=unused`)).status).toBe(400)
    const method = await fetch(`${url}/edit`)
    expect(method.status).toBe(405)
    expect(method.headers.get('allow')).toBe('POST')

    const edit = { path, revision: snapshot.revision, edits: [{ op: 'add', parentId: snapshot.document.root.id, text: '分支' }] }
    const invalidEdit = await send('mindmap/edit', { ...edit, edits: [...edit.edits, { op: 'delete', id: snapshot.document.root.id }] })
    expect(invalidEdit.status).toBe(400)
    expect(await (await fetch(read)).json()).toEqual(snapshot)
    const saved = await send('mindmap/edit', edit)
    expect(saved.status).toBe(200)
    expect(saved.headers.get('cache-control')).toBe('private, no-store')
    expect(await saved.json()).toMatchObject({ path, document: { root: { children: [{ text: '分支' }] } } })
    expect((await send('mindmap/edit', edit)).status).toBe(409)

    const upload = `${url}/import?${new URLSearchParams({ name: '示例.xmind', directory: '子目录' })}`
    const archive = xmindArchive([{ name: 'content.json', data: Buffer.from('[{"rootTopic":{"title":"原中心"}}]'), stored: true }])
    const importRequest = { method: 'POST', headers: { origin, 'content-type': 'application/octet-stream' }, body: new Uint8Array(archive) }
    expect((await fetch(`${upload}&directory=ignored`, importRequest)).status).toBe(400)
    expect((await fetch(upload, { ...importRequest, headers: { ...importRequest.headers, 'content-type': 'application/json' } })).status).toBe(400)
    const imported = await fetch(upload, importRequest)
    expect(imported.status).toBe(201)
    expect(imported.headers.get('cache-control')).toBe('private, no-store')
    expect(await imported.json()).toEqual({ path: '子目录/示例.codingmindmap' })
    const tree = await (await fetch(`${notes}/tree`)).json() as { children: NotesTreeNode[] }
    expect(tree.children[0]).toMatchObject({ kind: 'dir', path: '子目录' })
    expect(tree.children[0]?.children?.map(entry => `${entry.kind}:${entry.path}`).sort()).toEqual([
      'mindmap:子目录/想法.codingmindmap', 'mindmap:子目录/示例.codingmindmap',
    ])
    expect(await ctx.fileLibrary.readNoteMindmap('子目录/示例.codingmindmap')).toMatchObject({ document: { root: { text: '原中心' } } })
    expect((await send('delete', { path }, 'DELETE')).status).toBe(204)
    expect((await fetch(read)).status).toBe(404)
    expect((await send('mindmap/edit', edit)).status).toBe(404)
    await expect(readdir(root)).resolves.toEqual(['子目录'])
    await expect(readdir(join(root, '子目录'))).resolves.toEqual(['示例.codingmindmap'])
  })

  it.each([['codingmindmap', 1], ['xmind', 16]] as const)('分块导入 %s 不依赖 Content-Length，限制为 %i MiB', async (ext, maxMiB) => {
    const { ctx, origin } = await boot()
    const url = `${origin}/api/notes/mindmap/import?name=overflow.${ext}`
    await ctx.fileLibrary.notesTree()
    const chunk = new Uint8Array(1024 * 1024)
    let chunks = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks === maxMiB + 1) controller.close()
        else { chunks += 1; controller.enqueue(chunk) }
      },
    })
    const request: RequestInit & { duplex: 'half' } = {
      method: 'POST', headers: { origin, 'content-type': 'application/octet-stream' }, body, duplex: 'half',
    }
    const response = await fetch(url, request)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: `思维导图上传超过 ${maxMiB} MiB` })
    await expect(readdir(ctx.fileLibrary.notesRootPath())).resolves.toEqual([])
  })
})
