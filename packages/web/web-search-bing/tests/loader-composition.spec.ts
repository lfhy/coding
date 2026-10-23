/** 以真实 Loader 组合验证匿名 Bing 搜索的模型可见工具结果与显式后端选择。 */
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
import * as Bing from 'coding-web-search-bing'
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
  root = await mkdtemp(join(tmpdir(), 'dsh-bing-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'coding-system-prompt'",
    "- name: 'coding-tools'",
    "- name: 'coding-web'",
    '  config:',
    '    searchProvider: bing',
    "- name: 'coding-web-search-bing'",
    '  config:',
    '    market: zh-CN',
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
    ['coding-web-search-bing', Bing],
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

describe('Bing real Loader composition', () => {
  it('returns a citeable model-visible result without any search credential', async () => {
    const fetchMock = vi.fn(async () => new Response(
      '<ol><li class="b_algo"><h2><a href="https://example.com/news">News</a></h2><p>Current update</p></li></ol>',
      { headers: { 'content-type': 'text/html' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = await boot()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('anonymous-search'),
      name: 'web_search',
      arguments: { queries: ['example news'] },
    })
    expect(result.isError).toBe(false)
    expect(result.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toContain('[News](https://example.com/news)')
    // 组合层的 market 配置要透传到 mkt 查询参数。
    expect(String((fetchMock.mock.calls[0] as unknown as [URL])[0])).toBe('https://www.bing.com/search?q=example+news&mkt=zh-CN')
  })
})
