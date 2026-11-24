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

type FixtureHostResult =
  | { ok: true; path: string }
  | { ok: true; name: string; args: Record<string, unknown> }
  | { ok: false; error: string }

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
  /** 没有落点时模拟上游自己的临时文件，路径同样回给调用方。 */
  private shots = 0
  readonly calls = vi.fn<(name: string, args: Record<string, unknown>) => Promise<FixtureHostResult>>(
    async (name: string, args: Record<string, unknown>) => {
      if (name === 'ego_screenshot') {
        const path = typeof args.path === 'string' ? args.path : join(tmpdir(), `ego-shot-${++this.shots}.png`)
        await writeFile(path, PNG)
        return { ok: true, path }
      }
      return { ok: true, name, args }
    },
  )
  definitions: ToolDefinition[] = []
  /** 视口请求由宿主执行；这里只记录参数，并回一份实测结果。 */
  readonly viewports = vi.fn(async (options: { sessionId: string; input: Record<string, unknown> }) => ({
    ok: true as const,
    width: typeof options.input.width === 'number' ? options.input.width : 1280,
    height: typeof options.input.height === 'number' ? options.input.height : 800,
    devicePixelRatio: 1,
  }))
  constructor(ctx: Context) { super(ctx, 'egoBrowser') }
  toolDefinitions(): readonly ToolDefinition[] {
    return this.definitions.map(source => ({ ...source,
      execute: args => this.calls(source.name, args as Record<string, unknown>),
    }))
  }
  emulateViewport(options: { sessionId: string; input: Record<string, unknown> }) {
    return this.viewports(options)
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
      .toEqual([...ALL.map(name => `browser_${name}`), 'browser_viewport'].sort())
    expect(ctx.tools.get('browser_navigate')?.parameters).toMatchObject({
      properties: { url: { type: 'string', description: 'Use browser_snapshot' } },
    })
    expect(ctx.tools.get('browser_navigate')?.description).toBe('Call browser_navigate then browser_snapshot')
    // 视口工具是本包自定义的一等入口：说明要写清覆盖范围与先调尺寸再截图。
    expect(ctx.tools.get('browser_viewport')?.description).toContain('responsive or mobile layout')
    expect(ctx.tools.get('browser_viewport')?.parameters).toMatchObject({
      properties: { width: { type: 'integer' }, height: { type: 'integer' }, reset: { type: 'boolean' } },
    })
    expect(await ctx.tools.execute({ name: 'browser_cli', arguments: {}, callId: CallId('x'),
      signal: new AbortController().signal, agent: undefined as never })).toMatchObject({ isError: true })
    expect(host.calls).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(ctx.tools.get('browser_navigate')).toBeUndefined()
    expect(ctx.tools.get('browser_script')).toBeUndefined()
    expect(ctx.tools.get('browser_viewport')).toBeUndefined()
  })

  it('describes only this session’s pages without changing browser argument shapes', async () => {
    const tools = ['page_info', 'snapshot', 'tabs', 'captcha', 'wait_for_human'].map(name => fixture(name, {
      space: { type: 'string', description: 'Use the global default task space.' },
    }))
    const { ctx, call, host } = await setup([...tools,
      fixture('space_open', { name: { type: 'string', required: true, description: 'Use default.' } }),
      fixture('space_close', { name: { type: 'string', required: true, description: 'Use default.' } }),
    ])
    for (const name of ['page_info', 'snapshot', 'tabs', 'captcha', 'wait_for_human']) {
      const schema = ctx.tools.get(`browser_${name}`)?.parameters
      expect(schema).toMatchObject({ properties: { space: { type: 'string' } } })
      const properties = schema?.properties as Record<string, { description?: string }>
      expect(properties.space?.description).toContain('this session')
      expect(schema).not.toMatchObject({ required: ['space'] })
      expect((await call(name, { space: 'default' })).isError).toBe(false)
    }
    for (const name of ['space_open', 'space_close']) {
      const tool = ctx.tools.get(`browser_${name}`)
      expect(tool?.description).toContain('this session')
      expect(tool?.parameters).toMatchObject({ required: ['name'], properties: { name: { type: 'string' } } })
      const properties = tool?.parameters.properties as Record<string, { description?: string }>
      expect(properties.name?.description).toContain('this session')
    }
    expect(host.calls).toHaveBeenCalledTimes(5)
  })

  it('emulates a viewport through approval and the Host service', async () => {
    const { call, host, ctx } = await setup([fixture('snapshot')], 'danger-full-access', 'ask')
    const asked = vi.fn(async (request: { reason?: string }) => {
      // 审批理由要说明这一页将被渲染成什么形状，不能只说「浏览器操作」。
      expect(request.reason).toContain('390×844')
      return 'allowed-once' as const
    })
    ctx.on('approval/request', asked)
    const result = await call('viewport', { width: 390, height: 844, mobile: true })
    expect(result.isError).toBe(false)
    expect(content(result)).toContain('"width":390')
    expect(asked).toHaveBeenCalledOnce()
    expect(host.viewports).toHaveBeenCalledWith({
      sessionId: SessionId('ego-test'), input: { width: 390, height: 844, mobile: true },
    })
    // 视口走宿主方法，不借用上游工具名执行，也不产生额外调用记录。
    expect(host.calls).not.toHaveBeenCalled()
  })

  it('rejects malformed viewport arguments before the Host runs', async () => {
    const { call, host } = await setup([fixture('snapshot')])
    const result = await call('viewport', { width: 'wide', height: 844 })
    expect(result.isError).toBe(true)
    expect(content(result)).toContain('invalid arguments')
    expect(host.viewports).not.toHaveBeenCalled()
  })

  it('reports Host-side viewport reasons without the generic operation prefix', async () => {
    const { call, host } = await setup([fixture('snapshot')])
    host.viewports.mockRejectedValueOnce(new Error('width must be an integer between 200 and 3840'))
    const result = await call('viewport', { width: 390, height: 844 })
    expect(result.isError).toBe(true)
    expect(content(result)).toContain('browser_viewport: width must be an integer between 200 and 3840')
    expect(content(result)).not.toContain('browser operation failed')
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

  it('keeps page operations available in a remote workspace', async () => {
    const { call, cwd, host } = await setup([
      fixture('snapshot'), fixture('navigate', { url: { type: 'string', required: true } }),
    ], 'danger-full-access', 'never')
    await writeFile(join(cwd, '.coding-remote-workspace.json'), JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'test', generation: 1, mode: 'basic',
    }))
    expect((await call('snapshot')).isError).toBe(false)
    expect((await call('navigate', { url: 'https://example.com/' })).isError).toBe(false)
    expect(host.calls.mock.calls.map(([name]) => name)).toEqual(['ego_snapshot', 'ego_navigate'])
  })

  it('refuses Host-local files from a remote workspace before and after an approval', async () => {
    const { call, cwd, host, ctx } = await setup([
      fixture('upload'), fixture('download'), fixture('navigate', { url: { type: 'string', required: true } }),
    ], 'danger-full-access', 'ask')
    const marker = join(cwd, '.coding-remote-workspace.json')
    const writeMarker = () => writeFile(marker, JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'test', generation: 1, mode: 'basic',
    }))
    const refused = 'remote workspaces cannot read or write local files'
    await writeMarker()
    const asked = vi.fn(async () => 'allowed-once' as const)
    const removeAnswerer = ctx.on('approval/request', asked)
    for (const [name, args] of [['upload', { path: '/tmp/a.png' }], ['download', { savePath: '/tmp/a.png' }],
      ['navigate', { url: 'file:///etc/passwd' }]] as const) {
      expect(content(await call(name, args))).toContain(refused)
    }
    expect(asked).not.toHaveBeenCalled()
    await rm(marker)
    removeAnswerer()
    await writeFile(join(cwd, 'sample.txt'), 'hello')
    ctx.on('approval/request', async () => { await writeMarker(); return 'allowed-once' as const })
    expect(content(await call('upload', { path: 'sample.txt' }))).toContain(refused)
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

  it('resolves upload and download paths inside the session workspace', async () => {
    const { call, host, cwd, ctx } = await setup([fixture('download'), fixture('upload'), fixture('script')])
    ctx.on('approval/request', async () => 'allowed-once' as const)
    const root = await realpath(cwd)
    const savePath = join(root, 'saved.zip')
    expect((await call('download', { triggerScript: 'fetch("x")', savePath })).isError).toBe(false)
    expect(host.calls.mock.calls[0]?.[1]).toMatchObject({ triggerScript: 'fetch("x")', savePath })
    await writeFile(join(cwd, 'sample.txt'), 'hello')
    expect((await call('upload', { selector: '#file', path: 'sample.txt' })).isError).toBe(false)
    expect(host.calls.mock.calls[1]?.[1]).toMatchObject({ selector: '#file', path: join(root, 'sample.txt') })
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

  it('writes a relative screenshot path into the session workspace and reports it absolute', async () => {
    const { call, cwd } = await setup([fixture('screenshot')])
    const root = await realpath(cwd)
    const shot = await call('screenshot', { path: 'artifacts/preview-light.png' })
    expect(content(shot)).toContain('output directory is unavailable')
    const flat = await call('screenshot', { path: 'preview-light.png' })
    expect(flat.isError).toBe(false)
    expect(flat.value).toEqual({ ok: true, path: join(root, 'preview-light.png') })
    expect(flat.content.map(block => block.type)).toEqual(['text', 'image'])
    expect(await readFile(join(root, 'preview-light.png'))).toEqual(PNG)
  })

  it('saves each screenshot under a new workspace name when no path is given', async () => {
    const { call, cwd, host } = await setup([fixture('screenshot')])
    const root = await realpath(cwd)
    const first = await call('screenshot', {})
    const second = await call('screenshot', {})
    expect(first.value).toEqual({ ok: true, path: join(root, 'browser-screenshot.png') })
    expect(second.value).toEqual({ ok: true, path: join(root, 'browser-screenshot-2.png') })
    expect(host.calls.mock.calls.map(([, args]) => args.path))
      .toEqual([join(root, 'browser-screenshot.png'), join(root, 'browser-screenshot-2.png')])
    expect(await readFile(join(root, 'browser-screenshot-2.png'))).toEqual(PNG)
  })

  it('refuses a screenshot path outside the workspace or onto an existing file', async () => {
    const { call, cwd, host } = await setup([fixture('screenshot')])
    expect(content(await call('screenshot', { path: join(tmpdir(), 'outside.png') })))
      .toContain('output must remain inside the session workspace')
    expect(content(await call('screenshot', { path: '../escape.png' })))
      .toContain('output must remain inside the session workspace')
    await writeFile(join(cwd, 'taken.png'), 'keep')
    expect(content(await call('screenshot', { path: 'taken.png' }))).toContain('output file already exists')
    expect(await readFile(join(cwd, 'taken.png'), 'utf8')).toBe('keep')
    expect(host.calls).not.toHaveBeenCalled()
  })

  it('keeps the captured temp file in a read-only session and refuses a workspace path', async () => {
    const { call, host, ctx } = await setup([fixture('screenshot')], 'read-only', 'ask')
    const asked = vi.fn(async () => 'allowed-once' as const)
    ctx.on('approval/request', asked)
    expect(content(await call('screenshot', { path: 'preview.png' })))
      .toContain('a read-only session cannot write files into the session workspace')
    expect(asked).not.toHaveBeenCalled()
    expect(host.calls).not.toHaveBeenCalled()
    const shot = await call('screenshot', {})
    expect(shot.isError).toBe(false)
    expect(host.calls.mock.calls[0]?.[1]).toEqual({})
    expect(shot.value).toMatchObject({ ok: true })
  })

  it('keeps an upstream screenshot failure instead of replacing it with an image error', async () => {
    const { call, host } = await setup([fixture('screenshot')])
    host.calls.mockResolvedValueOnce({ ok: false, error: 'capture budget exceeded' })
    const result = await call('screenshot', { path: 'failed.png' })
    expect(result.isError).toBe(false)
    expect(content(result)).toContain('capture budget exceeded')
    expect(result.content.map(block => block.type)).toEqual(['text'])
  })

  it('leaves file arguments to the Host when the session has no workspace', async () => {
    const { call, session, host, cwd } = await setup([fixture('screenshot')])
    delete (session.header as { cwd?: string }).cwd
    const path = join(cwd, 'preview.png')
    const shot = await call('screenshot', { path })
    expect(shot.isError).toBe(false)
    expect(host.calls.mock.calls[0]?.[1]).toEqual({ path })
    expect(shot.content.map(block => block.type)).toEqual(['text', 'image'])
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

  it('does not send the model into a repeated page-info call after a space denial', async () => {
    const { call, host } = await setup([fixture('page_info')])
    host.calls.mockRejectedValueOnce(new Error('ego_page_info: another task space is not available'))
    const text = content(await call('page_info', { space: 'foreign' }))
    expect(text).toContain('omit the space argument to use this session’s pages')
    expect(text).not.toContain('inspect the current page before retrying')
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
