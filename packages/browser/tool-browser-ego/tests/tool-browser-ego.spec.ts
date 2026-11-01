import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import LocalAttachmentStore from 'coding-attachment-local'
import { CallId } from 'coding-llm'
import { SessionId } from 'coding-session'
import type { Session, SessionEvent } from 'coding-session'
import SandboxPolicyService, { setSandboxMode } from 'coding-sandbox-policy'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime, { defineTool } from 'coding-tools'
import type { ToolDefinition } from 'coding-tools'
import ApprovalService from 'coding-user-approval'
import * as BrowserTool from '../src/index.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

function fixture(name: string, parameters: Record<string, unknown> = {}): ToolDefinition {
  return defineTool({
    name: `ego_${name}`, description: `Call ego_${name} then ego_snapshot`, parameters: parameters as never,
    output: { schema: { type: 'object', additionalProperties: true,
      properties: { ok: { type: 'boolean', required: true } } },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => ({ ok: true }),
  })
}

class FixtureHost extends Service {
  readonly calls = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'ego_screenshot') {
      await writeFile(args.path as string, PNG)
      return { ok: true, path: args.path }
    }
    if (name === 'ego_download') return { ok: true, path: args.savePath }
    return { ok: true, name, args }
  })
  definitions: ToolDefinition[] = []
  constructor(ctx: Context) { super(ctx, 'egoBrowser') }
  toolDefinitions(): readonly ToolDefinition[] {
    return this.definitions.map(source => ({ ...source,
      execute: args => this.calls(source.name, args as Record<string, unknown>),
    }))
  }
}

const folders: string[] = []
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup(tools: ToolDefinition[], mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'danger-full-access',
  policy: 'ask' | 'never' = 'never', approval = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'ego-tool-'))
  folders.push(cwd)
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(FixtureHost)
  ;(ctx.egoBrowser as unknown as FixtureHost).definitions = tools
  await ctx.plugin(LocalAttachmentStore, { dshHome: cwd })
  await ctx.plugin(SandboxPolicyService, { mode })
  if (approval) await ctx.plugin(ApprovalService, { policy })
  const fiber = await ctx.plugin(BrowserTool)
  const events = [{ type: 'turn/start' }] as unknown as SessionEvent[]
  const session = { id: SessionId('ego-test'), header: { cwd }, events,
    append: vi.fn((type: string, data: unknown) => {
      const event = { type, data } as SessionEvent
      events.push(event)
      return event
    }),
  } as unknown as Session
  const call = (name: string, args: Record<string, unknown> = {}, agent = true, signal = new AbortController().signal) =>
    ctx!.tools.execute({ name: `browser_${name}`, arguments: args, callId: CallId('ego-call'), signal,
      ...agent ? { agent: { session } as never } : {},
    })
  return { ctx, cwd, fiber, session, call, host: ctx.egoBrowser as unknown as FixtureHost }
}

