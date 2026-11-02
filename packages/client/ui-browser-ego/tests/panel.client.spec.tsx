// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBrowserPanel, type AgentBrowserProps } from '../src/client/AgentBrowserPanel.tsx'
import type { BrowserEgoView } from '../src/client/controller.ts'
import type { EgoAction } from '../src/client/actions.ts'
import type { EgoBrowserCapture } from '../src/client/settings.ts'
import { en } from '../src/client/locales.ts'

const page = { targetId: 'first', title: 'Example', url: 'https://example.com/', active: true,
  viewportW: 400, viewportH: 300, humanCheck: false }
const frame = { targetId: 'first', src: 'data:image/jpeg;base64,YWJj', width: 400, height: 300, ts: 1 }
const ready: BrowserEgoView = { phase: 'ready', pages: [page], selectedId: page.targetId,
  frame, relayOff: false, pending: false, closing: null,
  status: { running: true, browserConnected: true }, video: { available: false, mime: null }, actions: [] }
const mime = 'video/mp4; codecs="avc1.42E01E"'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

function mount(view: BrowserEgoView, shown = true, backend: EgoBrowserCapture['backend'] = 'auto') {
  const show = vi.fn()
  const send = vi.fn(async () => true)
  const close = vi.fn(async () => false)
  const raiseWindow = vi.fn(async () => true)
  const select = vi.fn()
  const props = { sessionId: 'session-one', shown,
    useTabInfo: () => ({ shown }),
    useBrowserEgo: (choose: (snapshot: BrowserEgoView) => unknown) => choose(view),
    useBrowserEgoSettings: (choose: (snapshot: EgoBrowserCapture) => unknown) => choose({ backend }),
    show, send, close, raiseWindow, select, refresh: vi.fn(async () => {}),
    t: (key: keyof typeof en, params?: Record<string, unknown>) =>
      en[key].replace(/\{(\w+)\}/gu, (match, name: string) => (name in (params ?? {}) ? String(params?.[name]) : match)),
  } as unknown as AgentBrowserProps
  return { ...render(<AgentBrowserPanel {...props} />), props, send, close, raiseWindow, select, show }
}

