/** 以真实 Loader 组合验证 Firecrawl 搜索的模型可见工具结果、组合配置透传与 keyless 请求不带凭据。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from 'coding-llm'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime from 'coding-tools'
import WebRuntime from 'coding-web'
import * as Firecrawl from '../src/index.ts'
import * as ToolWeb from 'coding-tool-web'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-firecrawl-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'coding-system-prompt'",
    "- name: 'coding-tools'",
    "- name: 'coding-web'",
    '  config:',
    '    searchProvider: firecrawl',
    "- name: 'coding-web-search-firecrawl'",
    '  config:',
    '    baseURL: https://firecrawl.entry.test',
    "- name: 'coding-tool-web'",
    '  config:',
    '    fetch: false',
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['coding-system-prompt', SystemPrompt],
    ['coding-tools', ToolRuntime],
    ['coding-web', WebRuntime],
    ['coding-web-search-firecrawl', Firecrawl],
    ['coding-tool-web', ToolWeb],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('Firecrawl real Loader composition', () => {
  it('returns a citeable model-visible result from the keyless tier', async () => {
    const previous = process.env.FIRECRAWL_API_KEY
    delete process.env.FIRECRAWL_API_KEY
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: true, data: { web: [{ url: 'https://example.com/news', title: 'News', description: 'Current update' }] } }),
      { headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const ctx = await boot()
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('firecrawl-search'),
        name: 'web_search',
        arguments: { queries: ['example news'] },
      })
      expect(result.isError).toBe(false)
      expect(result.content.filter(block => block.type === 'text').map(block => block.text).join(''))
        .toContain('[News](https://example.com/news)')
      // 组合层的 baseURL 要透传到请求端点，keyless 请求不带凭据。
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://firecrawl.entry.test/v2/search')
      expect(init.headers as Record<string, string>).not.toHaveProperty('authorization')
    } finally {
      if (previous === undefined) delete process.env.FIRECRAWL_API_KEY
      else process.env.FIRECRAWL_API_KEY = previous
    }
  })
})