function content(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('Ego browser model tools', () => {
  it('registers only Host-allowed names, keeps schema and removes registrations on dispose', async () => {
    const source = fixture('navigate', { url: { type: 'string', required: true, description: 'Use ego_snapshot' } })
    const { ctx, fiber, call, host } = await setup([source, fixture('script'), fixture('help'), fixture('snapshot')])
    expect(ctx.tools.get('browser_navigate')?.parameters).toMatchObject({ properties: {
      url: { type: 'string', description: 'Use browser_snapshot' },
    } })
    expect(ctx.tools.get('browser_navigate')?.output.schema).toEqual(source.output.schema)
    expect(ctx.tools.get('browser_navigate')?.description).toBe('Call browser_navigate then browser_snapshot')
    expect(ctx.tools.get('browser_script')).toBeUndefined()
    expect(ctx.tools.get('browser_help')).toBeUndefined()
    expect((await call('navigate', { url: 'https://example.com/path?secret=123' })).isError).toBe(false)
    expect(host.calls.mock.calls[0]?.[0]).toBe('ego_navigate')
    await fiber.dispose()
    expect(ctx.tools.get('browser_navigate')).toBeUndefined()
    expect(ctx.tools.get('browser_snapshot')).toBeUndefined()
  })

  it.each([
    ['read-only', 'ask', true], ['read-only', 'never', false],
    ['workspace-write', 'ask', true], ['workspace-write', 'never', false],
    ['danger-full-access', 'ask', true], ['danger-full-access', 'never', false],
  ] as const)('enforces %s sandbox and %s approval on a live call', async (mode, policy, prompt) => {
    const { call, host, ctx } = await setup([fixture('snapshot')], mode, policy)
    const asked = vi.fn(async () => 'allowed-once' as const)
    ctx.on('approval/request', asked)
    const result = await call('snapshot')
    expect(result.isError).toBe(policy === 'never' && mode !== 'danger-full-access')
    expect(asked).toHaveBeenCalledTimes(prompt ? 1 : 0)
    expect(host.calls).toHaveBeenCalledTimes(result.isError ? 0 : 1)
  })

  it('denies missing approval service and agent before Host execution', async () => {
    const { call, host } = await setup([fixture('snapshot')], 'danger-full-access', 'never', false)
    expect(content(await call('snapshot'))).toContain('approval service is unavailable')
    expect(content(await call('snapshot', {}, false))).toContain('calling agent is required')
    expect(host.calls).not.toHaveBeenCalled()
  })

  it('denies remote workspaces before and after an approval without local fallback', async () => {
    const { call, cwd, host, ctx } = await setup([fixture('snapshot')], 'danger-full-access', 'ask')
    const marker = join(cwd, '.coding-remote-workspace.json')
    const writeMarker = () => writeFile(marker, JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'test', generation: 1, mode: 'basic',
    }))
    await writeMarker()
    const asked = vi.fn(async () => 'allowed-once' as const)
    const removeAnswerer = ctx.on('approval/request', asked)
    expect(content(await call('snapshot'))).toContain('remote workspaces')
    expect(asked).not.toHaveBeenCalled()
    await rm(marker)
    removeAnswerer()
    ctx.on('approval/request', async () => { await writeMarker(); return 'allowed-once' as const })
    expect(content(await call('snapshot'))).toContain('remote workspaces')
    expect(host.calls).not.toHaveBeenCalled()
  })

  it('does not call Host after caller cancellation or changed session policy', async () => {
    const { call, host, ctx, session } = await setup([fixture('snapshot')], 'workspace-write', 'ask')
    const controller = new AbortController()
    controller.abort()
    expect((await call('snapshot', {}, true, controller.signal)).isError).toBe(true)
    ctx.on('approval/request', async () => { setSandboxMode(session, 'read-only'); return 'allowed-once' as const })
    expect(content(await call('snapshot'))).toContain('permissions changed')
    expect(host.calls).not.toHaveBeenCalled()
  })

  it('allows a high-risk download script only on full access with a one-call grant', async () => {
    const { call, host, ctx, cwd } = await setup([fixture('download')], 'danger-full-access', 'ask')
    const reasons: string[] = []
    ctx.on('approval/request', ({ reason }) => {
      reasons.push(reason ?? '')
      return Promise.resolve('allowed-once' as const)
    })
    const result = await call('download', { triggerScript: 'fetch("secret")', savePath: 'saved.zip' })
    expect(result.isError).toBe(false)
    expect(host.calls).toHaveBeenCalledOnce()
    expect(host.calls.mock.calls[0]?.[1]).toMatchObject({ savePath: join(await realpath(cwd), 'saved.zip') })
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).not.toMatch(/secret|saved\.zip|fetch/)
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('stops after %s outcome without invoking Host', async (outcome) => {
    const { call, host, ctx } = await setup([fixture('navigate')], 'danger-full-access', 'ask')
    const asked = vi.fn(async (request: { reason?: string }) => {
      expect(request.reason).toContain('origin: https://example.com')
      expect(request.reason).not.toMatch(/secret|path|password/)
      return outcome
    })
    ctx.on('approval/request', asked)
    expect(content(await call('navigate', { url: 'https://example.com/path?secret=password' })))
      .toContain(`approval ${outcome}`)
    expect(asked).toHaveBeenCalledOnce()
    expect(host.calls).not.toHaveBeenCalled()
  })

  it('denies unsafe upload symlinks and passes a real in-workspace file', async () => {
    const { call, cwd, host } = await setup([fixture('upload')])
    await writeFile(join(cwd, 'sample.txt'), 'safe')
    await symlink('/etc/hosts', join(cwd, 'escape.txt'))
    await mkdir(join(cwd, 'folder'))
    for (const path of ['escape.txt', '../outside', 'folder']) {
      expect((await call('upload', { selector: '#file', path })).isError).toBe(true)
    }
    expect(host.calls).not.toHaveBeenCalled()
    expect((await call('upload', { selector: '#file', path: 'sample.txt' })).isError).toBe(false)
    expect(host.calls.mock.calls[0]?.[1]).toMatchObject({ path: join(await realpath(cwd), 'sample.txt') })
  })

  it('denies output escape, existing files, read-only writes and hidden download scripting', async () => {
    const { call, cwd, host, session } = await setup([fixture('download'), fixture('screenshot')])
    await writeFile(join(cwd, 'existing.png'), PNG)
    await symlink('/tmp', join(cwd, 'escape'))
    for (const path of ['../outside.png', 'escape/out.png', 'existing.png', 'folder/']) {
      expect((await call('screenshot', { path })).isError).toBe(true)
      expect((await call('download', { savePath: path })).isError).toBe(true)
    }
    setSandboxMode(session, 'read-only')
    expect((await call('screenshot')).isError).toBe(true)
    setSandboxMode(session, 'workspace-write')
    expect((await call('download', { triggerScript: 'fetch("secret")' })).isError).toBe(true)
    expect(host.calls).not.toHaveBeenCalled()
  })

  it('persists only an explicit screenshot and returns a model image block', async () => {
    const { call, cwd, ctx, host } = await setup([fixture('snapshot'), fixture('screenshot')])
    const save = vi.spyOn(ctx.attachments, 'saveImage')
    expect((await call('snapshot')).content.map(block => block.type)).toEqual(['text'])
    const shot = await call('screenshot', { path: 'screen.png' })
    expect(shot.isError).toBe(false)
    expect(shot.value).toEqual({ ok: true, path: join(await realpath(cwd), 'screen.png') })
    expect(shot.content.map(block => block.type)).toEqual(['text', 'image'])
    expect(save).toHaveBeenCalledOnce()
    expect((await readFile(join(cwd, 'screen.png')))).toEqual(PNG)
    expect(host.calls.mock.calls[1]?.[1]).toMatchObject({ path: join(await realpath(cwd), 'screen.png') })
  })

  it('rejects an oversized structured result without truncating the output schema', async () => {
    const { call, host } = await setup([fixture('snapshot')])
    host.calls.mockResolvedValueOnce({ ok: true, name: 'ego_snapshot', args: { text: 'x'.repeat(70_000) } })
    const result = await call('snapshot')
    expect(result.isError).toBe(true)
    expect(content(result)).toContain('result is too large')
    expect(content(result)).not.toContain('x'.repeat(100))
  })
})
