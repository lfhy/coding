// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { SideChatPanel, type SideChatTransport } from '../src/client/SideChatPanel.tsx'
import { zh } from '../src/client/locales.ts'

const SID = 'temporary-1' as SessionId
const PARENT = 'ordinary-session' as SessionId
const t = makeTranslate(zh)
const event = (seq: number, type: string, data: unknown): SessionEvent =>
  ({ seq, time: 0, type, data }) as SessionEvent
const empty = { status: 'idle' as const, events: [] as SessionEvent[], views: [], interactions: [],
  nextSeq: 0, hasMore: false }

function transport(over: Partial<SideChatTransport> = {}) {
  return {
    create: vi.fn(over.create ?? (async (_sourceSessionId: SessionId) => SID)),
    send: vi.fn(over.send ?? (async () => {})),
    state: vi.fn(over.state ?? (async () => empty)),
    close: vi.fn(over.close ?? (async () => {})),
    respond: vi.fn(over.respond ?? (async () => true)),
  } satisfies SideChatTransport
}

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('侧边临时 Agent 聊天', () => {
  it('独立创建、展示自己的消息，发送后关闭标签释放 Host 会话', async () => {
    const api = transport({ state: async () => ({ ...empty, nextSeq: 2, events: [
      event(0, 'user/message', { content: [{ type: 'text', text: '临时问题' }], source: { kind: 'user' } }),
      event(1, 'assistant/message', { message: { content: [{ type: 'text', text: '临时回答' }] } }),
    ], views: [null, null] }) })
    const mounted = render(<SideChatPanel shown sourceSessionId={PARENT} transport={api} t={t} />)
    await screen.findByText('临时回答')
    expect(api.create).toHaveBeenCalledExactlyOnceWith(PARENT, expect.any(AbortSignal))
    expect(screen.getByText('临时问题')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: zh['sideChat.placeholder'] }), { target: { value: '再问一次' } })
    fireEvent.click(screen.getByRole('button', { name: zh['sideChat.send'] }))
    await waitFor(() => { expect(api.send).toHaveBeenCalledExactlyOnceWith(SID, '再问一次') })
    mounted.unmount()
    expect(api.close).toHaveBeenCalledExactlyOnceWith(SID)
  })

  it('显示 Agent 轮次失败，不把失败误认为仍在生成', async () => {
    const api = transport({ state: async () => ({ ...empty, nextSeq: 2, events: [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: '模型暂不可用', code: 'MODEL_OFFLINE' } } }),
    ], views: [null, null] }) })
    render(<SideChatPanel shown sourceSessionId={PARENT} transport={api} t={t} />)
    await screen.findByRole('alert')
    expect(screen.getByText('回复失败：模型暂不可用')).toBeTruthy()
  })

  it('审批/用户提问只显示当前临时聊天的待决请求，可回传结果', async () => {
    const api = transport({ state: async () => ({ ...empty, interactions: [{
      type: 'approval/requested' as const, rpcId: 'approval-rpc' as never, sideChatId: SID,
      approvalId: 'approval-id' as never, toolName: 'bash',
    }, {
      type: 'question/requested' as const, rpcId: 'question-rpc' as never, sideChatId: SID,
      questions: [{ id: 'one', question: '选哪项？', options: [{ label: '甲' }, { label: '乙' }] }],
    }] }) })
    render(<SideChatPanel shown sourceSessionId={PARENT} transport={api} t={t} />)
    await screen.findByText(zh['sideChat.approval'].replace('{tool}', 'bash'))
    fireEvent.click(screen.getByRole('button', { name: zh['sideChat.allow'] }))
    await waitFor(() => { expect(api.respond).toHaveBeenCalledWith(expect.objectContaining({ rpcId: 'approval-rpc',
      result: { ok: true, value: { sessionId: SID, approvalId: 'approval-id', outcome: 'allowed-once' } },
    })) })
    fireEvent.click(screen.getByRole('radio', { name: '乙' }))
    fireEvent.click(screen.getByRole('button', { name: zh['sideChat.answer'] }))
    await waitFor(() => { expect(api.respond).toHaveBeenCalledWith(expect.objectContaining({ rpcId: 'question-rpc',
      result: { ok: true, value: { sessionId: SID, answer: { answers: [{ id: 'one', selected: ['乙'] }] } } },
    })) })
  })

  it('创建仍在途时卸载，不发布会话并在创建兑现后关闭', async () => {
    const deferred = Promise.withResolvers<SessionId>()
    const api = transport({ create: () => deferred.promise })
    const mounted = render(<SideChatPanel shown sourceSessionId={PARENT} transport={api} t={t} />)
    mounted.unmount()
    await act(async () => { deferred.resolve(SID); await deferred.promise })
    await waitFor(() => { expect(api.close).toHaveBeenCalledExactlyOnceWith(SID) })
  })

  it('隐藏侧边标签仍按轮询续租，直到卸载才关闭', async () => {
    vi.useFakeTimers()
    try {
      const api = transport()
      const mounted = render(<SideChatPanel shown sourceSessionId={PARENT} transport={api} t={t} />)
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      mounted.rerender(<SideChatPanel shown={false} sourceSessionId={PARENT} transport={api} t={t} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(1300) })
      expect(api.state.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(api.close).not.toHaveBeenCalled()
      mounted.unmount()
      expect(api.close).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})
