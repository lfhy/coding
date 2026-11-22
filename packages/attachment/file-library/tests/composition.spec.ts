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
import FileLibrary from '../src/index.ts'
import type { ManagedFilePage, MindMapSnapshot, NotesTreeNode, OfficeDocument, OfficeSnapshot } from '../src/index.ts'
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

  it.each([
    ['word', 'docx', 'wordprocessingml.document'],
    ['excel', 'xlsx', 'spreadsheetml.sheet'],
  ] as const)('真实 Host 提供 %s 的新建、保存、导出及再导入', async (kind, suffix, media) => {
    const { ctx, origin } = await boot()
    const folder = '项目资料'
    await ctx.fileLibrary.createNoteDirectory(folder)
    const notes = `${origin}/api/notes`
    const office = `${notes}/office`
    const post = (url: string, body: unknown, requestOrigin = origin) => fetch(url, {
      method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const path = `${folder}/周报.coding${kind}`
    const create = { kind, name: '周报', directory: folder }
    const crossOrigin = await post(`${office}/create`, create, origin.replace('http:', 'https:'))
    expect(crossOrigin.status).toBe(403)
    expect(crossOrigin.headers.get('cache-control')).toBe('private, no-store')
    expect((await post(`${office}/create`, { ...create, sessionId: '额外字段' })).status).toBe(400)
    const created = await post(`${office}/create`, create)
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ path })
    expect((await post(`${office}/create`, create)).status).toBe(409)

    const query = new URLSearchParams({ path })
    const endpoint = `${office}/read?${query}`
    const initial = await fetch(endpoint)
    expect(initial.status).toBe(200)
    expect(initial.headers.get('x-content-type-options')).toBe('nosniff')
    const snapshot = await initial.json() as OfficeSnapshot
    const document: OfficeDocument = snapshot.document.kind === 'word'
      ? { version: 1, kind: 'word', paragraphs: [{ style: 'title', align: 'center', runs: [{ text: '季度报告', bold: true }] }] }
      : { version: 1, kind: 'excel', sheets: [{ id: 'stats', name: '统计', cells: [
        { row: 0, column: 0, value: '销售额' }, { row: 2, column: 1, value: 12, formula: '=SUM(7,5)' },
      ], merges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 }] }] }
    expect(snapshot).toMatchObject({ path, document: { kind, version: 1 } })
    expect((await fetch(`${endpoint}&${query}`)).status).toBe(400)
    expect((await fetch(endpoint, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await fetch(`${notes}/read?${query}`)).status).toBe(400)
    const write = { path, revision: snapshot.revision, document }
    const saved = await post(`${office}/save`, write)
    expect(saved.status).toBe(200)
    expect(saved.headers.get('cache-control')).toBe('private, no-store')
    const next = await saved.json() as OfficeSnapshot
    expect(next.document).toEqual(document)
    expect((await post(`${office}/save`, write)).status).toBe(409)
    expect((await post(`${office}/edit`, { ...write, edits: [] })).status).toBe(404)
    const wrongMethod = await fetch(`${office}/save`)
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')

    const exportUrl = `${office}/export?${query}`
    expect((await fetch(`${exportUrl}&revision=${snapshot.revision}`)).status).toBe(409)
    const download = await fetch(`${exportUrl}&revision=${next.revision}`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe(`application/vnd.openxmlformats-officedocument.${media}`)
    expect(download.headers.get('content-disposition')).toMatch(/^attachment;/u)
    expect(download.headers.get('content-disposition')).toContain(`filename*=UTF-8''${encodeURIComponent('周报')}.${suffix}`)
    expect(download.headers.get('x-content-type-options')).toBe('nosniff')
    const bytes = new Uint8Array(await download.arrayBuffer())
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])

    const params = new URLSearchParams({ kind, name: `副本.${suffix}`, directory: folder })
    const upload = `${office}/import?${params}`
    const uploadRequest = { method: 'POST', headers: { origin, 'content-type': 'application/octet-stream' }, body: bytes }
    expect((await fetch(`${upload}&kind=${kind}`, uploadRequest)).status).toBe(400)
    expect((await fetch(upload, { ...uploadRequest, headers: { ...uploadRequest.headers, 'content-type': 'application/json' } })).status).toBe(400)
    const copied = await fetch(upload, uploadRequest)
    expect(copied.status).toBe(201)
    const copyPath = `${folder}/副本.coding${kind}`
    expect(await copied.json()).toEqual({ path: copyPath })
    const readBack = await ctx.fileLibrary.readNoteOffice(copyPath)
    if (document.kind === 'word') expect(readBack.document).toEqual(document)
    else expect(readBack.document).toMatchObject({
      kind, version: 1, sheets: document.sheets.map(({ name, cells, merges }) => ({ name, cells, merges })),
    })
    const tree = await (await fetch(`${notes}/tree`)).json() as { children: NotesTreeNode[] }
    expect(tree.children[0]?.children?.map(node => ({ kind: node.kind, path: node.path }))).toEqual(expect.arrayContaining([
      { kind, path }, { kind, path: copyPath },
    ]))
    expect(await ctx.fileLibrary.noteRecords()).toEqual([])
    expect((await fetch(`${office}/read?path=missing.coding${kind}`)).status).toBe(404)
    expect((await fetch(`${office}/export?path=missing.coding${kind}`)).status).toBe(404)
    expect((await post(`${office}/save`, { ...write, path: `missing.coding${kind}` })).status).toBe(404)
    expect((await readdir(join(ctx.fileLibrary.notesRootPath(), folder))).sort()).toEqual([path, copyPath].map(value => value.split('/').at(-1)).sort())
  })

  it('文件列表按 XLSX 文件名或媒体类型将入库导出分为文档', async () => {
    const { ctx, origin } = await boot()
    const { path } = await ctx.fileLibrary.createNoteOffice('excel', '表格')
    expect(await ctx.fileLibrary.noteRecords()).toEqual([])
    const { bytes, mediaType } = await ctx.fileLibrary.exportNoteOffice(path)
    await ctx.fileLibrary.saveExport({ sessionId: '一', name: '统计.xlsx', mediaType: 'application/octet-stream', data: bytes })
    await ctx.fileLibrary.saveExport({ sessionId: '一', name: '统计 无后缀', mediaType, data: bytes })
    const upload = await ctx.fileLibrary.saveUpload({
      name: '原稿.xlsx', sessionId: '一', stream: (async function* () { yield bytes })(), verify: async () => {},
    })
    expect(upload.record.mediaType).toBe(mediaType)
    const response = await fetch(`${origin}/api/files/list?category=document&kind=export`)
    expect(response.status).toBe(200)
    const page = await response.json() as ManagedFilePage
    expect(page.total).toBe(2)
    expect(page.items.map(item => item.name).sort()).toEqual(['统计 无后缀', '统计.xlsx'])
  })

  it('Office 请求拒绝畸形 ZIP 与分块超限，内部错误不暴露本机路径', async () => {
    const { ctx, origin } = await boot()
    const upload = `${origin}/api/notes/office/import?kind=word&name=bad.docx`
    const headers = { origin, 'content-type': 'application/octet-stream' }
    await ctx.fileLibrary.notesTree()
    expect((await fetch(upload, { method: 'POST', headers, body: new Uint8Array([0x50, 0x4b]) })).status).toBe(400)
    const chunk = new Uint8Array(1024 * 1024)
    let chunks = 0
    const request: RequestInit & { duplex: 'half' } = {
      method: 'POST', headers, duplex: 'half',
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunks++ === 17) controller.close()
          else controller.enqueue(chunk)
        },
      }),
    }
    const response = await fetch(upload, request)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Office 上传超过 16 MiB' })
    const root = ctx.fileLibrary.notesRootPath()
    await expect(readdir(root)).resolves.toEqual([])
    await rm(root, { recursive: true })
    await writeFile(root, '不是笔记目录')
    const unavailable = await fetch(`${origin}/api/notes/office/read?path=missing.codingword`)
    expect(unavailable.status).toBe(500)
    expect(await unavailable.json()).toEqual({ error: '办公笔记暂不可用，请稍后重试' })
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
