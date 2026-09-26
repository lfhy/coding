import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import BrowserUseService from '../../browser/src/index.ts'
import type { BrowserCapture, BrowserCommand } from '../../browser/src/index.ts'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as ToolBrowser from '../src/index.ts'

class FixtureBrowser extends BrowserUseService {
  execute(_id: ReturnType<typeof SessionId>, command: BrowserCommand, signal: AbortSignal): Promise<BrowserCapture> {
    signal.throwIfAborted()
    return Promise.resolve({
      observation: {
        generation: 'fixture-1', revision: 1, url: command.kind === 'navigate' ? command.url : 'about:blank',
        title: 'Fixture', snapshot: '[node-1] button Continue',
        viewport: { width: 800, height: 600 }, cursor: null,
      },
      png: null,
    })
  }
  latest(): BrowserCapture | undefined { return undefined }
  closeSession(): Promise<void> { return Promise.resolve() }
}

let root: string | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('browser_use through a real Loader composition', () => {
  it('loads tool dependencies and returns an approved model-visible observation', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-browser-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      '  config:',
      '    mode: native',
      "- name: '@deepseek-ai/dsh-browser'",
      "- name: '@deepseek-ai/dsh-attachment-local'",
      '  config:',
      `    dshHome: ${JSON.stringify(root)}`,
      "- name: '@deepseek-ai/dsh-user-approval'",
      "- name: '@deepseek-ai/dsh-tool-browser'",
      '',
    ].join('\n'))

    ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-browser', FixtureBrowser],
      ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
      ['@deepseek-ai/dsh-user-approval', ApprovalService],
      ['@deepseek-ai/dsh-tool-browser', ToolBrowser],
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
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])

    const reasons: string[] = []
    ctx.on('approval/request', (req) => {
      reasons.push(req.reason ?? '')
      return Promise.resolve('allowed-once' as const)
    })
    const agent = {
      session: {
        id: SessionId('loader-browser'), header: { cwd: root },
        events: [{ type: 'turn/start' }, { type: 'user/message' }], append: () => ({}),
      },
    }
    const result = await ctx.tools.execute({
      name: 'browser_use', callId: CallId('loader-browser-call'),
      arguments: { action: 'navigate', url: 'https://example.com/private?token=secret' },
      signal: new AbortController().signal, agent: agent as never,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      action: 'navigate', observation: { url: 'https://example.com/private?token=secret', snapshot: '[node-1] button Continue' }, image: null,
    })
    expect(result.content).toMatchObject([{ type: 'text' }])
    expect(reasons).toEqual(['Browser navigate (target origin: https://example.com; may redirect or load subresources; approval is for this call only)'])
  })
})
