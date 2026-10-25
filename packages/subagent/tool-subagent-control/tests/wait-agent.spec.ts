import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from 'coding-llm'
import type { GenerateOptions, StreamChunk } from 'coding-llm'
import { LlmAdapter } from 'coding-llm'
import AgentLoop from 'coding-agent-loop'
import { mountAgentLoopTestDependencies } from 'coding-agent-loop-testkit'
import { SessionId } from 'coding-session'
import JsonlSessionPersistence from 'coding-session-persistence-jsonl'
import SessionProjectionRegistry from 'coding-session-projection'
import SubagentRuntime from 'coding-subagent'
import * as SubagentSpawn from 'coding-subagent-spawn-in-process'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/wait-agent.ts'
import { parkParent } from './park-parent.ts'

/** 一次可能要等测试放行的模型调用，用来让子级在父级等待期间保持运行。 */
interface GatedEntry {
  chunks: StreamChunk[]
  gate?: Promise<undefined>
}

/** 脚本适配器：条目可挂着直到测试放行，从而精确控制子级结算时机。 */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: GatedEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('GatedAdapter: script exhausted')
    if (entry.gate) await entry.gate
    for (const chunk of entry.chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

/** 测试用的紧凑预算：真实默认值以分钟计，等待逻辑本身就应按毫秒级验证。 */
const TIMEOUT_CONFIG = { defaultTimeoutMs: 60, minTimeoutMs: 20, maxTimeoutMs: 1_000 }
const testToolSignal = new AbortController().signal

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setupWith(adapter: LlmAdapter, config: Partial<typeof TIMEOUT_CONFIG> = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-wait-agent-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(tool, { ...TIMEOUT_CONFIG, ...config })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  parkParent(ctx, parent)
  return { ctx, parent, adapter }
}

/** 等待与真实工具卡片一致：结果内容就是模型读到的那段文本。 */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let calls = 0
function callTool(
  ctx: Context,
  args: unknown,
  agent?: unknown,
  signal: AbortSignal = testToolSignal,
) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`call-${++calls}`),
    name: 'wait_agent',
    arguments: args,
    ...agent !== undefined ? { agent: agent as never } : {},
  })
}

/** 让事件循环推进到工具内部的监听注册完成。 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('dsh-tool-subagent-control/wait-agent', () => {
  it('registers wait_agent once with only the optional timeout_ms parameter', async () => {
    const { ctx } = await setupWith(new GatedAdapter([{ chunks: textResponse('done') }]))
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'wait_agent')
    expect(schemas).toHaveLength(1)
    const parameters = schemas[0]!.parameters as {
      properties?: Record<string, { type?: string }>
      required?: string[]
    }
    expect(Object.keys(parameters.properties ?? {})).toEqual(['timeout_ms'])
    expect(parameters.properties?.timeout_ms?.type).toBe('integer')
    expect(parameters.required ?? []).toEqual([])
    expect(schemas[0]!.description).toContain('mailbox update')
    expect(schemas[0]!.description).toContain('does not return the content')
  })

  it('wakes on a child settlement notice without polling and without echoing content', async () => {
    const gate = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child finished'), gate: gate.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const delivered: string[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === parent) delivered.push(message.source.kind)
    })
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'long work',
      request: { prompt: [{ type: 'text', text: 'long work' }], parent },
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    const waiting = callTool(ctx, { timeout_ms: 1_000 }, parent)
    await flush()
    gate.resolve(undefined)

    const result = await waiting
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Wait completed.')
    // 通知内容按原投递边界进入父级邮箱，而不是随等待结果回传。
    expect(delivered).toContain('subagent-settled')
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() })
  })

  it('reports steered user input separately from agent delivery', async () => {
    const { ctx, parent } = await setupWith(new GatedAdapter([]))
    const waiting = callTool(ctx, {}, parent)
    await flush()
    parent.steer(createUserMessage({
      content: [{ type: 'text', text: 'change of plan' }],
      source: { kind: 'user' },
    }))

    const result = await waiting
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Wait interrupted by new input.')
  })

  it('reports a timeout summary when no delivery arrives', async () => {
    const { ctx, parent } = await setupWith(new GatedAdapter([]))
    const result = await callTool(ctx, {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Wait timed out.')
  })

  it('clamps a request below the minimum and says so in the summary', async () => {
    const { ctx, parent } = await setupWith(new GatedAdapter([]))
    const result = await callTool(ctx, { timeout_ms: 5 }, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Wait timed out.\n\nRequested timeout of 5ms was clamped to the minimum of 20ms.')
  })

  it('rejects a request above the maximum instead of truncating it', async () => {
    const { ctx, parent } = await setupWith(new GatedAdapter([]))
    const result = await callTool(ctx, { timeout_ms: 5_000 }, parent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('timeout_ms must be at most 1000')
  })

  it('returns immediately when the inbox already holds work', async () => {
    const { ctx, parent } = await setupWith(new GatedAdapter([]))
    parent.send(createUserMessage({
      content: [{ type: 'text', text: 'already queued' }],
      source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
    }), 'next-step', false)
    const result = await callTool(ctx, {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Wait completed.')
  })

  it('settles on cancellation instead of waiting out the budget', async () => {
    const { ctx, parent } = await setupWith(new GatedAdapter([]))
    const controller = new AbortController()
    const waiting = callTool(ctx, { timeout_ms: 1_000 }, parent, controller.signal)
    await flush()
    controller.abort(new Error('turn cancelled'))
    const result = await waiting
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('turn cancelled')
  })

  it('fails loud when invoked without a calling agent', async () => {
    const { ctx } = await setupWith(new GatedAdapter([]))
    const result = await callTool(ctx, {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('rejects a deployment whose budget range is inconsistent', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(tool, { defaultTimeoutMs: 5, minTimeoutMs: 20, maxTimeoutMs: 1_000 }))
      .rejects.toThrow(/defaultTimeoutMs must fall inside/)
  })

  it('unregisters with its plugin fiber (HMR safety)', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const fiber = await ctx.plugin(tool, TIMEOUT_CONFIG)
    expect(ctx.tools.schemas().some(schema => schema.name === 'wait_agent')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'wait_agent')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent-wait-agent')
    expect(tool.inject).toEqual(['tools'])
    expect(typeof tool.apply).toBe('function')
  })
})
