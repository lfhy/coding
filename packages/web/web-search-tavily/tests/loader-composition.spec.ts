/** 通过真实 Loader 配置入口验证模型可见来源与 fiber 释放。 */
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
import * as Tavily from 'coding-web-search-tavily'
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
  root = await mkdtemp(join(tmpdir(), 'dsh-tavily-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'coding-system-prompt'",
    "- name: 'coding-tools'",
    "- name: 'coding-web'",
    '  config:',
    '    searchProvider: tavily',
    "- name: 'coding-web-search-tavily'",
    '  config:',
    '    apiKey: fixture-key',
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
    ['coding-web-search-tavily', Tavily],
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

describe('Tavily Loader composition', () => {
  it('renders a citeable source through the real tool', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      results: [{ url: 'https://example.com/news', title: 'News', content: 'Current update' }],
      answer: 'private provider answer',
    }))))
    const ctx = await boot()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('tavily-search'),
      name: 'web_search',
      arguments: { queries: ['news'] },
    })
    expect(result.isError).toBe(false)
    const rendered = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(rendered).toContain('[News](https://example.com/news)')
    expect(rendered).toContain('Current update')
    expect(rendered).not.toContain('private provider answer')
  })
})
