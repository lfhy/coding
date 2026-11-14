/** 真实 Loader/YAML 与 AgentLoop 组合，只替换外部模型；事实、提醒和历史查询均使用交付实现。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from 'coding-agent'
import AgentLoop from 'coding-agent-loop'
import LlmRuntime, { createUserMessage, type GenerateOptions } from 'coding-llm'
import { createApiProxy, RpcId } from 'coding-host-apiproxy'
import SessionStore, { Session, SessionId } from 'coding-session'
import SessionProjectionRegistry from 'coding-session-projection'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime from 'coding-tools'
import UserQuestionService from 'coding-user-questions'
import * as ProgressReminder from 'coding-progress-reminder'
import * as ToolStatus from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

let context: Context | undefined
let root: string | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(adapter: MockAdapter): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'coding-status-loader-'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['coding-llm', LlmRuntime], ['coding-session', SessionStore],
    ['coding-system-prompt', SystemPrompt], ['coding-tools', ToolRuntime],
    ['coding-agent', AgentRegistry], ['coding-agent-loop', AgentLoop],
    ['coding-session-projection', SessionProjectionRegistry],
    ['coding-user-questions', UserQuestionService],
    ['coding-tool-status', ToolStatus], ['coding-progress-reminder', ProgressReminder],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: new URL('./fixtures/cordis.yml', import.meta.url).href },
  })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)).toEqual([])
  ctx.llm.registerAdapter(['scripted'], adapter)
  return ctx
}

function prompt() {
  return createUserMessage({ content: [{ type: 'text', text: '检查并验证本轮工作' }], source: { kind: 'user' } })
}

function reminders(request: GenerateOptions) {
  return request.messages.filter(message => message.role === 'user'
    && message.source.kind === 'plugin' && message.source.plugin === 'progress-reminder')
}

describe('set_status 真实 Loader 组合', () => {
  it('实际模型调用持久事实，经实时投影与历史 API 读取，轮次结束及下一轮清空', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('status-1', 'set_status', { text: '  正在检查真实组合  ' }),
      toolCallResponse('status-2', 'set_status', { text: '正在验证实际调用' }),
      textResponse('验证完成。'),
      textResponse('下一轮完成。'),
    ])
    const ctx = await boot(adapter)
    if (root === undefined) throw new Error('missing Loader temporary directory')
    const owner = ctx.agentLoop.create(SessionId('status-loader-agent'), { provider: 'scripted', model: 'mock' })
    const other = ctx.agentLoop.create(SessionId('status-loader-other'), { provider: 'scripted', model: 'mock' })
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'scripted', model: 'mock' }), cwd: root })
    let rpc = 0
    const history = async (beforeSeq?: number) => {
      const response = await api.sessions.history({
        rpcId: RpcId(`status-history-${++rpc}`),
        payload: { sessionId: owner.id, ...(beforeSeq === undefined ? {} : { beforeSeq }) },
      })
      if (!response.result.ok) throw new Error(`history failed: ${response.result.error.message}`)
      return response.result.value
    }
    const paused = Promise.withResolvers<undefined>()
    const continueRequest = Promise.withResolvers<undefined>()
    const requestCuts: { turn: number; text: string | null | undefined }[] = []
    ctx.on('agent/request', async ({ agent, turn, step }, next) => {
      if (agent === owner) {
        requestCuts.push({ turn, text: ctx.sessionProjections.snapshot(agent.session).values.turnStatus })
        if (turn === 1 && step === 3) {
          paused.resolve(undefined)
          await continueRequest.promise
        }
      }
      return next()
    })
    const changes: { text: unknown; seq: number }[] = []
    ctx.sessionProjections.onChanged((session, key, value, seq) => {
      if (session === owner.session && key === 'turnStatus') changes.push({ text: value, seq })
    })
    const cutBefore = await history()
    expect(cutBefore.projections?.values.turnStatus).toBeNull()

    owner.followup(prompt())
    try {
      await paused.promise
      const facts = owner.session.events.filter(event => event.type === 'status/set')
      expect(facts.map(event => event.data)).toEqual([
        { turn: 1, text: '正在检查真实组合' }, { turn: 1, text: '正在验证实际调用' },
      ])
      const calls = owner.session.events.filter(event => event.type === 'tool/call')
      const results = owner.session.events.filter(event => event.type === 'tool/result')
      expect(calls.map(event => event.data.name)).toEqual(['set_status', 'set_status'])
      expect(results.map(event => event.data.message.content[0])).toEqual([
        { type: 'tool-result', toolCallId: 'status-1', isError: false, content: [{ type: 'text', text: 'Current progress: 正在检查真实组合' }] },
        { type: 'tool-result', toolCallId: 'status-2', isError: false, content: [{ type: 'text', text: 'Current progress: 正在验证实际调用' }] },
      ])
      for (const [index, fact] of facts.entries()) {
        expect(calls[index]?.seq).toBeLessThan(fact.seq)
        expect(results[index]?.seq).toBeGreaterThan(fact.seq)
      }
      const live = await history()
      expect(live.projections).toMatchObject({ asOfSeq: owner.session.seq - 1, values: { turnStatus: '正在验证实际调用' } })
      expect(live.events.filter(entry => entry.event.type === 'tool/call').map(entry => entry.view)).toEqual([
        { for: 'call', view: { card: 'generic', title: '更新当前进度', kind: 'other' } },
        { for: 'call', view: { card: 'generic', title: '更新当前进度', kind: 'other' } },
      ])
      expect((await history(owner.session.seq)).projections).toBeUndefined()
      expect(ctx.sessionProjections.snapshot(other.session).values.turnStatus).toBeNull()
      expect(other.session.events.some(event => event.type === 'status/set')).toBe(false)
      const replay = Session.create(SessionId('loader-replay'), owner.session.events)
      expect(ctx.sessionProjections.snapshot(replay).values.turnStatus).toBe('正在验证实际调用')
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[0]?.tools?.find(tool => tool.name === 'set_status'))
        .toEqual(ctx.tools.schemas().find(tool => tool.name === 'set_status'))
      const followup = adapter.requests[1]
      expect(followup).toBeDefined()
      if (followup === undefined) throw new Error('missing followup request')
      expect(reminders(followup)).toHaveLength(1)
      const reminder = reminders(followup)[0]
      expect(reminder?.content).toEqual([{ type: 'text', text: ProgressReminder.renderProgressReminder(1) }])
      expect(JSON.stringify(reminder)).toContain('若当前可用工具中有 `set_status`')
      expect(owner.session.events.some(event => event.type === 'user/message'
        && event.data.id === reminder?.id)).toBe(true)
    } finally {
      continueRequest.resolve(undefined)
      await owner.whenIdle()
    }

    expect(owner.session.events.filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect((await history()).projections).toMatchObject({ asOfSeq: owner.session.seq - 1, values: { turnStatus: null } })
    const closedReplay = Session.create(SessionId('loader-closed-replay'), owner.session.events)
    expect(ctx.sessionProjections.snapshot(closedReplay).values.turnStatus).toBeNull()
    expect(changes.filter(change => change.text !== null).map(change => change.text))
      .toEqual(['正在检查真实组合', '正在验证实际调用'])
    expect(changes.at(-1)?.text).toBeNull()
    expect(adapter.requests[2]?.messages).toEqual(owner.session.deriveMessages().slice(0, -1))
    const persistedReminders = owner.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin' && event.data.source.plugin === 'progress-reminder')
    expect(persistedReminders).toHaveLength(2)

    owner.followup(prompt())
    await owner.whenIdle()
    expect(adapter.requests).toHaveLength(4)
    expect(requestCuts).toEqual([
      { turn: 1, text: null }, { turn: 1, text: '正在检查真实组合' },
      { turn: 1, text: '正在验证实际调用' }, { turn: 2, text: null },
    ])
    expect((await history()).projections?.values.turnStatus).toBeNull()
  }, 15_000)

  it('非法模型参数保留错误调用轨迹，不追加 status/set，也不生成成功值', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('invalid-status', 'set_status', { text: '第一行\n第二行' }),
      textResponse('改为继续检查。'),
    ])
    const ctx = await boot(adapter)
    const owner = ctx.agentLoop.create(SessionId('invalid-model-status'), { provider: 'scripted', model: 'mock' })
    owner.followup(prompt())
    await owner.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(owner.session.events.filter(event => event.type === 'status/set')).toEqual([])
    expect(owner.session.events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    const result = owner.session.events.find(event => event.type === 'tool/result')
    expect(result?.data.message.content[0].isError).toBe(true)
    expect(ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBeNull()
    expect(adapter.requests[1]?.messages).toEqual(owner.session.deriveMessages().slice(0, -1))
  }, 15_000)
})
