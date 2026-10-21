// 上游 fence-feedback 持久化生命周期测试：跨插件重载的修正次数恢复、
// 会话种子恢复与 delivery 提醒共享。宿主 SessionStore 仅属于 Host 编译面，
// 因此用独立的 Host 测试工程检查本文件，不能放入 Client aggregate。
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage, markAgentLoopRequest } from 'coding-llm'
import type { GenerateOptions, StreamChunk } from 'coding-llm'
import SessionStore, { SessionId } from 'coding-session'
import type {} from 'coding-agent'
import { installFenceFeedback } from '../src/plugin/fence-feedback.ts'


/** 把字面量数组包成异步流。 */
async function* streamChunks(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk
}

/** 收集 middleware 结果，以检查终止 finish。 */
async function collectChunks(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

/** 使用 agent loop 的公开标记标识请求。 */
function agentRequest(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return markAgentLoopRequest({
    provider: 'test-provider',
    model: 'test-model',
    messages: [],
    sessionId: 'sess-1' as NonNullable<GenerateOptions['sessionId']>,
    ...overrides,
  })
}

/** 一条坏围栏正文：stat 缺 label，渲染必失败。 */
const BROKEN = JSON.stringify({ items: [{ type: 'stat' }] })

/** 构造包含 dsh-ui 围栏的回复正文。 */
function reply(...bodies: string[]): string {
  return bodies.map(body => '```dsh-ui\n' + body + '\n```').join('\n')
}

/** 创建持久化会话 + 已安装 fence-feedback 的闭环 harness。 */
async function persistedFeedbackHarness() {
  const ctx = new Context()
  const sessionPlugin = await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('persisted-feedback'))
  const applyFeedback = (feedbackCtx: Context) =>{  installFenceFeedback(feedbackCtx, true) }
  let feedback = await ctx.plugin(applyFeedback)
  let turn = 7
  const steer = vi.fn((message: Parameters<typeof session.append<'user/message'>>[1]) => {
    session.append('user/message', message, { surfaceOp: 'append' })
  })
  const agent = { session, steer }
  return {
    ctx,
    session,
    steer,
    startTurn: (nextTurn = 7) => {
      turn = nextTurn
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '请展示界面' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    },
    validate: () => {
      session.append('tool/call', {
        turn, step: 1, callId: `validate-${String(session.seq)}` as never, name: 'validate_dsh_ui', arguments: '{}',
      })
    },
    assistant: (body: string) => {
      session.append('assistant/message', {
        turn, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: reply(body) }], source: { provider: 'test', model: 'test' },
        }),
      }, { surfaceOp: 'append' })
    },
    boundary: () =>{  ctx.emit('agent/turn-stopping', { agent: agent as never, turn, signal: new AbortController().signal }) },
    reload: async (duringReload?: () => void | Promise<void>) => {
      await feedback.dispose()
      const reloading = ctx.plugin(applyFeedback)
      await Promise.resolve()
      const pendingEvent = duringReload?.()
      feedback = await reloading
      await pendingEvent
    },
    dispose: async () => {
      await feedback.dispose()
      await sessionPlugin.dispose()
    },
  }
}

describe('persisted fence feedback lifecycle', () => {
  it.each([false, true])('allows the same broken fence in a new turn while preserving reload deduplication (reload=%s)', async (reload) => {
    const h = await persistedFeedbackHarness()
    try {
      h.startTurn()
      h.assistant(BROKEN)
      h.boundary()
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(1)

      h.startTurn(8)
      if (reload) await h.reload()
      h.assistant(BROKEN)
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(2)

      await h.reload()
      h.assistant(BROKEN)
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(2)
      h.assistant('{"items":[{"type":"stat","label":"second"}]}')
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(3)
      h.assistant('{"items":[{"type":"stat","label":"third"}]}')
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(3)
    } finally {
      await h.dispose()
    }
  })

  it('keeps the two-correction cap across a real plugin reload and resets it for the next turn', async () => {
    const h = await persistedFeedbackHarness()
    try {
      h.startTurn()
      h.assistant(BROKEN)
      h.boundary()
      h.assistant('{"items":[{"type":"stat","label":"second"}]}')
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(2)
      await h.reload()
      h.assistant('{"items":[{"type":"stat","label":"third"}]}')
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(2)

      h.startTurn(8)
      h.assistant('{"items":[{"type":"stat","label":"new-turn"}]}')
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(3)
    } finally {
      await h.dispose()
    }
  })

  it('restores the correction cap before a new message arrives during plugin reload', async () => {
    const h = await persistedFeedbackHarness()
    try {
      h.startTurn()
      h.assistant(BROKEN)
      h.boundary()
      h.assistant('{"items":[{"type":"stat","label":"second"}]}')
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(2)

      await h.reload(() =>{  h.assistant('{"items":[{"type":"stat","label":"third"}]}') })
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(2)
    } finally {
      await h.dispose()
    }
  })

  it('restores pending feedback before a turn boundary arrives during plugin reload', async () => {
    const h = await persistedFeedbackHarness()
    try {
      h.startTurn()
      h.assistant(BROKEN)
      await h.reload(() =>{  h.boundary() })
      expect(h.steer).toHaveBeenCalledTimes(1)
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(1)
    } finally {
      await h.dispose()
    }
  })

  it('keeps reasoning-only host recovery active for a model request during plugin reload', async () => {
    const h = await persistedFeedbackHarness()
    try {
      h.startTurn()
      h.validate()
      let chunks: StreamChunk[] = []
      await h.reload(async () => {
        chunks = await collectChunks(h.ctx.waterfall('llm/stream', agentRequest({ sessionId: h.session.id }), () => streamChunks([
          { type: 'block-start', index: 0, blockType: 'reasoning' },
          { type: 'reasoning-delta', index: 0, text: 'private reasoning draft' },
          { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'private reasoning draft' } },
          { type: 'finish', reason: { kind: 'stop' } },
        ])))
      })
      expect(chunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } },
      })
    } finally {
      await h.dispose()
    }
  })

  it('keeps a persisted delivery reminder silent after reload and shares the remaining slot with render feedback', async () => {
    const h = await persistedFeedbackHarness()
    try {
      h.startTurn()
      h.validate()
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(1)
      await h.reload()
      h.validate()
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(1)

      h.assistant(BROKEN)
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(2)
      await h.reload()
      h.assistant('{"items":[{"type":"stat","label":"third"}]}')
      h.boundary()
      expect(h.steer).toHaveBeenCalledTimes(2)
    } finally {
      await h.dispose()
    }
  })

  it('adopts correction history when the host restores a session from its stored events', async () => {
    const h = await persistedFeedbackHarness()
    try {
      h.startTurn()
      h.assistant(BROKEN)
      h.boundary()
      h.assistant('{"items":[{"type":"stat","label":"second"}]}')
      h.boundary()
      const restored = h.ctx.sessions.create(SessionId('restored-feedback'), { seed: h.session.events })
      const steer = vi.fn()
      restored.append('assistant/message', {
        turn: 7, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: reply('{"items":[{"type":"stat","label":"third"}]}') }],
          source: { provider: 'test', model: 'test' },
        }),
      }, { surfaceOp: 'append' })
      h.ctx.emit('agent/turn-stopping', {
        agent: { session: restored, steer } as never, turn: 7, signal: new AbortController().signal,
      })
      expect(steer).not.toHaveBeenCalled()
    } finally {
      await h.dispose()
    }
  })
})
