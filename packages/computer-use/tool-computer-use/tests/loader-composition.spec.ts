/**
 * 真实 Loader 组合下的 Computer Use 暴露：这一层验证模型实际看到什么——
 * 未加载 Skill 时只有引导工具、加载后换成按 agent 的执行工具，且执行真的走到提供方。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from 'coding-agent'
import { CallId, createUserMessage } from 'coding-llm'
import { createScope } from 'coding-scope'
import SessionStore, { SessionId } from 'coding-session'
import type { Session } from 'coding-session'
import SkillRegistry from 'coding-skill'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime from 'coding-tools'
import * as ToolSkill from 'coding-tool-skill'
import ApprovalService from 'coding-user-approval'
import { ComputerUseService, resolveConfig } from 'coding-computer-use'
import type {
  BackendActionResult,
  BackendCursorAction,
  BackendCursorActivation,
  BackendHealth,
  BackendObservation,
  BackendTrackedDragResult,
  ComputerUseBackend,
  ComputerAppIdentity,
  ComputerAppSelector,
  ComputerAppSummary,
  CursorVisibility,
} from 'coding-computer-use'
import { COMPUTER_USE_SKILL_CONTENT, COMPUTER_USE_SKILL_NAME } from '../src/skill.ts'
import * as ToolComputerUse from '../src/index.ts'

/** 提供方替身：只记录被调用的事实，不触碰任何真实界面。 */
class FixtureBackend implements ComputerUseBackend {
  readonly name = 'macos-ax' as const
  readonly helperPath = '/fixture/dsh-computer-use-helper'
  readonly calls: string[] = []

  resolveApp(selector: ComputerAppSelector): Promise<ComputerAppIdentity> {
    this.calls.push('resolve-app')
    return Promise.resolve({ bundleId: selector.bundleId ?? 'com.example.fixture', pid: 4242, name: 'Fixture' })
  }

  listApps(): Promise<ComputerAppSummary[]> {
    this.calls.push('list-apps')
    return Promise.resolve([{
      bundleId: 'com.example.fixture', pid: 4242, name: 'Fixture', frontmost: true,
      accessibility: 'granted', screenRecording: 'granted',
    }])
  }

  observe(app: ComputerAppIdentity): Promise<BackendObservation> {
    this.calls.push('observe')
    return Promise.resolve({
      app, stateHash: 'fixture-hash', frontmost: true, treeText: '[0] window "Fixture"', truncated: false, elements: [],
      permissions: { accessibility: 'granted', screenRecording: 'granted' },
    })
  }

  activateForCursor(app: ComputerAppIdentity): Promise<BackendCursorActivation> {
    return this.observe(app).then(observation => ({ observation, activation: 'already-frontmost' as const }))
  }

  act(): Promise<BackendActionResult> {
    this.calls.push('act')
    return Promise.resolve({ channel: 'accessibility', activation: 'not-requested', pointerInput: false, pointerRouting: 'none' })
  }

  actDragWithCursor(): Promise<BackendTrackedDragResult> {
    return Promise.reject(new Error('fixture backend does not implement drag'))
  }

  visualizeCursor(action: BackendCursorAction): Promise<CursorVisibility> {
    return Promise.resolve({ visible: false, reason: `fixture backend does not draw a cursor for ${action.kind}` })
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }

  health(): Promise<BackendHealth> {
    return Promise.resolve({
      helperVersion: '0.0.0-fixture', helperSha256: 'fixture', accessibility: 'granted', screenRecording: 'granted',
    })
  }

  openSettings(): Promise<void> {
    return Promise.reject(new Error('fixture backend does not open settings panes'))
  }
}

let fixture: FixtureBackend
let root: string | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** 宿主层的服务替身：接管提供方接缝，其余与生产的 Computer Use 服务一致。 */
class FixtureComputerUse extends ComputerUseService {
  static inject = ['approval', 'sessions', 'agents']

  constructor(context: Context) {
    super(context, fixture, resolveConfig({}))
  }
}

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-computer-use-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'coding-session'",
    "- name: 'coding-agent'",
    "- name: 'coding-system-prompt'",
    "- name: 'coding-tools'",
    '  config:',
    '    mode: native',
    "- name: 'coding-skill'",
    "- name: 'coding-tool-skill'",
    "- name: 'coding-user-approval'",
    "- name: 'coding-computer-use'",
    "- name: 'coding-tool-computer-use'",
    '',
  ].join('\n'))

  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['coding-session', SessionStore],
    ['coding-agent', AgentRegistry],
    ['coding-system-prompt', SystemPrompt],
    ['coding-tools', ToolRuntime],
    ['coding-skill', SkillRegistry],
    ['coding-tool-skill', ToolSkill],
    ['coding-user-approval', ApprovalService],
    ['coding-computer-use', FixtureComputerUse],
    ['coding-tool-computer-use', ToolComputerUse],
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

