import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { BrowserUseService } from '@deepseek-ai/dsh-browser'
import type { BrowserCapture, BrowserCommand } from '@deepseek-ai/dsh-browser'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CONFIG = join(ROOT, 'apps/cli/config')
const signal = new AbortController().signal

/** 使用真实宿主组合和预设，只将会启动 Chromium 的服务换成可观测的内存提供方。 */
class FixtureBrowser extends BrowserUseService {
  readonly commands = vi.fn(async (
    _sessionId: ReturnType<typeof SessionId>, command: BrowserCommand, requestSignal: AbortSignal,
  ): Promise<BrowserCapture> => {
    requestSignal.throwIfAborted()
    return {
      observation: {
        generation: 'fixture', revision: 1,
        url: command.kind === 'navigate' ? command.url : 'https://example.test/',
        title: 'Fixture', snapshot: '[button-1] button Continue',
        viewport: { width: 800, height: 600 }, cursor: null,
      },
      png: null,
    }
  })

  execute(sessionId: ReturnType<typeof SessionId>, command: BrowserCommand, requestSignal: AbortSignal): Promise<BrowserCapture> {
    return this.commands(sessionId, command, requestSignal)
  }
  latest(): BrowserCapture | undefined { return undefined }
  closeSession(): Promise<void> { return Promise.resolve() }
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
  it('presents one native schema in standard and one SDK binding in Code Mode, and executes both', async () => {
    const native = await agent('standard', root)
    const coded = await agent('code', root)
    const browser = ctx.browserUse as FixtureBrowser
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
        action: 'navigate', observation: { url: 'https://example.test/native' }, image: null,
      } })
      const bypass = await call(coded.agent, 'browser_use', { action: 'snapshot' })
      expect(bypass.error?.info).toMatchObject({ code: 'UNKNOWN_TOOL' })
      expect(browser.commands).toHaveBeenCalledTimes(1)

      const composed = await call(coded.agent, 'run_code', {
        code: 'const result = await tools.browser_use({ action: "snapshot" }); return result.observation.snapshot',
        description: 'Inspect the fixture browser',
      })
      expect(composed).toMatchObject({ isError: false, value: {
        result: '[button-1] button Continue',
      } })
      expect(browser.commands).toHaveBeenCalledTimes(2)
      expect(browser.commands.mock.calls.map(([, command]) => command.kind)).toEqual(['navigate', 'snapshot'])
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
      const native = await call(local.agent, 'browser_use', { action: 'snapshot' })
      expect(native.isError).toBe(true)
      expect(JSON.stringify(native.content)).toContain('approval rejected')
      const nested = await call(coded.agent, 'run_code', {
        code: 'await tools.browser_use({ action: "snapshot" })', description: 'Rejected browser request',
      })
      expect(nested.isError).toBe(true)
      expect(JSON.stringify(nested.content)).toContain('approval rejected')

      const remoteResult = await call(remoteAgent.agent, 'browser_use', { action: 'snapshot' })
      expect(remoteResult.isError).toBe(true)
      expect(JSON.stringify(remoteResult.content)).toContain('remote workspace')
      const remoteCodeResult = await call(remoteCodeAgent.agent, 'run_code', {
        code: 'await tools.browser_use({ action: "snapshot" })', description: 'Remote browser request',
      })
      expect(remoteCodeResult.isError).toBe(true)
      expect(JSON.stringify(remoteCodeResult.content)).toMatch(/remote|REMOTE/)
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
