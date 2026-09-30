import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import BrowserUseService from '../../browser/src/index.ts'
import type { BrowserCapture, BrowserCommand, BrowserHumanCommand, BrowserSessionState, BrowserTabId } from '../../browser/src/index.ts'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import * as ToolBrowser from '../src/index.ts'

class FixtureBrowser extends BrowserUseService {
  readonly calls: { sessionId: ReturnType<typeof SessionId>; command: BrowserCommand }[] = []

  execute(id: ReturnType<typeof SessionId>, command: BrowserCommand, signal: AbortSignal): Promise<BrowserCapture> {
    signal.throwIfAborted()
    this.calls.push({ sessionId: id, command })
    return Promise.resolve({
      observation: {
        tabId: 'fixture-tab' as BrowserTabId, generation: 'fixture-1', revision: 1,
        url: command.kind === 'navigate' ? command.url : 'about:blank',
        title: 'Fixture', snapshot: '[node-1] button Continue',
        viewport: { width: 800, height: 600 }, cursor: null,
      },
      png: null,
    })
  }
  state(): BrowserSessionState | undefined { return undefined }
  control(_id: ReturnType<typeof SessionId>, _command: BrowserHumanCommand,
    _signal: AbortSignal): Promise<BrowserSessionState | undefined> {
    return Promise.resolve(undefined)
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

async function boot(options: { sandboxMode?: SandboxPolicy['defaultMode']; approvalPolicy?: ApprovalPolicy } = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-browser-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    '  config:',
    '    mode: native',
    "- name: '@deepseek-ai/dsh-browser'",
    "- name: '@deepseek-ai/dsh-attachment-local'",
    '  config:',
    `    dshHome: ${JSON.stringify(root)}`,
    "- name: '@deepseek-ai/dsh-user-approval'",
    ...options.approvalPolicy === undefined ? [] : ['  config:', `    policy: ${options.approvalPolicy}`],
    ...options.sandboxMode === undefined ? [] : [
      "- name: '@deepseek-ai/dsh-sandbox-policy'",
      '  config:',
      `    mode: ${options.sandboxMode}`,
    ],
    "- name: '@deepseek-ai/dsh-tool-browser'",
    '',
  ].join('\n'))

  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-browser', FixtureBrowser],
    ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
    ['@deepseek-ai/dsh-user-approval', ApprovalService],
    ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicy],
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
  return ctx
}

function session(context: Context): Session {
  const value = context.sessions.create(SessionId('loader-browser'), { meta: { cwd: root as string } })
  value.append('turn/start', { turn: 1 })
  return value
}

function execute(context: Context, owner: Session) {
  return context.tools.execute({
    name: 'browser_use', callId: CallId('loader-browser-call'),
    arguments: { action: 'navigate', url: 'https://example.com/private?token=secret' },
    signal: new AbortController().signal, agent: { session: owner } as never,
  })
}

function approvalAudit(owner: Session) {
  return owner.events.filter(event => event.type === 'approval/asked' || event.type === 'approval/decided')
}

function expectObservation(result: Awaited<ReturnType<typeof execute>>): void {
  expect(result.isError).toBe(false)
  expect(result.value).toMatchObject({
    action: 'navigate', observation: { tabId: 'fixture-tab', url: 'https://example.com/private?token=secret', snapshot: '[node-1] button Continue' }, image: null,
  })
  expect(result.content).toMatchObject([{ type: 'text' }])
}

describe('browser_use through a real Loader composition', () => {
  it('loads tool dependencies and returns an approved model-visible observation without sandbox policy', async () => {
    const context = await boot()
    const owner = session(context)

    const reasons: string[] = []
    context.on('approval/request', (req) => {
      reasons.push(req.reason ?? '')
      return Promise.resolve('allowed-once' as const)
    })
    expectObservation(await execute(context, owner))
    expect(reasons).toEqual(['Browser navigate (target origin: https://example.com; may redirect or load subresources; approval is for this call only)'])
    expect(approvalAudit(owner)).toMatchObject([
      { type: 'approval/asked', data: { toolName: 'browser_use', callId: 'loader-browser-call', reason: reasons[0] } },
      { type: 'approval/decided', data: { outcome: 'allowed-once' } },
    ])
    expect(approvalAudit(owner)[1]?.data.id).toBe(approvalAudit(owner)[0]?.data.id)
  })

  it('executes full-access composition defaults without an answerer or approval audit', async () => {
    const context = await boot({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' })
    const owner = session(context)

    expectObservation(await execute(context, owner))
    expect(approvalAudit(owner)).toEqual([])
    expect((context.browserUse as FixtureBrowser).calls).toEqual([
      { sessionId: owner.id, command: { kind: 'navigate', url: 'https://example.com/private?token=secret' } },
    ])
  })

  it('uses the calling session full-access pair over restrictive composition defaults', async () => {
    const context = await boot({ sandboxMode: 'workspace-write', approvalPolicy: 'ask' })
    const owner = session(context)
    setSandboxMode(owner, 'danger-full-access')
    setApprovalPolicy(owner, 'never')

    expectObservation(await execute(context, owner))
    expect(approvalAudit(owner)).toEqual([])
    expect((context.browserUse as FixtureBrowser).calls).toHaveLength(1)
  })

  it.each([
    { sandboxMode: 'workspace-write', approvalPolicy: 'ask', outcome: 'unavailable' },
    { sandboxMode: 'workspace-write', approvalPolicy: 'never', outcome: 'rejected' },
    { sandboxMode: 'danger-full-access', approvalPolicy: 'ask', outcome: 'unavailable' },
  ] as const)('keeps session $sandboxMode + $approvalPolicy approval-gated over full-access defaults', async ({ sandboxMode, approvalPolicy, outcome }) => {
    const context = await boot({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' })
    const owner = session(context)
    setSandboxMode(owner, sandboxMode)
    setApprovalPolicy(owner, approvalPolicy)

    const result = await execute(context, owner)
    expect(result.isError).toBe(true)
    expect(result.content).toMatchObject([{ type: 'text' }])
    const block = result.content[0]
    expect(block?.type === 'text' ? block.text : '').toContain(`browser_use: approval ${outcome}`)
    expect((context.browserUse as FixtureBrowser).calls).toEqual([])
    expect(approvalAudit(owner)).toMatchObject([
      { type: 'approval/asked', data: { toolName: 'browser_use' } },
      { type: 'approval/decided', data: { outcome } },
    ])
  })
})
