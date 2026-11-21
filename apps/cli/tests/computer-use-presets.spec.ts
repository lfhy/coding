/**
 * Computer Use 的接线契约：宿主服务归基础组合，六个模式各自装配模型可见的工具行，
 * 其余模式既不注册工具也不注册技能。
 *
 * 组装文本断言覆盖全部六个模式（逆向分析模式会启动外部 MCP 进程，不在 keyless 测试里挂载）；
 * 真实 Host 组合只挂载其余五个模式，验证注入、技能目录与渐进式暴露的实际行为。helper 直到
 * 模型真正调用执行工具时才准备，因此这里不触碰本机桌面。
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from 'coding-app-boot'
import { provideCmdline } from 'coding-cmdline'
import EgoBrowserHost from '../../../packages/browser/browser-ego-host/src/index.ts'
import * as BrowserTool from '../../../packages/browser/tool-browser-ego/src/index.ts'
import { CallId } from 'coding-llm'
import { SessionId } from 'coding-session'
import type { Agent } from 'coding-agent'
import { isJsExpr, loadCordisYaml } from '../../../scripts/cordis-yaml.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CONFIG = join(ROOT, 'apps/cli/config')
const PRESET_ROOT = join(CONFIG, 'agent-presets')
const signal = new AbortController().signal

/** 装配了 Computer Use 工具行的模式。 */
const WIRED = ['standard', 'codex', 'longrun', 'reverse', 'webclone', 'chat'] as const
/** 其余模式保持不注册任何相关工具或技能。 */
const UNWIRED = ['minimal', 'notes', 'ppt', 'image', 'cordis'] as const
/** 真实组合里可以挂载的模式：逆向分析模式要启动外部 MCP 进程，只做组装文本断言。 */
const MOUNTED = ['standard', 'codex', 'longrun', 'webclone', 'chat'] as const

const TOOL_NAME = 'computer_use_activate'
const SKILL_NAME = 'dsh-computer-use'
const EXECUTION_TOOLS = [
  'computer_list_apps', 'computer_observe', 'computer_click', 'computer_set_value', 'computer_type_text',
  'computer_press_key', 'computer_scroll', 'computer_drag', 'computer_perform_action', 'computer_wait',
  'computer_confirm',
]

/** Loader entry 的最小形状，用于读取组装里的行。 */
interface Entry {
  id?: unknown
  name?: unknown
  disabled?: unknown
  config?: unknown
}

async function presetRows(preset: string): Promise<Entry[]> {
  const document = loadCordisYaml(await readFile(join(PRESET_ROOT, preset, 'agent.cordis.yml'), 'utf8'))
  if (!Array.isArray(document)) throw new TypeError(`${preset} is not a Loader entry array`)
  return document as Entry[]
}

/** 行上的门控表达式文本；`!!js` 之外的写法一律判为不合规。 */
function gateOf(entry: Entry): string {
  if (!isJsExpr(entry.disabled)) throw new TypeError(`row ${String(entry.id)} has no process-platform gate`)
  return entry.disabled.__jsExpr.trim()
}

describe('Computer Use rows in the shipped presets', () => {
  it.each(WIRED)('mounts the model-facing tool row on macOS only in %s', async (preset) => {
    const rows = (await presetRows(preset)).filter(row => row.id === 'tool-computer-use')
    expect(rows).toEqual([{ id: 'tool-computer-use', name: 'coding-tool-computer-use',
      disabled: { __jsExpr: "process.platform !== 'darwin'" } }])
    expect(gateOf(rows[0] as Entry)).toBe("process.platform !== 'darwin'")
  })

  it.each(UNWIRED)('registers no Computer Use row in %s', async (preset) => {
    const names = (await presetRows(preset)).map(row => row.name)
    expect(names).not.toContain('coding-tool-computer-use')
    expect(names).not.toContain('coding-computer-use')
  })

  it('owns the provider on the host plane and enables the managed helper rebuild', async () => {
    const patches = loadCordisYaml(await readFile(join(ROOT, 'packages/bundle/base/cordis.patch.yml'), 'utf8')) as
      { insert?: Entry[] }[]
    const rows = patches.flatMap(patch => patch.insert ?? []).filter(row => row.id === 'computer-use')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'computer-use', name: 'coding-computer-use', config: {
      helper: { allowSourceBuild: true },
    } })
    expect(gateOf(rows[0] as Entry)).toBe("process.platform !== 'darwin'")
    const manifest = JSON.parse(await readFile(join(ROOT, 'apps/cli/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    // 预设里的行按包名解析，依赖缺失时只有运行时才会暴露。
    expect(manifest.dependencies).toHaveProperty('coding-tool-computer-use')
  })
})

/** 保留真实 Host 的固定定义，只接管浏览器服务的执行端：这里不执行任何浏览器工具。 */
class FixtureBrowser extends EgoBrowserHost {}

let root: string
let ctx: Context

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-computer-use-presets-'))
  const profile = join(root, 'profiles', 'test')
  await mkdir(profile, { recursive: true })
  const config = join(profile, 'cordis.yml')
  await writeFile(config, '[]\n')
  await writeFile(join(root, 'settings.yaml'), '{}\n')
  healProfilesModuleFallback(join(ROOT, 'apps/cli/package.json'), root)
  ctx = await boot('dsh-computer-use-presets', config, [
    ...loadOverlayPatches('dsh-computer-use-presets', join(ROOT, 'packages/bundle/base/cordis.patch.yml')),
    ...loadOverlayPatches('dsh-computer-use-presets', join(ROOT, 'packages/bundle/web-app/cordis.patch.yml')),
    { id: 'browser-ego-host', disabled: true },
    { id: 'webserver', disabled: true },
    { id: 'ppt-workbench', disabled: true },
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
      default: 'standard', roots: [{ path: PRESET_ROOT, trust: 'system' }], includeUserRoot: false,
    } },
  ], async (bootCtx) => {
    provideCmdline(bootCtx, { args: [], exit: () => {} })
    // 新消费方尚无 lib 构建时，仅将其 Loader 导入指向源码；预设配置与其余插件仍真实加载。
    const internal = bootCtx.loader.internal
    if (!internal) throw new Error('Loader module resolver is unavailable')
    bootCtx.loader.internal = { ...internal,
      import: (specifier: string, base: string, attributes: ImportAttributes) => specifier === 'coding-tool-browser-ego'
        ? Promise.resolve(BrowserTool) : internal.import(specifier, base, attributes),
    }
    await bootCtx.plugin(FixtureBrowser)
  })
  expect(ctx.egoBrowser).toBeInstanceOf(FixtureBrowser)
  // 宿主行在 macOS 上装载并提供服务；其他平台整行缺省。
  expect(ctx.get('computerUse') !== undefined).toBe(process.platform === 'darwin')
}, 120_000)

