// @vitest-environment jsdom
/** Markdown 里的 ```mermaid 围栏：定稿后接管为图表，可切回源码，流式期间保持原文。 */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { MarkdownText } from 'coding-client-ui-primitives'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installDomFenceRenderer } from '../src/client/dom-fence.tsx'
import { setLocale } from '../src/client/i18n/index.ts'

const renderMermaid = vi.fn(async () => '<svg data-testid="diagram"></svg>')

vi.mock('../src/client/mermaid-lazy.ts', () => ({
  renderMermaid: () => renderMermaid(),
  assertSafeSvg: () => {},
  ensureFlowchartKind: (code: string) => code,
  repairMermaidSource: (code: string) => code,
}))

const SOURCE = 'flowchart LR\n  A[请求] --> B[响应]'
const cleanups: Array<() => void> = []
let frames = new Map<number, FrameRequestCallback>()
let frameId = 0

beforeEach(() => {
  setLocale('zh')
  localStorage.clear()
  renderMermaid.mockClear()
  frames = new Map()
  frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frameId
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  // jsdom 没有 matchMedia；MermaidNode 用它判断暗色主题。
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
})

afterEach(() => {
  act(() => { for (const dispose of cleanups.splice(0)) dispose() })
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

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
  // 引擎 Promise 与 MermaidNode 的状态更新都要走到 React 之外的一拍。
  await act(async () => { await Promise.resolve() })
}

/** 宿主 Markdown 代码表面：banner 语言标签 + 一个 `<pre>` 代码体。 */
function mountSurface(options: { streaming: boolean }): { row: HTMLElement; block: HTMLElement } {
  const row = document.createElement('div')
  row.dataset.chatAnchorKey = '7:assistant-step1:1'
  row.dataset.chatFlowKind = 'assistant-step'
  const wrapper = document.createElement('div')
  if (options.streaming) wrapper.dataset.streaming = 'true'
  wrapper.innerHTML = '<div class="md-code-block"><div>mermaid</div><pre></pre></div>'
  const block = wrapper.querySelector<HTMLElement>('.md-code-block')!
  block.querySelector('pre')!.textContent = SOURCE
  row.append(wrapper)
  document.body.append(row)
  return { row, block }
}

function install(): void {
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} } },
  } as unknown as Context
  act(() => { cleanups.push(installDomFenceRenderer(ctx, () => {})) })
}

describe('Mermaid 围栏', () => {
  it('真实 Markdown 正文里的 mermaid 围栏接管为图表，并可在源码与预览之间切换', async () => {
    const view = render(<div data-chat-flow-kind="assistant-step" data-chat-anchor-key="7:assistant-step1:1">
      <MarkdownText text={`请求链路：\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n`} />
    </div>)
    const block = view.container.querySelector<HTMLElement>('.md-code-block')!
    install()
    await flushFrames()

    const fence = document.querySelector<HTMLElement>('[data-genui-mermaid-fence]')!
    expect(fence).not.toBeNull()
    expect(block.style.display).toBe('none')
    expect(renderMermaid).toHaveBeenCalledTimes(1)
    expect(fence.querySelector('[data-genui-mermaid]')?.querySelector('svg')).not.toBeNull()

    fireEvent.click(within(fence).getByRole('button', { name: '源码' }))
    expect(fence.querySelector('pre')?.textContent).toContain('flowchart LR')
    fireEvent.click(within(fence).getByRole('button', { name: '预览' }))
    await flushFrames()
    expect(fence.querySelector('[data-genui-mermaid]')?.querySelector('svg')).not.toBeNull()
  })

  it('流式期间保持宿主代码块，定稿后才渲染图表', async () => {
    const { row, block } = mountSurface({ streaming: true })
    install()
    await flushFrames()
    expect(document.querySelector('[data-genui-mermaid-fence]')).toBeNull()
    expect(block.style.display).not.toBe('none')
    expect(renderMermaid).not.toHaveBeenCalled()

    delete row.querySelector<HTMLElement>('[data-streaming]')!.dataset.streaming
    await flushFrames()
    expect(document.querySelector('[data-genui-mermaid-fence]')).not.toBeNull()
    expect(block.style.display).toBe('none')
  })

  it('卸载渲染器后恢复宿主代码块', async () => {
    mountSurface({ streaming: false })
    install()
    await flushFrames()
    expect(document.querySelector('[data-genui-mermaid-fence]')).not.toBeNull()

    act(() => { for (const dispose of cleanups.splice(0)) dispose() })
    expect(document.querySelector('[data-genui-mermaid-fence]')).toBeNull()
    const block = document.querySelector<HTMLElement>('.md-code-block')!
    expect(block.style.display).toBe('')
    expect(block.hasAttribute('data-genui-rendered')).toBe(false)
  })
})
