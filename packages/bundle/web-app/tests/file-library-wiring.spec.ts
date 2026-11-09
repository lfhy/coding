import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadCordisYaml } from '../../../../scripts/cordis-yaml.ts'
import Storage from '../../../storage/storage/src/index.ts'
import * as JsonStorage from '../../../storage/storage-json/src/index.ts'
import * as SqliteStorage from '../../../storage/storage-sqlite/src/index.ts'
import * as StorageDomain from '../../../storage/storage-domain/src/index.ts'
import FileLibrary from '../../../attachment/file-library/src/index.ts'

const bundleRoot = fileURLToPath(new URL('..', import.meta.url))

interface Row {
  id: string
  name: string
  config?: Record<string, unknown>
}

function webRows(): Row[] {
  const patch = loadCordisYaml(readFileSync(resolve(bundleRoot, 'cordis.patch.yml'), 'utf8')) as { insert?: Row[] }[]
  return patch.flatMap(entry => entry.insert ?? [])
}

describe('Web 文件库装配', () => {
  it('将 files 领域单独路由到 SQLite 并保留其他领域的 JSON 默认值', () => {
    const rows = webRows()
    expect(rows.find(row => row.id === 'storage-sqlite')).toEqual({
      id: 'storage-sqlite',
      name: 'coding-storage-sqlite',
      config: { path: { __jsExpr: "dshHomePath('files.sqlite')" } },
    })
    expect(rows.find(row => row.id === 'storage-domain')).toEqual({
      id: 'storage-domain',
      name: 'coding-storage-domain',
      config: { backend: 'json', routes: { files: 'sqlite' } },
    })
    expect(rows.findIndex(row => row.id === 'storage-sqlite')).toBeLessThan(
      rows.findIndex(row => row.id === 'storage-domain'),
    )
  })

  it('在宿主消费者前挂载文件库，并把文件设置页加入浏览器插件名录', () => {
    const rows = webRows()
    const index = (id: string) => rows.findIndex(row => row.id === id)
    expect(rows.filter(row => row.id === 'file-library')).toEqual([
      { id: 'file-library', name: 'coding-file-library' },
    ])
    expect(index('file-library')).toBeGreaterThan(index('storage-domain'))
    expect(index('file-library')).toBeLessThan(index('open-in-app'))
    expect(index('file-library')).toBeLessThan(index('image-generation'))
    expect(rows.filter(row => row.id === 'ui-files')).toEqual([
      { id: 'ui-files', name: 'coding-client-ui-files' },
    ])
    expect(index('ui-files')).toBeGreaterThan(index('ui-settings'))
  })

  it('通过真实 Loader 装配持久文件库，并在重启后恢复列表', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-web-files-'))
    const configPath = join(root, 'cordis.yml')
    writeFileSync(configPath, '[]\n')
    const modules = new Map<string, unknown>([
      ['coding-storage', Storage],
      ['coding-storage-json', JsonStorage],
      ['coding-storage-sqlite', SqliteStorage],
      ['coding-storage-domain', StorageDomain],
      ['coding-file-library', FileLibrary],
    ])
    const ids = ['storage', 'storage-json', 'storage-sqlite', 'storage-domain', 'file-library']
    const rows = ids.map((id) => {
      const source = webRows().find(row => row.id === id)
      if (source === undefined) throw new Error(`Web patch 缺少 ${id}`)
      if (id === 'storage-json') return { ...source, config: { root: join(root, 'json') } }
      if (id === 'storage-sqlite') return { ...source, config: { path: join(root, 'files.sqlite') } }
      if (id === 'file-library') return { ...source, config: { root: join(root, 'files') } }
      return source
    })

    // 只将部署路径表达式定向到临时目录；插件包、行顺序与领域路由取自正式 patch。
    const boot = async (): Promise<Context> => {
      const ctx = new Context()
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      ctx.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
      await ctx.loader.create({
        name: 'cordis:include',
        config: { path: pathToFileURL(configPath).href, patches: [{ insert: rows }] },
      })
      await ctx.loader.await()
      return ctx
    }

    try {
      const first = await boot()
      let recordId: string
      try {
        const record = await first.fileLibrary.saveGeneratedImage({
          sessionId: 'session-1', attachmentId: 'image-1', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]),
        })
        recordId = record.id
        expect(first.fileLibrary.list()).toMatchObject({
          total: 1,
          items: [{ id: recordId, kind: 'generated-image', sessionId: 'session-1', bytes: 3 }],
        })
      } finally {
        await first.fiber.dispose()
      }

      const second = await boot()
      try {
        expect(second.fileLibrary.list()).toMatchObject({
          total: 1,
          items: [{ id: recordId, kind: 'generated-image', sessionId: 'session-1', bytes: 3 }],
        })
      } finally {
        await second.fiber.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
