/** 通过真实 Loader、SQLite 与 WebServer 验证文件列表路由的产品装配。 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Storage from 'coding-storage'
import * as StorageDomain from 'coding-storage-domain'
import * as Sqlite from 'coding-storage-sqlite'
import WebServer from 'coding-host-webserver'
import FileLibrary from '../src/index.ts'

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('file library real composition', () => {
  it('boots SQLite metadata, exposes an authenticated list, and releases the route on disposal', async () => {
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
      '- name: coding-file-library',
      `  config: ${JSON.stringify({ root: join(dir, 'files') })}`,
      '',
    ].join('\n'))
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = `${pathToFileURL(dir).href}/`
    let denied = false
    ctx.provide('connection', { requestRejection: () => denied ? 403 : undefined } as never)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['coding-storage', Storage], ['coding-storage-sqlite', Sqlite],
      ['coding-storage-domain', StorageDomain], ['coding-host-webserver', WebServer],
      ['coding-file-library', FileLibrary],
    ])
    ctx.loader.internal = { version: 'v2', import: async (name: string) => {
      if (!modules.has(name)) throw new Error(`unexpected module ${name}`)
      return modules.get(name)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])

    const result = await ctx.fileLibrary.saveUpload({
      name: 'app.txt', sessionId: 'one',
      stream: (async function* () { yield Buffer.from('hello') })(), verify: async () => {},
    })
    const url = `http://127.0.0.1:${ctx.webServer.port}/api/files/list`
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ total: 1, items: [{ id: result.record.id, name: 'app.txt' }] })
    denied = true
    expect((await fetch(url)).status).toBe(403)
    denied = false
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
  })
})
