// @vitest-environment jsdom
/** 行身份是围栏扩展恢复原始 Markdown 的入口，不能等定稿时才出现。 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatSnapshot, ConversationSnapshot } from 'coding-client-runtime/client'
import { EMPTY_CHAT_SNAPSHOT } from 'coding-client-runtime/client'
import type { ChatNode, ChatViewSlotProps } from 'coding-client-ui-conversation/client'
import { ChatNodeSeat } from '../src/client/chat/ChatNodeSeat.tsx'

afterEach(cleanup)

describe('ChatNodeSeat 源码身份', () => {
  it('流式和定稿的同一行均携带 ChatSnapshot 的节点 key', () => {
    const key = '14:assistant-step1:1'
    let node: ChatNode<'assistant-step'> = {
      key, id: '1:1', target: 'chat', kind: 'assistant-step', anchorSeq: 3,
      visibility: 'visible', location: { kind: 'session' },
      data: { status: 'running', turn: 1, step: 1, blocks: [{ kind: 'text', text: '```gen-ui\n{' }], time: 0 },
    }
    const chat: ChatSnapshot = { ...EMPTY_CHAT_SNAPSHOT, nodes: {
      get: target => target === key ? node : undefined, values: () => [node],
    } }
    const props = {
      nodeKey: key,
      useSession: ((select: (snapshot: Pick<ConversationSnapshot, 'chat'>) => unknown) => select({ chat })) as ChatViewSlotProps['useSession'],
      renderSlot: (() => node.data.status) as ChatViewSlotProps['renderSlot'],
      t: ((value: string) => value) as ChatViewSlotProps['t'],
      openFile: () => {}, openBrowserUrl: () => {}, inspectCall: () => {}, forkAt: () => {},
      retryTurn: async () => {},
      renderMessageImages: () => null, fileMentions: () => undefined,
    }
    const view = render(<ChatNodeSeat {...props} />)
    const row = view.container.firstElementChild
    expect(row?.getAttribute('data-chat-node-key')).toBe(key)
    expect(row?.textContent).toBe('running')
    node = { ...node, data: { ...node.data, status: 'settled' } }
    view.rerender(<ChatNodeSeat {...props} cwd="changed-to-refresh-owner" />)
    expect(view.container.firstElementChild).toBe(row)
    expect(row?.getAttribute('data-chat-node-key')).toBe(key)
    expect(row?.textContent).toBe('settled')
  })
})
