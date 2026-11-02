import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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

/** 生成与上游同形的 fixture 定义；执行由 FixtureHost 统一接管。 */
function fixture(name: string, parameters: Record<string, unknown> = {}): ToolDefinition {
  return defineTool({
    name: `ego_${name}`, description: `Call ego_${name} then ego_snapshot`,
    parameters: parameters as never,
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

const ALL = ['status', 'auth_flush', 'login_import', 'space_open', 'space_close', 'snapshot', 'navigate', 'click',
  'fill', 'js', 'cdp', 'screenshot', 'page_info', 'tabs', 'wait', 'wait_for_selector', 'wait_for_url',
  'wait_for_response', 'key', 'hover', 'read_element', 'select', 'drag', 'scroll', 'upload', 'download',
  'check', 'dialog', 'http', 'cli', 'captcha', 'wait_for_human', 'help', 'doctor', 'script'] as const

describe('Ego browser model tools', () => {
  it('registers the full Host tool set with browser names and rewrites help text', async () => {
    const { ctx, fiber, host } = await setup(ALL.map(name => fixture(name, {
      url: { type: 'string', required: true, description: 'Use ego_snapshot' },
    })))
    expect(ctx.tools.schemas().map(schema => schema.name).sort())
      .toEqual(ALL.map(name => `browser_${name}`).sort())
    expect(ctx.tools.get('browser_navigate')?.parameters).toMatchObject({
      properties: { url: { type: 'string', description: 'Use browser_snapshot' } },
    })
    expect(ctx.tools.get('browser_navigate')?.description).toBe('Call browser_navigate then browser_snapshot')
    expect(await ctx.tools.execute({ name: 'browser_cli', arguments: {}, callId: CallId('x'),
      signal: new AbortController().signal, agent: undefined as never })).toMatchObject({ isError: true })
    expect(host.calls).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(ctx.tools.get('browser_navigate')).toBeUndefined()
    expect(ctx.tools.get('browser_script')).toBeUndefined()
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

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('stops after %s outcome without invoking Host', async (outcome) => {
    const { call, host, ctx } = await setup([fixture('navigate')], 'danger-full-access', 'ask')
    const asked = vi.fn(async (request: { reason?: string }) => {
      expect(request.reason).toContain('origin: https://example.com')
      expect(request.reason).not.toMatch(/secret|password|path/)
      return outcome
    })
    ctx.on('approval/request', asked)
    expect(content(await call('navigate', { url: 'https://example.com/path?secret=password' })))
      .toContain(`approval ${outcome}`)
    expect(asked).toHaveBeenCalledOnce()
    expect(host.calls).not.toHaveBeenCalled()
  })

  it('passes complete upstream arguments, including scripts and file paths, unchanged', async () => {
    const { call, host, cwd, ctx } = await setup([fixture('download'), fixture('upload'), fixture('script')])
    ctx.on('approval/request', async () => 'allowed-once' as const)
    const savePath = join(await realpath(cwd), 'saved.zip')
    expect((await call('download', { triggerScript: 'fetch("x")', savePath })).isError).toBe(false)
    expect(host.calls.mock.calls[0]?.[1]).toMatchObject({ triggerScript: 'fetch("x")', savePath })
    expect((await call('upload', { selector: '#file', path: join(cwd, 'sample.txt') })).isError).toBe(false)
    expect((await call('script', { code: 'await page.info()' })).isError).toBe(false)
    expect(host.calls).toHaveBeenCalledTimes(3)
  })

  it('persists only an explicit screenshot and returns a model image block', async () => {
    const { call, cwd, ctx, host } = await setup([fixture('snapshot'), fixture('screenshot')])
    const save = vi.spyOn(ctx.attachments, 'saveImage')
    expect((await call('snapshot')).content.map(block => block.type)).toEqual(['text'])
    const path = join(await realpath(cwd), 'screen.png')
    const shot = await call('screenshot', { path })
    expect(shot.isError).toBe(false)
    expect(shot.value).toEqual({ ok: true, path })
    expect(shot.content.map(block => block.type)).toEqual(['text', 'image'])
    expect(save).toHaveBeenCalledOnce()
    expect(await readFile(path)).toEqual(PNG)
    expect(host.calls.mock.calls[1]?.[1]).toMatchObject({ path })
  })

  it('rejects an oversized structured result without truncating the output schema', async () => {
    const { call, host } = await setup([fixture('snapshot')])
    host.calls.mockResolvedValueOnce({ ok: true, name: 'ego_snapshot', args: { text: 'x'.repeat(70_000) } })
    const result = await call('snapshot')
    expect(result.isError).toBe(true)
    expect(content(result)).toContain('result is too large')
    expect(content(result)).not.toContain('x'.repeat(100))
  })

  it('reports the upstream failure reason so the model can correct itself', async () => {
    const { call, host } = await setup([fixture('tabs')])
    host.calls.mockRejectedValueOnce(new Error('targetId deadbeef is not open in this task space\n(open ids: abc)'))
    const result = await call('tabs', { action: 'switch', targetId: 'deadbeef' })
    expect(result.isError).toBe(true)
    expect(content(result)).toContain('browser_tabs: browser operation failed')
    expect(content(result)).toContain('targetId deadbeef is not open in this task space (open ids: abc)')
  })

  it('keeps the failure reason bounded and single-line', async () => {
    const { call, host } = await setup([fixture('click')])
    host.calls.mockRejectedValueOnce(new Error(`selector failed${'\nline'.repeat(200)}`))
    const result = await call('click', { selector: 'button' })
    expect(result.isError).toBe(true)
    const text = content(result)
    expect(text).toContain('browser_click: browser operation failed: selector failed line line')
    expect(text).not.toContain('\nline\nline')
    expect(text.length).toBeLessThanOrEqual(400)
  })
})
