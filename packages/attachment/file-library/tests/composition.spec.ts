/** 通过真实 Loader、SQLite、Connection 与 WebServer 验证文件库路由。 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Storage from 'coding-storage'
import * as StorageDomain from 'coding-storage-domain'
import * as Sqlite from 'coding-storage-sqlite'
import WebServer from 'coding-host-webserver'
import * as Connection from 'coding-client-connection'
import FileLibrary from '../src/index.ts'

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
})
