// @vitest-environment jsdom
/** 用真实 Assistant 行与 Markdown 复现语言标签在流式期间被隐藏的路径。 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ChatConversationViewNode, ChatSnapshot, ConversationSnapshot } from 'coding-client-runtime/client'
import { EMPTY_CHAT_SNAPSHOT } from 'coding-client-runtime/client'
import type { ChatNode, ChatNodeOwnerProps, ChatViewSlotProps } from 'coding-client-ui-conversation/client'
import { ChatNodeSeat } from '../../../client/ui-conversation/src/client/chat/ChatNodeSeat.tsx'
import { AssistantMarkdown } from '../../../client/ui-conversation/src/client/chat/AssistantMarkdown.tsx'
import { installDomFenceRenderer } from '../src/client/dom-fence.tsx'
import { setLocale } from '../src/client/i18n/index.ts'

const NODE_KEY = '14:assistant-step1:1'
const cleanups: Array<() => void> = []
let frames = new Map<number, FrameRequestCallback>()
let frameId = 0

beforeEach(() => {
  setLocale('zh')
  localStorage.clear()
  frames = new Map()
  frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frameId
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})

afterEach(() => {
  act(() => { for (const dispose of cleanups.splice(0)) dispose() })
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** 显式推进观察器与动画帧，避免真实计时器掩盖必须在完成前出现的加载态。 */
async function flushFrames(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  for (let pass = 0; pass < 8 && frames.size > 0; pass += 1) {
    await act(async () => {
      const current = [...frames.values()]
      frames.clear()
      for (const callback of current) callback(performance.now())
      await Promise.resolve()
    })
  }
}

function assistantNode(text: string, streaming: boolean): ChatNode<'assistant-step'> {
  return {
    key: NODE_KEY, id: '1:1', target: 'chat', kind: 'assistant-step', anchorSeq: 3,
    visibility: 'visible', location: { kind: 'session' },
    data: {
      status: streaming ? 'running' : 'settled', turn: 1, step: 1,
      blocks: [{ kind: 'text', text }], time: 0,
    },
  }
}

/** 只替换会话传输与时钟，保留生产的行 DOM、Markdown、解析与 React 根。 */
function harness(initial: string, options: { sourceInitiallyMissing?: boolean } = {}) {
  let node = assistantNode(initial, true)
  let sourceAvailable = options.sourceInitiallyMissing !== true
  const listeners = new Set<() => void>()
  const chat: ChatSnapshot = {
    ...EMPTY_CHAT_SNAPSHOT,
    order: [NODE_KEY],
    nodes: {
      get: key => sourceAvailable && key === NODE_KEY ? node : undefined,
      values: (): readonly ChatConversationViewNode[] => sourceAvailable ? [node] : [],
    },
  }
  const translate = ((key: string) => key) as ChatViewSlotProps['t']
  const owner: ChatNodeOwnerProps = {
    openFile: () => {}, openBrowserUrl: () => {}, inspectCall: () => {}, forkAt: () => {},
    retryTurn: async () => {},
    renderMessageImages: () => null, fileMentions: () => undefined,
  }
  const renderListeners = new Set<() => void>()
  const renderNodes = { get: (key: string) => key === NODE_KEY ? node : undefined, values: () => [node] }
  let renderSnapshot = { chat: { ...chat, nodes: renderNodes } }
  const subscribe = (listener: () => void) => {
    renderListeners.add(listener)
    return () => { renderListeners.delete(listener) }
  }
  const getSnapshot = () => renderSnapshot
  const useSession = ((select: (snapshot: Pick<ConversationSnapshot, 'chat'>) => unknown) => (
    select(useSyncExternalStore(subscribe, getSnapshot, getSnapshot))
  )) as ChatViewSlotProps['useSession']
  const renderSlot = ((_key: string, input: ChatNodeOwnerProps & { node: ChatNode<'assistant-step'> }) => (
    <AssistantMarkdown blocks={input.node.data.blocks} streaming={input.node.data.status === 'running'}
      renderMessageImages={owner.renderMessageImages} t={translate} />
  )) as ChatViewSlotProps['renderSlot']
  const element = () => <ChatNodeSeat {...owner} nodeKey={NODE_KEY} useSession={useSession} renderSlot={renderSlot} t={translate} />
  const view = render(element())
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ current: 'genui-stream-test' }), subscribe: () => () => {} },
      binding: () => ({ session: {
        getSnapshot: () => ({ chat }),
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      } }),
    },
  } as unknown as Context
  let stop = () => {}
  act(() => { stop = installDomFenceRenderer(ctx, () => {}) })
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    stop()
  }
  cleanups.push(dispose)
  return {
    view,
    update(text: string, streaming = true) {
      node = assistantNode(text, streaming)
      act(() => {
        renderSnapshot = { chat: { ...chat, nodes: renderNodes } }
        for (const listener of renderListeners) listener()
        for (const listener of listeners) listener()
      })
    },
    publishSource() {
      sourceAvailable = true
      for (const listener of listeners) listener()
    },
    dispose() { act(() => { dispose() }) },
  }
}