afterAll(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

async function agent(preset: string) {
  const handle = await ctx.agents.create({
    sessionId: SessionId(`computer-${preset}-${Math.random().toString(36).slice(2)}`),
    meta: { cwd: root },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, preset).then(() => undefined),
  })
  handle.agent.session.append('turn/start', { turn: 1 })
  return handle
}

function toolNames(agent: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name)
}

function call(agent: Agent, name: string, args: unknown = {}) {
  return ctx.tools.execute({ name, arguments: args, agent, signal, callId: CallId(`computer-${name}`) })
}

describe.runIf(process.platform === 'darwin')('Computer Use in the shipped Web preset composition', () => {
  it.each(MOUNTED)('keeps only the bootstrap tool until the Skill is loaded in %s', async (preset) => {
    const handle = await agent(preset)
    const subject = handle.agent
    try {
      // 挂载后全局只有引导工具；执行工具要等 Skill 加载后才出现。
      expect(toolNames(subject)).toContain(TOOL_NAME)
      for (const name of EXECUTION_TOOLS) expect(toolNames(subject)).not.toContain(name)
      const catalog = await ctx.skills.list({ cwd: root, scope: subject })
      expect(catalog.find(skill => skill.name === SKILL_NAME)).toMatchObject({ name: SKILL_NAME })
      // 未加载技能时引导工具拒绝执行，并说明先加载哪个技能。
      const early = await call(subject, TOOL_NAME)
      expect(early.isError).toBe(true)
      expect(JSON.stringify(early.content)).toContain(`load the ${SKILL_NAME} Skill first`)

      // 加载技能的那次工具结果就是激活点：执行工具立刻出现，引导工具同时收起。
      const loaded = await call(subject, 'skill', { name: SKILL_NAME })
      expect(loaded).toMatchObject({ isError: false, value: { name: SKILL_NAME } })
      expect(toolNames(subject).filter(name => name.startsWith('computer_'))).toEqual(EXECUTION_TOOLS)
      expect(toolNames(subject)).not.toContain(TOOL_NAME)

      // 引导工具已收起，不再有第二条激活路径。
      const second = await call(subject, TOOL_NAME)
      expect(second.isError).toBe(true)
      expect(JSON.stringify(second.content)).toContain('unknown tool')
      expect(JSON.stringify(second.content)).toContain(TOOL_NAME)

      // 暴露按 agent 生效：同一预设里没加载技能的会话仍然只有引导工具。
      const sibling = await agent(preset)
      try {
        expect(toolNames(sibling.agent)).toContain(TOOL_NAME)
        expect(toolNames(sibling.agent).filter(name => name.startsWith('computer_'))).toEqual([TOOL_NAME])
      } finally {
        await sibling.dispose()
      }
    } finally {
      await handle.dispose()
    }
  }, 30_000)

  it('leaves presets without the row on a Computer Use free tool surface', async () => {
    const handle = await agent('minimal')
    const subject = handle.agent
    try {
      expect(toolNames(subject).filter(name => name.startsWith('computer_'))).toEqual([])
      expect((await ctx.skills.list({ cwd: root, scope: subject })).map(skill => skill.name)).not.toContain(SKILL_NAME)
      // 极简模式连技能工具都没有，因此不提供任何加载路径。
      expect(toolNames(subject)).not.toContain('skill')
    } finally {
      await handle.dispose()
    }
  }, 30_000)
})
