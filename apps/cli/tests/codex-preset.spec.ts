import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from 'coding-app-boot'
import { provideCmdline } from 'coding-cmdline'
import { SessionId } from 'coding-session'
import type { Agent } from 'coding-agent'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CONFIG = join(ROOT, 'apps/cli/config')

let root: string
let ctx: Context

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-preset-'))
  const profile = join(root, 'profiles', 'test')
  await mkdir(profile, { recursive: true })
  const config = join(profile, 'cordis.yml')
  await writeFile(config, '[]\n')
  await writeFile(join(root, 'settings.yaml'), '{}\n')
  healProfilesModuleFallback(join(ROOT, 'apps/cli/package.json'), root)
  ctx = await boot('dsh-codex-preset', config, [
    ...loadOverlayPatches('dsh-codex-preset', join(ROOT, 'packages/bundle/base/cordis.patch.yml')),
    ...loadOverlayPatches('dsh-codex-preset', join(ROOT, 'packages/bundle/web-app/cordis.patch.yml')),
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
  })
}, 120_000)

afterAll(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

/** 用真实装配挂载一次 Codex 预设，返回可断言的在线 Agent。 */
async function mountCodex() {
  return await ctx.agents.create({
    sessionId: SessionId(`codex-${Math.random().toString(36).slice(2)}`),
    meta: { cwd: root },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'codex').then(() => undefined),
  })
}

function toolNames(agent: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name).sort()
}

describe('the shipped Codex preset', () => {
  it('exposes exactly the Codex tool surface', async () => {
    const codex = await mountCodex()
    try {
      // Codex 的工具面本身。
      expect(toolNames(codex.agent)).toEqual(expect.arrayContaining([
        'apply_patch',
        'bash',
        'followup_task',
        'interrupt_agent',
        'list_agents',
        'send_message',
        'spawn_agent',
        'update_plan',
        'wait_agent',
        'web_search',
      ]))
      // 背景命令控制与宿主半的跨模式工具（记忆、GenUI、子级模型目录）不属于预设。
      expect(toolNames(codex.agent)).toEqual(expect.arrayContaining([
        'job_kill', 'job_list', 'job_output', 'list_subagent_models',
        'memory_delete', 'memory_list', 'memory_read', 'memory_save', 'memory_update',
        'render_ui', 'validate_dsh_ui',
      ]))
      // 这些工具在标准模式里存在，Codex 模式不再暴露它们。
      expect(toolNames(codex.agent)).toEqual(expect.not.arrayContaining([
        'read', 'write', 'edit', 'read_image', 'glob', 'grep',
        'skill', 'subagent_fork', 'workflow', 'ralph',
        'get_goal', 'create_goal', 'update_goal', 'exit_plan_mode', 'ask_user_question',
        'todo_write', 'web_fetch',
      ]))
    } finally {
      await codex.dispose()
    }
  }, 30_000)

  it('starts its persona with the Codex base instructions', async () => {
    const codex = await mountCodex()
    try {
      const prompt = await ctx.systemPrompt.assemble({ scope: codex.agent })
      const text = prompt.sections.map(section => section.text).join('\n')
      expect(text).toContain('You are a coding agent running in the Codex CLI')
      expect(text).toContain('## Multi agents')
      expect(text).toContain('`wait_agent`')
      expect(text).not.toContain('close_agent')
    } finally {
      await codex.dispose()
    }
  }, 30_000)
})
