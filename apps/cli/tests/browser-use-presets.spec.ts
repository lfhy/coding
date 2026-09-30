import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { BrowserUseError, BrowserUseService } from '@deepseek-ai/dsh-browser'
import type { BrowserCapture, BrowserCommand, BrowserExpectedTarget, BrowserHumanCommand, BrowserSessionState, BrowserTabId } from '@deepseek-ai/dsh-browser'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CONFIG = join(ROOT, 'apps/cli/config')
const signal = new AbortController().signal

/** 使用真实宿主组合和预设，只将会启动 Chromium 的服务换成可观测的内存提供方。 */
class FixtureBrowser extends BrowserUseService {
  private readonly sessions = new Map<string, BrowserSessionState>()
  private readonly operations = new Set<ReturnType<typeof SessionId>>()
  readonly commands = vi.fn(async (
    sessionId: ReturnType<typeof SessionId>, command: BrowserCommand, requestSignal: AbortSignal,
    expectedTarget?: BrowserExpectedTarget,
  ): Promise<BrowserCapture> => {
    requestSignal.throwIfAborted()
    const previous = this.sessions.get(sessionId)
    if (expectedTarget?.kind === 'none' && previous !== undefined) throw new Error('stale browser session')
    if (expectedTarget?.kind === 'tab' && (
      previous?.browserGeneration !== expectedTarget.browserGeneration
      || previous.stateRevision !== expectedTarget.stateRevision
      || previous.activeTabId !== expectedTarget.tabId
      || previous.tabs[0]?.generation !== expectedTarget.generation
      || previous.tabs[0]?.url !== expectedTarget.url
    )) throw new Error('stale browser tab')
    const tabId = previous?.activeTabId ?? ('fixture-tab' as BrowserTabId)
    const url = command.kind === 'navigate' ? command.url : previous?.tabs[0]?.url ?? 'https://example.test/'
    const capture: BrowserCapture = {
      observation: {
        tabId, generation: 'fixture', revision: (previous?.observation?.revision ?? 0) + 1,
        url,
        title: 'Fixture', snapshot: '[button-1] button Continue',
        viewport: { width: 800, height: 600 }, cursor: null,
      },
      png: null,
    }
    if (command.kind === 'close') this.sessions.delete(sessionId)
    else this.sessions.set(sessionId, {
      operationActive: false,
      browserGeneration: previous?.browserGeneration ?? 'fixture-browser',
      stateRevision: (previous?.stateRevision ?? 0) + 1,
      viewport: { width: 800, height: 600 },
      tabs: [{ id: tabId, generation: 'fixture', url, title: 'Fixture', canGoBack: false, canGoForward: false }],
      activeTabId: tabId, observation: capture.observation, hasFrame: false,
    })
    return capture
  })

  execute(sessionId: ReturnType<typeof SessionId>, command: BrowserCommand, requestSignal: AbortSignal,
    expectedTarget?: BrowserExpectedTarget): Promise<BrowserCapture> {
    return this.commands(sessionId, command, requestSignal, expectedTarget)
  }
  acquireOperation(sessionId: ReturnType<typeof SessionId>, requestSignal: AbortSignal): Promise<() => void> {
    requestSignal.throwIfAborted()
    if (this.operations.has(sessionId)) throw new BrowserUseError('browser operation already active', 'BROWSER_BUSY')
    this.operations.add(sessionId)
    let released = false
    return Promise.resolve(() => {
      if (released) return
      released = true
      this.operations.delete(sessionId)
    })
  }
  operationActive(sessionId: ReturnType<typeof SessionId>): boolean { return this.operations.has(sessionId) }
  state(sessionId: ReturnType<typeof SessionId>): BrowserSessionState | undefined {
    const state = this.sessions.get(sessionId)
    return state && { ...state, operationActive: this.operationActive(sessionId) }
  }
  control(_sessionId: ReturnType<typeof SessionId>, _command: BrowserHumanCommand,
    _signal: AbortSignal): Promise<BrowserSessionState | undefined> {
    return Promise.reject(new Error('fixture browser does not exercise human controls'))
  }
  latest(sessionId: ReturnType<typeof SessionId>): BrowserCapture | undefined {
    const observation = this.sessions.get(sessionId)?.observation
    return observation === null || observation === undefined ? undefined : { observation, png: null }
  }
  closeSession(sessionId: ReturnType<typeof SessionId>): Promise<void> {
    this.sessions.delete(sessionId)
    return Promise.resolve()
  }
}

