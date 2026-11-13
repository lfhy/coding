// @vitest-environment jsdom
/** 工具行发送必须以当前会话中仍可见的已结算结果为准。 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallViewProps } from 'coding-client-ui-tool/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GenuiMessageContext } from '../src/client/message-context.ts'
import { setLocale } from '../src/client/i18n/index.ts'
import { toolTopicSender } from '../src/client/tool-topic-sender.ts'
import { GenuiToolView } from '../src/client/toolview.tsx'

const meta = { items: [{ type: 'topic-guide', id: 'followup', question: '想继续聊什么？',
  options: [{ label: '部署', message: '请继续讨论部署。' }] }] }

function fixture() {
  const block = {
    kind: 'tool-result', seq: 10, time: 0, callId: 'call-a', call: { name: 'render_ui', argsRaw: '{}' },
    callTime: 0, isError: false, content: [], callView: null, resultView: null, subCalls: [], meta,
  }
  const props = { toolName: 'render_ui', sessionId: 'session-a', callId: 'call-a', block,
    openFile: () => {} } as ToolCallViewProps
  let currentSession = 'session-a'
  let root: typeof block | { callId: string; subCalls: typeof block[] } = block
  let visible = true
  const ctx = { sessions: {
    list: { getSnapshot: () => ({ current: currentSession }) },
    binding: () => ({ session: { getSnapshot: () => ({ chat: { nodes: {
      values: () => visible ? [{ kind: 'tool-call', visibility: 'visible', data: { root } }] : [],
    } } }) } }),
  } } as unknown as Context
  const send = vi.fn(async () => {})
  return { props, ctx, send,
    switchSession: (sessionId: string) => { currentSession = sessionId },
    replaceResult: () => { root = { ...block } },
    nestResult: () => { root = { callId: 'root', subCalls: [block] } },
    hideResult: () => { visible = false },
  }
}

beforeEach(() => { localStorage.clear(); setLocale('zh') })
afterEach(cleanup)

describe('话题引导工具行来源', () => {
  it('当前可见结果点选后发送普通消息，子调用也保持所属关系', async () => {
    const h = fixture()
    h.nestResult()
    const sender = toolTopicSender(h.ctx, h.props, h.send)
    render(<GenuiMessageContext.Provider value={sender}><GenuiToolView {...h.props} /></GenuiMessageContext.Provider>)
    const choice = screen.getByRole<HTMLButtonElement>('radio', { name: '部署' })
    expect(choice.disabled).toBe(false)
    expect(screen.getByText('请继续讨论部署。')).toBeTruthy()
    fireEvent.click(choice)
    await act(async () => { await Promise.resolve() })
    expect(h.send).toHaveBeenCalledExactlyOnceWith('请继续讨论部署。')
  })

  it('切换会话、旧结果替换或隐藏后拒绝发送', async () => {
    for (const revoke of ['switch', 'replace', 'hide'] as const) {
      const h = fixture()
      const sender = toolTopicSender(h.ctx, h.props, h.send)
      if (revoke === 'switch') h.switchSession('session-b')
      if (revoke === 'replace') h.replaceResult()
      if (revoke === 'hide') h.hideResult()
      await expect(sender?.('请继续讨论部署。')).rejects.toThrow()
      expect(h.send).not.toHaveBeenCalled()
    }
  })

  it('运行中、失败或来源不匹配的结果不提供发送能力', () => {
    const h = fixture()
    const block = h.props.block
    if (!('kind' in block)) throw new Error('需要已结算结果')
    for (const mismatch of [
      { ...h.props, block: { ...block, isError: true } },
      { ...h.props, block: { ...block, call: null } },
      { ...h.props, block: { ...block, call: { name: 'other', argsRaw: '{}' } } },
      { ...h.props, callId: 'foreign' },
      { ...h.props, block: { callId: 'call-a', name: 'render_ui', argsRaw: '{}', time: 0, turn: 1, step: 1,
        callView: null, subCalls: [] } },
    ] as ToolCallViewProps[]) {
      expect(toolTopicSender(h.ctx, mismatch, h.send)).toBeUndefined()
    }
    render(<GenuiMessageContext.Provider value={undefined}><GenuiToolView {...h.props} /></GenuiMessageContext.Provider>)
    expect(screen.getByRole<HTMLButtonElement>('radio', { name: '部署' }).disabled).toBe(true)
  })
})