/** 一个真实会话加一个带工具注入的 agent 作用域；`loaded` 决定日志里有没有 Skill 调用这条持久证据。 */
async function agent(
  context: Context,
  id: string,
  loaded: boolean,
): Promise<{ agent: { id: SessionId; session: Session; ctx?: Context }; session: Session; dispose: () => void }> {
  const session = context.sessions.create(SessionId(id), { meta: { cwd: root as string } })
  session.append('turn/start', { turn: 1 })
  if (loaded) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: COMPUTER_USE_SKILL_CONTENT }],
      source: { kind: 'skill-invocation', name: COMPUTER_USE_SKILL_NAME, form: 'instructions' },
    }), { surfaceOp: 'append' })
  }
  const agent: { id: SessionId; session: Session; ctx?: Context } = { id: session.id, session }
  // 作用域键就是 agent 本身：注册与查询必须落在同一个键上，否则工具对模型不可见。
  const scope = createScope(context, agent)
  // 生产里 agent.ctx 带着工具的注入；这里复现同一层，否则按 agent 注册会因缺注入而失败。
  agent.ctx = await new Promise<Context>((resolve) => {
    scope.ctx.inject(['tools'], (injected: Context) => {
      resolve(injected)
      return () => {}
    })
  })
  // rawDispose 可能返回 Promise；调用方按同步语义丢弃它，与既有用例的调用方式一致。
  return { agent, session, dispose: () => { void scope.rawDispose() } }
}

function toolNames(context: Context, scope?: object): string[] {
  return context.tools.schemas(scope).map(schema => schema.name).sort()
}

function execute(context: Context, subject: object, name: string, args: object = {}) {
  return context.tools.execute({
    name, callId: CallId(`cu-call-${name}`), arguments: args,
    signal: new AbortController().signal, agent: subject as never,
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  const [block] = result.content
  return block?.type === 'text' ? block.text : ''
}

describe('Computer Use through a real Loader composition', () => {
  it('publishes only the activation tool and the Skill before the Skill is loaded', async () => {
    fixture = new FixtureBackend()
    const context = await boot()
    expect(toolNames(context)).toEqual(['computer_use_activate', 'skill'])
    const catalog = await context.skills.list({ scope: undefined })
    expect(catalog.map(skill => skill.name).sort()).toEqual(['computer-use', 'dsh-computer-use'])
  })

  it('refuses the bootstrap until the calling session has loaded the Skill', async () => {
    fixture = new FixtureBackend()
    const context = await boot()
    const { agent: subject } = await agent(context, 'cu-loader-unloaded', false)

    const result = await execute(context, subject, 'computer_use_activate')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('load the dsh-computer-use Skill first')
    expect(fixture.calls).toEqual([])
  })

  it('swaps the bootstrap for the agent-scoped execution tools once the Skill is loaded', async () => {
    fixture = new FixtureBackend()
    const context = await boot()
    const viewer = await agent(context, 'cu-loader-other', false)
    const loaded = await agent(context, 'cu-loader-loaded', true)

    context.emit('agent/created', { agent: loaded.agent } as never)

    expect(toolNames(context)).toEqual(['computer_use_activate', 'skill'])
    expect(toolNames(context, viewer.agent)).toEqual(['computer_use_activate', 'skill'])
    expect(toolNames(context, loaded.agent)).toContain('computer_list_apps')
    expect(toolNames(context, loaded.agent)).not.toContain('computer_use_activate')
    expect(toolNames(context, loaded.agent)).not.toContain('computer_use_activate')
    loaded.dispose()
    viewer.dispose()
  })

  it('runs a lease-free read tool through the provider and returns it to the model', async () => {
    fixture = new FixtureBackend()
    const context = await boot()
    const loaded = await agent(context, 'cu-loader-read', true)
    context.emit('agent/created', { agent: loaded.agent } as never)

    const result = await execute(context, loaded.agent, 'computer_list_apps')
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject([{ bundleId: 'com.example.fixture', pid: 4242, frontmost: true }])
    expect(text(result)).toContain('com.example.fixture')
    expect(fixture.calls).toEqual(['list-apps'])
    loaded.dispose()
  })
})