let root: string
let ctx: Context

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-browser-presets-'))
  const profile = join(root, 'profiles', 'test')
  await mkdir(profile, { recursive: true })
  const config = join(profile, 'cordis.yml')
  await writeFile(config, '[]\n')
  await writeFile(join(root, 'settings.yaml'), '{}\n')
  healProfilesModuleFallback(join(ROOT, 'apps/cli/package.json'), root)
  ctx = await boot('dsh-browser-presets', config, [
    ...loadOverlayPatches('dsh-browser-presets', join(ROOT, 'packages/bundle/base/cordis.patch.yml')),
    ...loadOverlayPatches('dsh-browser-presets', join(ROOT, 'packages/bundle/web-app/cordis.patch.yml')),
    { id: 'browser-playwright', disabled: true },
    { id: 'webserver', disabled: true },
    { id: 'web-runtime', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    { id: 'open-in-app', disabled: true },
    { id: 'client-hmr', disabled: true },
    { id: 'settings', config: { path: join(root, 'settings.yaml'), watch: false } },
    { id: 'storage-json', config: { root: join(root, 'storages') } },
    { id: 'session-persistence-jsonl', config: { root: join(root, 'sessions') } },
    { id: 'attachment-local', config: { dshHome: root } },
    { id: 'agent-presets', config: {
      default: 'standard', roots: [{ path: join(CONFIG, 'agent-presets'), trust: 'system' }], includeUserRoot: false,
    } },
  ], async (bootCtx) => {
    provideCmdline(bootCtx, { args: [], exit: () => {} })
    await bootCtx.plugin(FixtureBrowser)
  })
}, 120_000)

afterAll(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

async function agent(preset: 'standard' | 'code', cwd: string) {
  const handle = await ctx.agents.create({
    sessionId: SessionId(`browser-${preset}-${Math.random().toString(36).slice(2)}`),
    meta: { cwd },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, preset).then(() => undefined),
  })
  handle.agent.session.append('turn/start', { turn: 1 })
  return handle
}

function call(agent: Agent, name: string, args: unknown) {
  return ctx.tools.execute({ name, arguments: args, agent, signal, callId: CallId(`browser-${name}`) })
}

