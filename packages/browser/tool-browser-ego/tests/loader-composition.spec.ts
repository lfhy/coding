import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LocalAttachmentStore from 'coding-attachment-local'
import { CallId } from 'coding-llm'
import SessionStore, { SessionId } from 'coding-session'
import SandboxPolicy from 'coding-sandbox-policy'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime, { defineTool } from 'coding-tools'
import ApprovalService from 'coding-user-approval'
import * as BrowserTool from '../src/index.ts'

class CompositionHost extends Service {
  readonly calls: { name: string; args: unknown }[] = []
  constructor(ctx: Context) { super(ctx, 'egoBrowser') }
  toolDefinitions() {
    return [defineTool({
      name: 'ego_navigate', description: 'Open a URL before ego_snapshot.',
      parameters: { url: { type: 'string', required: true, description: 'A URL for ego_navigate.' } },
      output: { schema: { type: 'object', additionalProperties: true, properties: {
        ok: { type: 'boolean', required: true },
      } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args) => {
        this.calls.push({ name: 'ego_navigate', args })
        return { ok: true, page: { url: args.url } }
      },
    })]
  }
}

let root: string | undefined
let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'ego-tool-loader-'))
  const file = join(root, 'cordis.yml')
  await writeFile(file, [
    "- name: 'coding-session'",
    "- name: 'coding-system-prompt'",
    "- name: 'coding-tools'",
    "- name: 'coding-browser-ego-host'",
    "- name: 'coding-attachment-local'",
    '  config:',
    `    dshHome: ${JSON.stringify(root)}`,
    "- name: 'coding-user-approval'",
    '  config:',
    '    policy: never',
    "- name: 'coding-sandbox-policy'",
    '  config:',
    '    mode: danger-full-access',
    "- name: 'coding-tool-browser-ego'",
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['coding-session', SessionStore],
    ['coding-system-prompt', SystemPrompt],
    ['coding-tools', ToolRuntime],
    ['coding-browser-ego-host', CompositionHost],
    ['coding-attachment-local', LocalAttachmentStore],
    ['coding-user-approval', ApprovalService],
    ['coding-sandbox-policy', SandboxPolicy],
    ['coding-tool-browser-ego', BrowserTool],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader module: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await context.loader.await()
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  return context
}

describe('Ego browser Loader composition', () => {
  it('exposes renamed schema, executes through the actual registry and keeps audit empty on full access', async () => {
    const ctx = await boot()
    const schema = ctx.tools.schemas().find(item => item.name === 'browser_navigate')
    expect(schema?.description).toContain('browser_snapshot')
    expect(schema?.parameters).toMatchObject({ properties: { url: { description: 'A URL for browser_navigate.' } } })
    const owner = ctx.sessions.create(SessionId('ego-loader'), { meta: { cwd: root as string } })
    owner.append('turn/start', { turn: 1 })
    const result = await ctx.tools.execute({ name: 'browser_navigate', callId: CallId('ego-loader-call'),
      arguments: { url: 'https://example.com/private?token=secret' },
      signal: new AbortController().signal, agent: { session: owner } as never,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ ok: true, page: { url: 'https://example.com/private?token=secret' } })
    expect((ctx.egoBrowser as unknown as CompositionHost).calls).toMatchObject([
      { name: 'ego_navigate', args: { url: 'https://example.com/private?token=secret' } },
    ])
    expect(owner.events.filter(event => event.type === 'approval/asked' || event.type === 'approval/decided')).toEqual([])
  })
})