describe('Agent 浏览器面板', () => {
  it('只呈现无工具标识的页面文案，按可见性启停预览', () => {
    const panel = mount(ready)
    expect(screen.getByRole('region', { name: 'Agent Browser' })).toBeTruthy()
    expect(screen.getByText('Example')).toBeTruthy()
    expect(screen.queryByText(/ego_|browser_|https:\/\//)).toBeNull()
    expect(screen.getByRole('button', { name: 'Action history' })).toBeTruthy()
    expect(panel.show).toHaveBeenCalledWith(true)
    panel.rerender(<AgentBrowserPanel {...panel.props} useTabInfo={() => ({ ...panel.props.useTabInfo(), shown: false })} />)
    expect(panel.show).toHaveBeenCalledWith(false)
    panel.unmount()
    expect(panel.show).toHaveBeenCalledWith(false)
  })

  it('仅在用户点击时打开浏览器窗口，失败给出固定提示', async () => {
    const panel = mount(ready)
    const button = screen.getByRole('button', { name: 'Open in a browser window (for sign-in and human checks)' })
    fireEvent.click(button)
    await vi.waitFor(() => { expect(panel.raiseWindow).toHaveBeenCalledTimes(1) })
    expect(screen.queryByText('Could not open the browser window. Please try again.')).toBeNull()
    panel.raiseWindow.mockResolvedValueOnce(false)
    fireEvent.click(button)
    expect(await screen.findByText('Could not open the browser window. Please try again.')).toBeTruthy()
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

  it('显示运行/连接状态与页面数量，状态不可用时只给中性说明', () => {
    const running = mount(ready)
    expect(screen.getByText('Browser running')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('Pages: 1')).toBeTruthy()
    running.unmount()

    const stopped = mount({ ...ready, status: { running: false, browserConnected: false } })
    expect(screen.getByText('Browser not running')).toBeTruthy()
    expect(screen.getByText('Not connected')).toBeTruthy()
    stopped.unmount()

    const unknown = mount({ ...ready, status: null, pages: [page, { ...page, targetId: 'second' }] })
    expect(screen.getByText('Browser status is unavailable right now')).toBeTruthy()
    expect(screen.queryByText('Browser running')).toBeNull()
    expect(screen.getByText('Pages: 2')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/api\/ego|127\.0\.0\.1/u)
    unknown.unmount()
  })

  it('历史动作在抽屉里按类别和时间展示，最多 8 条且最新在前', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'))
    const now = Date.now()
    const actions: EgoAction[] = Array.from({ length: 9 }, (_, index) => ({
      kind: 'click' as const, at: now - (30 - index) * 1000,
    }))
    actions.push({ kind: 'navigate', at: now - 1000 })
    const panel = mount({ ...ready, actions })
    fireEvent.click(screen.getByRole('button', { name: 'Action history' }))
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(8)
    expect(within(rows[0] as HTMLElement).getByText('Opened a page')).toBeTruthy()
    expect(within(rows[0] as HTMLElement).getByText('just now')).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText('Clicked the page')).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText('22s ago')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/browser_|ego_/u)
    panel.unmount()
  })

  it('关闭标签后回传目标，失败只用共享提示说明', async () => {
    const panel = mount(ready)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close this page: Example' }))
    })
    expect(panel.close).toHaveBeenCalledWith('first')
    expect(screen.getByRole('alert').textContent).toContain('Could not close this page')
    expect(document.body.textContent).not.toMatch(/stack|Error|JSON/u)
    panel.close.mockResolvedValueOnce(true)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close this page: Example' }))
    })
    expect(panel.close).toHaveBeenCalledTimes(2)
    panel.unmount()
  })

  it('仅在对应页面需要人工验证时显示提示，不暴露检测细节', () => {
    const panel = mount({ ...ready, pages: [{ ...page, humanCheck: true }] })
    expect(screen.getByText('This page needs a human check. Complete it in the view.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/recaptcha|selector|captcha|JSON/u)
    panel.unmount()
    const quiet = mount(ready)
    expect(screen.queryByText(/human check/u)).toBeNull()
    quiet.unmount()
  })

  it('抽屉默认收起，点条目只保持选中态并关闭，不触发任何页面操作', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'))
    const now = Date.now()
    const actions: EgoAction[] = [
      { kind: 'navigate', at: now - 2000 }, { kind: 'click', at: now - 1000 },
    ]
    const panel = mount({ ...ready, actions })
    const toggle = screen.getByRole('button', { name: 'Action history' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button'))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(panel.send).not.toHaveBeenCalled()
    expect(panel.close).not.toHaveBeenCalled()
    expect(panel.select).not.toHaveBeenCalled()

    fireEvent.click(toggle)
    const reopened = screen.getAllByRole('listitem')
    expect(within(reopened[0] as HTMLElement).getByRole('button').getAttribute('aria-current')).toBe('true')
    expect(within(reopened[1] as HTMLElement).getByRole('button').getAttribute('aria-current')).toBeNull()
    panel.unmount()
  })

  it('空历史在抽屉里显示中性空状态', () => {
    const panel = mount(ready)
    fireEvent.click(screen.getByRole('button', { name: 'Action history' }))
    expect(screen.getByText('No browser activity yet')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/api\/ego|JSON/u)
    panel.unmount()
  })

  it('视频后端可用但 MSE 不受支持时回退单帧并给中性提示', () => {
    const panel = mount({ ...ready, video: { available: true, mime } }, true, 'ffmpeg')
    expect(screen.getByText('Live video is unavailable; showing still frames instead')).toBeTruthy()
    expect(screen.getByAltText('Current page view')).toBeTruthy()
    expect(document.querySelector('video')).toBeNull()
    expect(document.body.textContent).not.toMatch(/video\/mp4|api\/ego|MediaSource/u)
    panel.unmount()
  })

  it('仅视频后端且流就绪时才尝试视频画面，隐藏后不渲染', () => {
    const cdp = mount({ ...ready, video: { available: true, mime } }, true, 'auto')
    expect(document.querySelector('video')).toBeNull()
    expect(screen.queryByText(/Live video is unavailable/u)).toBeNull()
    cdp.unmount()

    const hidden = mount({ ...ready, video: { available: true, mime } }, false, 'ffmpeg')
    expect(document.querySelector('video')).toBeNull()
    hidden.unmount()
  })
})