describe('GenUI 流式围栏', () => {
  it.each(['gen-ui', 'dsh-ui'])('%s 在组件完成前加载，并在整条回复完成前渲染', async (language) => {
    const opening = `说明文字\n\n\`\`\`${language}\n`
    const h = harness(`${opening}{`)
    await flushFrames()

    expect(h.view.container.querySelector('[data-chat-node-key]')?.getAttribute('data-chat-node-key')).toBe(NODE_KEY)
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('正在生成界面')
    const loading = h.view.container.querySelector('[data-genui-loading]') as HTMLElement
    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect(loading.querySelector('pre, code')).toBeNull()
    expect(loading.textContent).not.toContain('gen-ui')
    expect(screen.queryByRole('alert')).toBeNull()

    h.update(`${opening}{"items":[{"type":"text","content":"尚未闭合`)
    await flushFrames()
    expect(screen.getByRole('status')).toBe(status)
    expect(loading.textContent).not.toContain('尚未闭合')
    expect(loading.querySelector('pre, code')).toBeNull()

    const prefix = '{"items":[{"type":"text","content":"组件已到达"}'
    h.update(`${opening}${prefix},`)
    await flushFrames()
    expect(screen.queryByText('组件已到达', { selector: '[data-genui] *' })).not.toBeNull()
    expect(h.view.container.querySelector('[data-streaming]')).not.toBeNull()
    expect(h.view.container.querySelector('[data-genui-loading]')).toBeNull()

    h.update(`${opening}${prefix}]}\n\`\`\`\n\n继续说明`)
    await flushFrames()
    expect(h.view.container.querySelector('[data-genui]')?.textContent).toContain('组件已到达')
    expect(h.view.container.textContent).toContain('继续说明')
    h.update(`${opening}${prefix}]}\n\`\`\`\n\n继续说明`, false)
    await flushFrames()
    expect(h.view.container.querySelector('[data-streaming]')).toBeNull()
    expect(h.view.container.querySelector('[data-genui]')?.textContent).toContain('组件已到达')
  })

  it('等待源码到达时重试识别，不把普通 JSON 围栏变为界面', async () => {
    const raw = '{"items":[{"type":"text","content":"普通 JSON 示例"}]}'
    const opening = `\`\`\`json\n${raw}\n\`\`\`\n\n\`\`\`gen-ui\n{`
    const h = harness(opening, { sourceInitiallyMissing: true })
    await flushFrames()
    expect(h.view.container.querySelector('[data-genui-loading]')).toBeNull()
    h.publishSource()
    await flushFrames()
    expect(h.view.container.querySelectorAll('[data-genui-loading]')).toHaveLength(1)
    const json = [...h.view.container.querySelectorAll<HTMLElement>('.md-code-block')]
      .find(block => block.querySelector('pre')?.textContent === raw)
    expect(json?.style.display).not.toBe('none')
    expect(h.view.container.querySelector('[data-genui]')).toBeNull()
  })

  it('同一回复的多个围栏在定稿时保留已选的本地交互状态', async () => {
    const first = '```gen-ui\n{"items":[{"type":"text","content":"第一个围栏"}]}\n```\n\n'
    const second = '```gen-ui\n{"items":[{"type":"radio","label":"选择方案","options":["保留选择","另一个方案"],"group":"plan"}]}'
    const h = harness(first + second)
    await flushFrames()
    const choice = screen.getByRole<HTMLInputElement>('radio', { name: '保留选择' })
    fireEvent.click(choice)
    expect(choice.checked).toBe(true)
    h.update(first + second + '\n```', false)
    await flushFrames()
    expect(screen.getByRole('radio', { name: '保留选择' })).toBe(choice)
    expect(choice.checked).toBe(true)
  })

  it('历史 panel 字段仍在消息内渲染，不产生面板', async () => {
    const text = '```gen-ui\n{"panel":true,"items":[{"type":"text","content":"历史界面内容"}]}\n```'
    const h = harness(text)
    await flushFrames()
    expect(h.view.container.querySelector('[data-genui]')?.textContent).toContain('历史界面内容')
    h.update(text, false)
    await flushFrames()
    expect(h.view.container.querySelector('[data-genui]')?.textContent).toContain('历史界面内容')
    expect(document.querySelector('[data-genui-panel]')).toBeNull()
  })

  it('未完成的生成停止后去掉动画，恢复源码和可见诊断', async () => {
    const text = '```gen-ui\n{not json 半截'
    const h = harness(text)
    await flushFrames()
    expect(screen.getByRole('status')).toBeTruthy()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.update(text, false)
    await flushFrames()
    expect(h.view.container.querySelector('[data-genui-loading]')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('JSON')
    const code = h.view.container.querySelector<HTMLElement>('.md-code-block')
    expect(code?.style.display).not.toBe('none')
    expect(code?.querySelector('pre')?.textContent).toContain('半截')
    expect(warn).toHaveBeenCalled()
  })

  it('宿主清空或移动渲染容器后保留本地选择，不重复挂载', async () => {
    const text = '```gen-ui\n{"items":[{"type":"radio","options":["保留状态","其他"],"group":"state"}]}\n```'
    const h = harness(text)
    await flushFrames()
    const choice = screen.getByRole<HTMLInputElement>('radio', { name: '保留状态' })
    fireEvent.click(choice)
    const replacement = h.view.container.querySelector<HTMLElement>('.genui-dom-fence')!
    replacement.replaceChildren()
    await flushFrames()
    expect(screen.getByRole('radio', { name: '保留状态' })).toBe(choice)
    expect(choice.checked).toBe(true)
    replacement.remove()
    await flushFrames()
    expect(screen.getByRole('radio', { name: '保留状态' })).toBe(choice)
    expect(choice.checked).toBe(true)
  })

  it('卸载渲染器后恢复原始代码块，不遗留加载容器', async () => {
    const h = harness('\`\`\`gen-ui\n{')
    await flushFrames()
    expect(screen.getByRole('status')).toBeTruthy()
    h.dispose()
    expect(h.view.container.querySelector('[data-genui-loading]')).toBeNull()
    const code = h.view.container.querySelector<HTMLElement>('.md-code-block')
    expect(code?.style.display).toBe('')
    expect(within(code as HTMLElement).getByRole('button')).toBeTruthy()
  })
})
