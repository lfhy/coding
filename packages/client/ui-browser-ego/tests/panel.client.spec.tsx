// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBrowserPanel, type AgentBrowserProps } from '../src/client/AgentBrowserPanel.tsx'
import type { BrowserEgoView } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'

const page = { targetId: 'first', title: 'Example', url: 'https://example.com/', active: true,
  viewportW: 400, viewportH: 300 }
const frame = { targetId: 'first', src: 'data:image/jpeg;base64,YWJj', width: 400, height: 300, ts: 1 }
const ready: BrowserEgoView = { phase: 'ready', pages: [page], selectedId: page.targetId,
  frame, relayOff: false, pending: false }

afterEach(() => { cleanup() })

function mount(view: BrowserEgoView, shown = true) {
  const show = vi.fn()
  const send = vi.fn(async () => true)
  const props = { sessionId: 'session-one', shown,
    useTabInfo: () => ({ shown }),
    useBrowserEgo: (select: (snapshot: BrowserEgoView) => unknown) => select(view),
    show, send, select: vi.fn(), refresh: vi.fn(async () => {}),
    t: (key: keyof typeof en) => en[key],
  } as unknown as AgentBrowserProps
  return { ...render(<AgentBrowserPanel {...props} />), props, send, show }
}

describe('Agent 浏览器面板', () => {
  it('只呈现无工具标识的页面文案，按可见性启停预览', () => {
    const panel = mount(ready)
    expect(screen.getByRole('region', { name: 'Agent Browser' })).toBeTruthy()
    expect(screen.getByText('Example')).toBeTruthy()
    expect(screen.queryByText(/ego_|browser_|https:\/\//)).toBeNull()
    expect(panel.show).toHaveBeenCalledWith(true)
    panel.rerender(<AgentBrowserPanel {...panel.props} useTabInfo={() => ({ ...panel.props.useTabInfo(), shown: false })} />)
    expect(panel.show).toHaveBeenCalledWith(false)
    panel.unmount()
    expect(panel.show).toHaveBeenCalledWith(false)
  })

  it('仅在加载的画面上点击并插入文字，失败不显示响应原文', async () => {
    const panel = mount(ready)
    const screenshot = screen.getByAltText('Current page view') as HTMLImageElement
    Object.defineProperties(screenshot, {
      naturalWidth: { value: 800, configurable: true },
      naturalHeight: { value: 600, configurable: true },
      complete: { value: true, configurable: true },
    })
    vi.spyOn(screenshot, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400,
      height: 300, right: 400, bottom: 300 } as DOMRect)
    fireEvent.load(screenshot)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Current page view' }),
      { clientX: 100, clientY: 75 }) })
    expect(panel.send.mock.calls).toEqual([
      ['first', { type: 'mousePressed', x: 100, y: 75, button: 'left', buttons: 1, clickCount: 1 }],
      ['first', { type: 'mouseReleased', x: 100, y: 75, button: 'left', buttons: 0, clickCount: 1 }],
    ])
    fireEvent.change(screen.getByRole('textbox', { name: 'Text to send to page' }), { target: { value: 'Hello' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Insert text' })) })
    expect(panel.send).toHaveBeenLastCalledWith('first', { type: 'insertText', text: 'Hello' })
    panel.send.mockResolvedValueOnce(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Current page view' }),
      { clientX: 100, clientY: 75 }) })
    expect(screen.getByRole('alert').textContent).toContain('That action did not finish')
    expect(screen.queryByText(/JSON|stack/)).toBeNull()
    panel.unmount()
  })
})
