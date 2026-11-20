/**
 * The default preset is a user setting. `config.default` is the deployment's
 * engineering default; the settings document overrides it and is hot-reloaded,
 * so a person can change which preset new sessions get without a restart.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from 'coding-llm'
import SessionStore, { SessionId } from 'coding-session'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime from 'coding-tools'
import AgentRegistry from 'coding-agent'
import AgentLoop from 'coding-agent-loop'
import FileSettingsProvider from 'coding-settings-file'
import { settingsNamespace } from 'coding-settings'
import { describe, expect, it } from 'vitest'
import AgentPresets, { COMPOSITION_FILE, SETTINGS_NAMESPACE } from 'coding-agent-presets'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const ROOTS = [{ path: join(FIXTURES, 'system'), trust: 'system' as const }]
const NS = settingsNamespace(SETTINGS_NAMESPACE)

/**
 * A composition with a real file-backed settings provider. `settingsFiber` is
 * the provider's own handle, so a test can take it away the way a reload does.
 */
async function harness(
  extraRoots: readonly { path: string; trust: 'system' | 'user' }[] = [],
): Promise<{ ctx: Context; settingsFile: string; settingsFiber: { dispose: () => unknown } }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-preset-settings-'))
  const settingsFile = join(home, 'settings.yaml')
  await writeFile(settingsFile, '{}\n')

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const settingsFiber = ctx.plugin(FileSettingsProvider, { path: settingsFile, watch: false })
  await settingsFiber
  await ctx.plugin(AgentPresets, { default: 'standard', roots: [...ROOTS, ...extraRoots], includeUserRoot: false })
  return { ctx, settingsFile, settingsFiber }
}

const toolNames = (ctx: Context, agent?: unknown): string[] =>
  ctx.tools.schemas(agent as never).map(schema => schema.name).sort()

