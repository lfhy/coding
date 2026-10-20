// @vitest-environment jsdom
/** 同步挂载错误必须恢复原文，释放已有的 React root，不能留下空白占位。 */
import { act } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installDomFenceRenderer, setDomRootFactory } from '../src/client/dom-fence.tsx'

const disposers: Array<() => void> = []

afterEach(() => {
  act(() => { for (const dispose of disposers.splice(0)) dispose() })
  setDomRootFactory(createRoot)
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('GenUI 挂载失败回退', () => {
  it.each(['create', 'render'])('root %s 失败时保持原代码可见', (failure) => {
    const row = document.createElement('div')
    row.dataset.chatAnchorKey = '14:assistant-step1:1'
    row.dataset.chatFlowKind = 'assistant-step'
    row.innerHTML = '<div data-streaming="true"><div class="md-code-block"><div>gen-ui</div><pre>{</pre></div></div>'
    document.body.append(row)
    const block = row.querySelector<HTMLElement>('.md-code-block')!
    const unmount = vi.fn()
    const render = vi.fn(() => { throw new Error('render failed') })
    setDomRootFactory(() => {
      if (failure === 'create') throw new Error('create failed')
      return { render, unmount }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = { sessions: { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} } } } as unknown as Context
    act(() => { disposers.push(installDomFenceRenderer(ctx, () => {})) })
    expect(block.style.display).not.toBe('none')
    expect(block.hasAttribute('data-genui-rendered')).toBe(false)
    expect(document.querySelector('.genui-dom-fence')).toBeNull()
    expect(unmount).toHaveBeenCalledTimes(failure === 'render' ? 1 : 0)
  })
})
