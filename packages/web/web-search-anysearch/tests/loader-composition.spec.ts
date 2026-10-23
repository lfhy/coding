/** 以真实 Loader 组合验证 AnySearch 搜索的模型可见工具结果，以及密钥被拒后的匿名降级诊断。 */
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
import * as AnySearch from 'coding-web-search-anysearch'
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
  root = await mkdtemp(join(tmpdir(), 'dsh-anysearch-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'coding-system-prompt'",
    "- name: 'coding-tools'",
    "- name: 'coding-web'",
    '  config:',
    '    searchProvider: anysearch',
    "- name: 'coding-web-search-anysearch'",
    '  config:',
    '    apiKey: loader-key',
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
    ['coding-web-search-anysearch', AnySearch],
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

describe('AnySearch real Loader composition', () => {
  it('returns a citeable result and explains the anonymous fallback after a rejected key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"code":401}', { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValue(new Response(
        JSON.stringify({ code: 0, data: { results: [{ url: 'https://example.com/news', title: 'News', snippet: 'Current update' }] } }),
        { headers: { 'content-type': 'application/json' } },
      ))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = await boot()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('anysearch-search'),
      name: 'web_search',
      arguments: { queries: ['anysearch news'] },
    })
    expect(result.isError).toBe(false)
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toContain('- [News](https://example.com/news)')
    expect(text).toContain('anonymous free tier')
    const first = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(first[0]).toBe('https://api.anysearch.com/v1/search')
    expect((first[1].headers as Record<string, string>).authorization).toBe('Bearer loader-key')
    expect((second[1].headers as Record<string, string>).authorization).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