describe('the default preset as a user setting', () => {
  it('falls back to the composition default while the user set none', async () => {
    const { ctx } = await harness()

    expect(ctx.agentPresets.defaultId).toBe('standard')
  })

  it('takes the user default over the composition default', async () => {
    const { ctx } = await harness()

    await ctx.settings.update(NS, { default: 'minimal' })

    expect(ctx.agentPresets.defaultId).toBe('minimal')
  })

  it('uses an exact model override and inherits later global changes after unset', async () => {
    const { ctx } = await harness()
    await ctx.settings.mutate(NS, [
      { op: 'set', path: ['modelDefaults', 'gateway.one', 'model/v1'], value: 'minimal' },
    ])

    expect(ctx.agentPresets.defaultIdForModel('gateway.one', 'model/v1')).toBe('minimal')
    expect(ctx.agentPresets.defaultIdForModel('gateway.one', 'model/v2')).toBe('standard')
    expect(ctx.agentPresets.defaultIdForModel('gateway.two', 'model/v1')).toBe('standard')
    await ctx.settings.update(NS, { default: 'chat' })
    expect(ctx.agentPresets.defaultIdForModel('gateway.one', 'model/v1')).toBe('minimal')
    expect(ctx.agentPresets.defaultIdForModel('gateway.one', 'model/v2')).toBe('chat')

    await ctx.settings.mutate(NS, [
      { op: 'unset', path: ['modelDefaults', 'gateway.one', 'model/v1'] },
    ])
    expect(ctx.agentPresets.defaultIdForModel('gateway.one', 'model/v1')).toBe('chat')
    expect(ctx.agentPresets.defaultId).toBe('chat')
  })

  it('rejects an empty model preset id at the settings boundary', async () => {
    const { ctx } = await harness()

    await expect(ctx.settings.mutate(NS, [
      { op: 'set', path: ['modelDefaults', 'gateway', 'model'], value: '' },
    ])).rejects.toThrow()
    await expect(ctx.settings.mutate(NS, [
      { op: 'set', path: ['modelDefaults', '', 'model'], value: 'minimal' },
    ])).rejects.toThrow()
    await expect(ctx.settings.mutate(NS, [
      { op: 'set', path: ['modelDefaults', 'gateway', ''], value: 'minimal' },
    ])).rejects.toThrow()
    await expect(ctx.settings.update(NS, { default: '' })).rejects.toThrow()
    expect(ctx.agentPresets.defaultIdForModel('gateway', 'model')).toBe('standard')
  })

  it('does not mistake inherited object properties for explicit model keys', async () => {
    const { ctx } = await harness()

    expect(ctx.agentPresets.defaultIdForModel('constructor', 'toString')).toBe('standard')
    await ctx.settings.mutate(NS, [
      { op: 'set', path: ['modelDefaults', 'gateway', 'ordinary'], value: 'minimal' },
    ])
    expect(ctx.agentPresets.defaultIdForModel('gateway', 'toString')).toBe('standard')
  })

  it('composes a new session from the user default', async () => {
    const { ctx } = await harness()
    await ctx.settings.update(NS, { default: 'minimal' })

    const handle = await ctx.agents.create({
      sessionId: SessionId('settings-default'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx),
    })
    try {
      expect(toolNames(ctx, handle.agent)).toEqual(['beta'])
    } finally {
      await handle.dispose()
    }
  })

  it('leaves a running session on the preset it was composed from', async () => {
    const { ctx } = await harness()
    const running = await ctx.agents.create({
      sessionId: SessionId('settings-running'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx),
    })
    try {
      expect(toolNames(ctx, running.agent)).toEqual(['alpha'])

      // Changing the default mid-flight must not reach an agent that already
      // composed: its history was produced under `standard`'s tools.
      await ctx.settings.update(NS, { default: 'minimal' })

      expect(ctx.agentPresets.defaultId).toBe('minimal')
      expect(toolNames(ctx, running.agent)).toEqual(['alpha'])
    } finally {
      await running.dispose()
    }
  })

  it('re-inherits the composition default when the user setting is cleared', async () => {
    const { ctx } = await harness()
    await ctx.settings.update(NS, { default: 'minimal' })
    expect(ctx.agentPresets.defaultId).toBe('minimal')

    await ctx.settings.replace(NS, {})

    expect(ctx.agentPresets.defaultId).toBe('standard')
  })

  it('clears a user default it has just deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-preset-authored-'))
    await mkdir(join(root, 'mine'))
    await writeFile(
      join(root, 'mine', COMPOSITION_FILE),
      `- id: only\n  name: ${join(FIXTURES, 'plugins', 'contribute.js')}\n  config:\n    tool: only\n`,
    )
    const { ctx } = await harness([{ path: root, trust: 'user' as const }])
    await ctx.settings.update(NS, { default: 'mine' })
    expect(ctx.agentPresets.defaultId).toBe('mine')

    await ctx.agentPresets.remove('mine')

    // Nothing will ever supply that id again, so leaving the setting pointed at
    // it would fail every session created without an explicit pick. Clearing it
    // exposes the deployment's own default underneath.
    expect(ctx.agentPresets.defaultId).toBe('standard')
    expect((await ctx.agentPresets.resolve()).id).toBe('standard')
  })

  it('reports an unknown user default only when a session tries to use it', async () => {
    const { ctx } = await harness()

    // Storing it succeeds — the roster is a live directory, so a name that is
    // absent now may exist by the time a session asks for it.
    await ctx.settings.update(NS, { default: 'no-such-preset' })

    await expect(ctx.agentPresets.resolve())
      .rejects.toThrow(/preset "no-such-preset" not found/)
  })
})

describe('a settings provider that goes away', () => {
  it('falls back to the composition default when the provider unloads', async () => {
    const { ctx, settingsFiber } = await harness()
    await ctx.settings.update(NS, { default: 'minimal' })
    expect(ctx.agentPresets.defaultId).toBe('minimal')

    // Unloading the provider takes the user layer with it; the roster keeps
    // working on its composition default rather than holding a stale override.
    await settingsFiber.dispose()

    expect(ctx.agentPresets.defaultId).toBe('standard')
    expect(ctx.agentPresets.defaultIdForModel('gateway', 'model')).toBe('standard')
  })
})
