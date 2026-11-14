import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from 'coding-app-boot'
import { provideCmdline } from 'coding-cmdline'
import { CallId, createUserMessage } from 'coding-llm'
import { SessionId } from 'coding-session'
import type { Agent } from 'coding-agent'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { settingsNamespace } from 'coding-settings'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { loadCordisYaml } from '../../../scripts/cordis-yaml.ts'

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
    { id: 'ppt-workbench', disabled: true },
    // 图像服务继续加载；客户端展示依赖被禁用的浏览器运行时。
    { id: 'ui-image-generation', disabled: true },
    { id: 'web-runtime', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    { id: 'open-in-app', disabled: true },
    { id: 'client-hmr', disabled: true },
    // 辅助标题会额外请求同一路由；本回归只替换并消费主对话模型响应。
    { id: 'session-title-llm', disabled: true },
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

/** 结果内容就是模型读到的那段文本。 */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let calls = 0
function call(agent: Agent, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`codex-${name}-${++calls}`),
    name,
    arguments: args,
    agent,
  })
}

describe('the shipped Codex preset', () => {
  it('exposes exactly the Codex tool surface', async () => {
    const codex = await mountCodex()
    try {
      // 核心 Codex 工具及本产品的浏览器和按需技能入口均对当前会话可见。
      expect(toolNames(codex.agent)).toEqual(expect.arrayContaining([
        'apply_patch',
        'exec_command',
        'followup_task',
        'interrupt_agent',
        'list_agents',
        'send_message',
        'spawn_agent',
        'update_plan',
        'wait_agent',
        'web_fetch',
        'web_search',
        'browser_navigate', 'browser_snapshot', 'browser_screenshot',
        'skill', 'skill_read',
        'write_stdin',
      ]))
      // 宿主半的跨模式工具（记忆、GenUI、子级模型目录）不属于预设。
      expect(toolNames(codex.agent)).toEqual(expect.arrayContaining([
        'list_subagent_models',
        'memory_delete', 'memory_list', 'memory_read', 'memory_save', 'memory_update',
        'render_ui', 'validate_gen_ui',
      ]))
      // 这些工具在标准模式里存在，Codex 模式不再暴露它们。
      expect(toolNames(codex.agent)).toEqual(expect.not.arrayContaining([
        'bash', 'job_kill', 'job_list', 'job_output',
        'read', 'write', 'edit', 'read_image', 'glob', 'grep',
        'generate_image', 'generate_images', 'edit_image',
        'subagent_fork', 'workflow', 'ralph',
        'get_goal', 'create_goal', 'update_goal', 'exit_plan_mode', 'ask_user_question',
        'todo_write',
      ]))
      expect(toolNames(codex.agent).filter(name => name.startsWith('image_gen'))).toEqual([])
      const prompt = await ctx.systemPrompt.assemble({ scope: codex.agent })
      expect(prompt.sections.map(section => section.text).join('\n')).toContain('only when it is present in the available tools')
    } finally {
      await codex.dispose()
    }
  }, 30_000)

  it('adds only image_gen when the image service becomes available', async () => {
    const codex = await mountCodex()
    try {
      await ctx.settings.update(settingsNamespace('image-generation'), {
        enabled: true, endpoint: 'http://127.0.0.1:9/v1', model: 'mock', apiKeyRef: '',
      })
      await vi.waitFor(() => { expect(toolNames(codex.agent).filter(name => name.startsWith('image_gen'))).toEqual(['image_gen']) })
      const imageSchema = ctx.tools.schemas(codex.agent).find(schema => schema.name === 'image_gen')
      expect(Object.keys(imageSchema?.parameters.properties ?? {}).sort()).toEqual([
        'aspectRatio', 'num_last_images_to_include', 'prompt', 'referenced_image_paths', 'resolution',
        'transparent_background',
      ])
      expect(imageSchema?.parameters.required).toEqual(['prompt'])
      // 同一接口选择生成或最近图片编辑，不把未授权的绝对路径读取当作可用能力。
    } finally {
      await ctx.settings.update(settingsNamespace('image-generation'), { enabled: false })
      await codex.dispose()
    }
  }, 30_000)

  it('applies an update patch without a separate read tool call', async () => {
    const codex = await mountCodex()
    const path = join(root, 'codex-target.txt')
    try {
      await writeFile(path, 'before\n')
      const result = await call(codex.agent, 'apply_patch', {
        input: `*** Begin Patch
*** Update File: codex-target.txt
@@
-before
+after
*** End Patch`,
      })
      expect(result.isError).toBe(false)
      expect(await readFile(path, 'utf8')).toBe('after\n')
    } finally {
      await codex.dispose()
      await rm(path, { force: true })
    }
  }, 30_000)

  it('runs a background command through exec_command and collects it with write_stdin', async () => {
    const codex = await mountCodex()
    try {
      const started = await call(codex.agent, 'exec_command', {
        command: 'sleep 0.2; echo background-done',
        description: 'Run the smoke command in the background',
        run_in_background: true,
      })
      expect(started.isError).toBe(false)
      const sessionId = (started.value as { jobId?: string }).jobId
      expect(sessionId).toBeTruthy()

      const collected = await call(codex.agent, 'write_stdin', { session_id: sessionId, yield_time_ms: 5_000 })
      expect(collected.isError).toBe(false)
      expect(text(collected)).toContain('background-done')
      expect(text(collected)).toContain('[status: completed, exit code: 0]')
    } finally {
      await codex.dispose()
    }
  }, 30_000)

  it('types into an interactive exec_command session through write_stdin', async () => {
    const codex = await mountCodex()
    try {
      const started = await call(codex.agent, 'exec_command', {
        command: 'read -r line; printf "echo:%s\\n" "$line"',
        description: 'Start an interactive PTY session',
        tty: true,
        run_in_background: true,
      })
      expect(started.isError).toBe(false)
      const sessionId = (started.value as { jobId?: string }).jobId
      expect(sessionId).toBeTruthy()

      const typed = await call(codex.agent, 'write_stdin', {
        session_id: sessionId,
        chars: 'hello-pty\n',
        yield_time_ms: 2_000,
      })
      expect(typed.isError).toBe(false)

      // 回显可能落在后续读取里：继续轮询直到会话给出结果或超时。
      let transcript = text(typed)
      const deadline = Date.now() + 5_000
      while (!transcript.includes('echo:hello-pty') && Date.now() < deadline) {
        const next = await call(codex.agent, 'write_stdin', { session_id: sessionId, yield_time_ms: 200 })
        transcript += text(next)
      }
      expect(transcript).toContain('echo:hello-pty')
    } finally {
      await codex.dispose()
    }
  }, 30_000)

  it('仅 Codex 不装配进度提醒，其余随包模式保持原阈值', async () => {
    for (const preset of ['codex', 'standard', 'minimal', 'cordis', 'image', 'ppt', 'reverse', 'webclone', 'longrun']) {
      const rows = loadCordisYaml(await readFile(join(CONFIG, 'agent-presets', preset, 'agent.cordis.yml'), 'utf8')) as {
        id?: string
        name: string
        config?: unknown
      }[]
      const reminders = rows.filter(row => row.name === 'coding-progress-reminder')
      expect(reminders, preset).toEqual(preset === 'codex' ? [] : [{
        id: 'progress-reminder', name: 'coding-progress-reminder', config: { toolCallsPerReminder: 40 },
      }])
    }
  })

  it('标准模式已启动提醒时，Codex 及其派生会话仍不会注入提醒', async () => {
    const standard = await ctx.agents.create({
      sessionId: SessionId('progress-standard'),
      meta: { cwd: root },
      agentOptions: { provider: 'progress-standard', model: 'mock' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    const codex = await mountCodex()
    const child = await ctx.agents.create({
      sessionId: SessionId('progress-codex-child'),
      meta: { cwd: root, parentSession: codex.agent.id, origin: 'subagent' },
      agentOptions: { provider: 'progress-child', model: 'mock' },
      setup: (agentCtx) => { ctx.agentPresets.composeFrom(agentCtx, codex.agent.ctx) },
    })
    const switched = await ctx.agents.create({
      sessionId: SessionId('progress-switched'),
      meta: { cwd: root },
      agentOptions: { provider: 'progress-switched', model: 'mock' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    const adapters = new Map<Agent, MockAdapter>()
    const releases: (() => void)[] = []
    try {
      await ctx.agentPresets.recompose(switched.agent.ctx, 'codex')
      for (const [owner, provider] of [
        [standard.agent, 'progress-standard'], [codex.agent, 'progress-codex'],
        [child.agent, 'progress-child'], [switched.agent, 'progress-switched'],
      ] as const) {
        owner.options.provider = provider
        owner.options.model = 'mock'
        // 固定外部模型，仍由真实工具、循环和作用域监听器驱动 40 次调用。
        const adapter = new MockAdapter([
          ...Array.from({ length: 40 }, (_, index) => toolCallResponse(`progress-${index}`, 'set_status', { text: '正在验证进度' })),
          textResponse('验证完成'),
        ])
        adapters.set(owner, adapter)
        releases.push(ctx.llm.registerAdapter([provider], adapter))
        owner.followup(createUserMessage({ content: [{ type: 'text', text: '连续检查当前工作' }], source: { kind: 'user' } }))
      }
      await Promise.all([...adapters.keys()].map(owner => owner.whenIdle()))
      for (const [owner, adapter] of adapters) {
        expect(adapter.requests).toHaveLength(41)
        const isReminder = (message: { role: string; source: unknown }): boolean =>
          message.role === 'user' && typeof message.source === 'object' && message.source !== null
          && 'kind' in message.source && message.source.kind === 'plugin'
          && 'plugin' in message.source && message.source.plugin === 'progress-reminder'
        const expected = owner === standard.agent ? 1 : 0
        expect(owner.session.events.filter(event => event.type === 'status/set'), owner.id).toHaveLength(40)
        expect(owner.session.events.filter(event => event.type === 'tool/result'), owner.id).toHaveLength(40)
        expect(owner.session.events.filter(event => event.type === 'assistant/message')
          .flatMap(event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text)), owner.id)
          .toEqual(['验证完成'])
        expect(adapter.requests.at(-1)?.messages.filter(isReminder), owner.id).toHaveLength(expected)
        expect(owner.session.events.filter(event => event.type === 'user/message'
          && event.data.source.kind === 'plugin' && event.data.source.plugin === 'progress-reminder'), owner.id)
          .toHaveLength(expected)
      }
    } finally {
      for (const release of releases) release()
      await Promise.all([standard.dispose(), codex.dispose(), child.dispose(), switched.dispose()])
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
