import { describe, expect, it } from 'vitest'
import type { ChatConversationViewNode, UserMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import { buildConversationAnchors } from '../src/client/chat/conversation-anchors.ts'

const fallback = { image: '图片', empty: '空消息' }

function node(
  key: string,
  kind: string,
  seq: number,
  content: UserMessageNode['content'] = [],
  visibility: ChatConversationViewNode['visibility'] = 'visible',
): ChatConversationViewNode {
  return {
    key,
    kind,
    id: key,
    target: 'chat',
    anchorSeq: seq,
    location: { kind: 'session' },
    visibility,
    data: { kind, seq, content },
  }
}

function build(order: readonly string[], values: readonly ChatConversationViewNode[]) {
  const byKey = new Map(values.map(value => [value.key, value]))
  return buildConversationAnchors(order, byKey, fallback)
}

describe('buildConversationAnchors', () => {
  it('preserves loaded order, stable keys, and durable seq for user and steering messages', () => {
    const values = [
      node('user:5', 'user', 5, [{ type: 'text', text: 'First\n  detail' }]),
      node('steer:9', 'steering', 9, [{ type: 'text', text: 'Second' }]),
      node('user:14', 'user', 14, [{ type: 'text', text: 'Third' }]),
    ]
    expect(build(['user:14', 'user:5', 'steer:9'], values)).toEqual([
      { key: 'user:14', seq: 14, title: 'Third', preview: 'Third' },
      { key: 'user:5', seq: 5, title: 'First', preview: 'First detail' },
      { key: 'steer:9', seq: 9, title: 'Second', preview: 'Second' },
    ])
  })

  it('excludes hidden, unloaded, context, assistant, tool, and compaction nodes', () => {
    const values = [
      node('visible', 'user', 1, [{ type: 'text', text: 'Kept' }]),
      node('hidden', 'steering', 2, [{ type: 'text', text: 'Hidden' }], 'hidden'),
      node('context', 'context', 3),
      node('assistant', 'assistant-step', 4),
      node('tool', 'tool-call', 5),
      node('compaction', 'compaction', 6),
      node('pending', 'pending-steering', 7),
    ]
    const order = [...values.map(value => value.key), 'not-loaded', 'visible']
    expect(build(order, values)).toEqual([{ key: 'visible', seq: 1, title: 'Kept', preview: 'Kept' }])
    expect(build([], values)).toEqual([])
  })

  it('uses localized fallbacks for image-only and empty/nontext messages', () => {
    const image = { type: 'image', attachment: {} } as UserMessageNode['content'][number]
    const values = [
      node('image', 'user', 1, [image]),
      node('empty', 'steering', 2),
      node('nontext', 'user', 3, [{ type: 'reasoning', text: 'Do not show this' }]),
      node('mixed', 'user', 4, [image, { type: 'text', text: 'Caption' }]),
    ]
    expect(build(values.map(value => value.key), values)).toEqual([
      { key: 'image', seq: 1, title: '图片', preview: '图片' },
      { key: 'empty', seq: 2, title: '空消息', preview: '空消息' },
      { key: 'nontext', seq: 3, title: '空消息', preview: '空消息' },
      { key: 'mixed', seq: 4, title: 'Caption', preview: 'Caption' },
    ])
  })

  it('joins text blocks for the excerpt while keeping the first line as title', () => {
    const message = node('blocks', 'user', 8, [
      { type: 'text', text: '  第一行\r\n' },
      { type: 'reasoning', text: 'invisible' },
      { type: 'text', text: '第二行\t 还有内容' },
    ])
    expect(build(['blocks'], [message])).toEqual([
      { key: 'blocks', seq: 8, title: '第一行', preview: '第一行 第二行 还有内容' },
    ])
  })

  it('bounds multiline CJK title, excerpt, scanned blocks, and source text', () => {
    const long = '中'.repeat(1_000_000)
    const values = [
      node('long', 'user', 1, [
        { type: 'text', text: `  ${long}\n${'后'.repeat(1_000)}` },
      ]),
      node('blocks', 'user', 2, [
        ...Array.from({ length: 32 }, () => ({ type: 'reasoning' as const, text: 'ignored' })),
        { type: 'text', text: 'outside scan budget' },
      ]),
    ]
    const [bounded, blocks] = build(['long', 'blocks'], values)
    if (bounded === undefined || blocks === undefined) throw new Error('Expected two loaded anchors')
    expect(bounded.title).toBe('中'.repeat(64))
    expect(bounded.preview).toBe('中'.repeat(160))
    expect(blocks.title).toBe('空消息')
    expect(blocks.preview).toBe('空消息')
  })
})