describe('browser_use in the shipped Web preset composition', () => {
  it.each(['standard', 'code'] as const)('honors Full access in %s without approval and restores session-local restrictions', async (preset) => {
    const selected = await agent(preset, root)
    const isolated = await agent(preset, root)
    const browser = ctx.browserUse as FixtureBrowser
    browser.commands.mockClear()
    const requested = vi.spyOn(ctx.approval, 'request')
    const args = { action: 'navigate', url: 'https://example.test/full-access' }
    const execute = (target: Agent) => preset === 'standard'
      ? call(target, 'browser_use', args)
      : call(target, 'run_code', {
        code: `return await tools.browser_use(${JSON.stringify(args)})`,
        description: 'Inspect the full-access fixture browser',
      })
    const audits = (target: Agent) => target.session.events.filter(event =>
      event.type === 'approval/asked' || event.type === 'approval/decided')
    let unlisten: (() => void) | undefined
    try {
      // 与权限选择器共用真实预设写入路径；不安装审批答复器。
      ctx.permissionPresets.set(selected.agent.session, 'danger-full-access')
      expect(ctx.permissionPresets.current(selected.agent.session.events)).toBe('danger-full-access')
      const result = await execute(selected.agent)
      const value = {
        action: 'navigate', observation: { tabId: 'fixture-tab', url: args.url, snapshot: '[button-1] button Continue' }, image: null,
      }
      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      expect(result).toMatchObject({ isError: false, value: preset === 'standard' ? value : { result: value } })
      expect(JSON.stringify(result.content)).toContain(args.url)
      expect(JSON.stringify(result.content)).toContain('[button-1] button Continue')
      expect(requested).not.toHaveBeenCalled()
      expect(audits(selected.agent)).toEqual([])
      expect(browser.commands).toHaveBeenCalledExactlyOnceWith(selected.agent.session.id, {
        kind: 'navigate', url: args.url,
      }, expect.any(AbortSignal), { kind: 'none' })
      expect(browser.state(selected.agent.session.id)?.operationActive).toBe(false)
      expect(browser.operationActive(selected.agent.session.id)).toBe(false)

      // Web 宿主保留等待客户端的审批通道；受限调用用拒绝答复结束，避免等待未连接的客户端。
      unlisten = ctx.on('approval/request', () => Promise.resolve('rejected' as const), { prepend: true })
      expect(ctx.permissionPresets.current(isolated.agent.session.events)).toBe('workspace-write')
      const otherResult = await execute(isolated.agent)
      expect(otherResult.isError).toBe(true)
      expect(JSON.stringify(otherResult.content)).toContain('approval rejected')
      expect(audits(isolated.agent).map(event => event.type)).toEqual(['approval/asked', 'approval/decided'])
      expect(audits(selected.agent)).toEqual([])

      ctx.permissionPresets.set(selected.agent.session, 'workspace-write')
      expect(ctx.permissionPresets.current(selected.agent.session.events)).toBe('workspace-write')
      const restricted = await execute(selected.agent)
      expect(restricted.isError).toBe(true)
      expect(JSON.stringify(restricted.content)).toContain('approval rejected')
      expect(audits(selected.agent)).toMatchObject([
        { type: 'approval/asked', data: { toolName: 'browser_use' } },
        { type: 'approval/decided', data: { outcome: 'rejected' } },
      ])
      expect(requested).toHaveBeenCalledTimes(2)
      expect(browser.commands).toHaveBeenCalledTimes(1)
      expect(browser.operationActive(isolated.agent.session.id)).toBe(false)
    } finally {
      unlisten?.()
      requested.mockRestore()
      await isolated.dispose()
      await selected.dispose()
    }
  }, 30_000)

  it('presents one native schema in standard and one SDK binding in Code Mode, and executes both', async () => {
    const native = await agent('standard', root)
    const coded = await agent('code', root)
    const browser = ctx.browserUse as FixtureBrowser
    browser.commands.mockClear()
    const requested = vi.fn(() => Promise.resolve('allowed-once' as const))
    const unlisten = ctx.on('approval/request', requested, { prepend: true })
    try {
      const standardPrompt = await ctx.systemPrompt.assemble({ scope: native.agent })
      const codePrompt = await ctx.systemPrompt.assemble({ scope: coded.agent })
      expect(standardPrompt.tools.map(tool => tool.name)).toContain('browser_use')
      expect(standardPrompt.tools.map(tool => tool.name)).not.toContain('run_code')
      expect(codePrompt.tools.map(tool => tool.name)).toEqual(['run_code'])
      expect(codePrompt.sections.find(section => section.name === 'tools:sdk')?.text)
        .toMatch(/browser_use/)
      expect(ctx.tools.schemas(coded.agent).map(tool => tool.name)).toContain('browser_use')

      const direct = await call(native.agent, 'browser_use', { action: 'navigate', url: 'https://example.test/native' })
      expect(direct).toMatchObject({ isError: false, value: {
        action: 'navigate', observation: { tabId: 'fixture-tab', url: 'https://example.test/native' }, image: null,
      } })
      const bypass = await call(coded.agent, 'browser_use', { action: 'snapshot' })
      expect(bypass.error?.info).toMatchObject({ code: 'UNKNOWN_TOOL' })
      expect(browser.commands).toHaveBeenCalledTimes(1)

      const composed = await call(coded.agent, 'run_code', {
        code: 'const result = await tools.browser_use({ action: "navigate", url: "https://example.test/code" }); return result.observation.snapshot',
        description: 'Inspect the fixture browser',
      })
      expect(composed).toMatchObject({ isError: false, value: {
        result: '[button-1] button Continue',
      } })
      expect(browser.commands).toHaveBeenCalledTimes(2)
      expect(browser.commands.mock.calls.map(([, command]) => command.kind)).toEqual(['navigate', 'navigate'])
      expect(browser.commands.mock.calls.map(([, , , target]) => target)).toEqual([{ kind: 'none' }, { kind: 'none' }])
      expect(requested).toHaveBeenCalledTimes(2)
    } finally {
      unlisten()
      await coded.dispose()
      await native.dispose()
    }
  }, 30_000)

  it('keeps rejected approval and Remote-SSH workspaces away from the provider', async () => {
    const local = await agent('standard', root)
    const coded = await agent('code', root)
    const remote = join(root, 'remote')
    await mkdir(remote)
    await writeFile(join(remote, '.coding-remote-workspace.json'), JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'fixture', generation: 1, mode: 'basic',
    }))
    const remoteAgent = await agent('standard', remote)
    const remoteCodeAgent = await agent('code', remote)
    const browser = ctx.browserUse as FixtureBrowser
    browser.commands.mockClear()
    const requested = vi.fn(() => Promise.resolve('rejected' as const))
    const unlisten = ctx.on('approval/request', requested, { prepend: true })
    try {
      const native = await call(local.agent, 'browser_use', { action: 'navigate', url: 'https://example.test/native' })
      expect(native.isError).toBe(true)
      expect(JSON.stringify(native.content)).toContain('approval rejected')
      const nested = await call(coded.agent, 'run_code', {
        code: 'await tools.browser_use({ action: "navigate", url: "https://example.test/code" })', description: 'Rejected browser request',
      })
      expect(nested.isError).toBe(true)
      expect(JSON.stringify(nested.content)).toContain('approval rejected')

      for (const permission of ['workspace-write', 'danger-full-access']) {
        ctx.permissionPresets.set(remoteAgent.agent.session, permission)
        ctx.permissionPresets.set(remoteCodeAgent.agent.session, permission)
        const remoteResult = await call(remoteAgent.agent, 'browser_use', { action: 'snapshot' })
        expect(remoteResult.isError).toBe(true)
        expect(JSON.stringify(remoteResult.content)).toContain('remote workspace')
        const remoteCodeResult = await call(remoteCodeAgent.agent, 'run_code', {
          code: 'await tools.browser_use({ action: "snapshot" })', description: 'Remote browser request',
        })
        expect(remoteCodeResult.isError).toBe(true)
        expect(JSON.stringify(remoteCodeResult.content)).toMatch(/remote|REMOTE/)
        for (const target of [remoteAgent.agent, remoteCodeAgent.agent]) {
          expect(target.session.events.filter(event =>
            event.type === 'approval/asked' || event.type === 'approval/decided')).toEqual([])
        }
      }
      expect(requested).toHaveBeenCalledTimes(2)
      expect(browser.commands).not.toHaveBeenCalled()
    } finally {
      unlisten()
      await remoteCodeAgent.dispose()
      await remoteAgent.dispose()
      await coded.dispose()
      await local.dispose()
    }
  }, 30_000)
})
