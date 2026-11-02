// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBrowserPanel, type AgentBrowserProps } from '../src/client/AgentBrowserPanel.tsx'
import type { BrowserEgoView } from '../src/client/controller.ts'
import type { EgoBrowserCapture } from '../src/client/settings.ts'
import { en } from '../src/client/locales.ts'

const page = { targetId: 'first', title: 'Example', url: 'https://example.com/', active: true,
  viewportW: 400, viewportH: 300, humanCheck: false }
const secondPage = { ...page, targetId: 'second', title: 'Another page',
  url: 'https://second.example/', active: false }
const frame = { targetId: 'first', src: 'data:image/jpeg;base64,YWJj', width: 400, height: 300, ts: 1 }
const secondFrame = { ...frame, targetId: 'second', src: 'data:image/jpeg;base64,ZGVm' }
const ready: BrowserEgoView = { phase: 'ready', pages: [page], selectedId: page.targetId,
  frame, relayOff: false, pending: false, closing: null,
  status: { running: true, browserConnected: true }, video: { available: false, mime: null }, actions: [] }
const mime = 'video/mp4; codecs="avc1.42E01E"'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

function mount(view: BrowserEgoView, { shown = true, targetId = 'first', backend = 'auto' }: {
  shown?: boolean
  targetId?: string | null
  backend?: EgoBrowserCapture['backend']
} = {}) {
  const show = vi.fn()
  const send = vi.fn(async () => true)
  const navigate = vi.fn(async () => true)
  const raiseWindow = vi.fn(async () => true)
  const refresh = vi.fn(async () => {})
  const props = { sessionId: 'session-one',
    useTabInfo: () => ({ shown, tab: { id: `browser-${targetId ?? 'fallback'}`,
      params: targetId === null ? {} : { targetId } } }),
    useBrowserEgo: (choose: (snapshot: BrowserEgoView) => unknown) => choose(view),
    useBrowserEgoSettings: (choose: (snapshot: EgoBrowserCapture) => unknown) => choose({ backend }),
    show, send, navigate, raiseWindow, refresh,
    t: (key: keyof typeof en, params?: Record<string, unknown>) =>
      en[key].replace(/\{(\w+)\}/gu, (match, name: string) => (name in (params ?? {}) ? String(params?.[name]) : match)),
  } as unknown as AgentBrowserProps
  return { ...render(<AgentBrowserPanel {...props} />), props, show, send, navigate, raiseWindow, refresh }
}

/** jsdom 不解码 JPEG；显式提供画面尺寸以验证可点击区域与投递坐标。 */
function loadFrame(): HTMLButtonElement {
  const screenshot = screen.getByAltText('Current page view') as HTMLImageElement
  Object.defineProperties(screenshot, {
    naturalWidth: { value: 800, configurable: true },
    naturalHeight: { value: 600, configurable: true },
    complete: { value: true, configurable: true },
  })
  vi.spyOn(screenshot, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400,
    height: 300, right: 400, bottom: 300 } as DOMRect)
  fireEvent.load(screenshot)
  return screen.getByRole('button', { name: 'Current page view' }) as HTMLButtonElement
}

function submitAddress(value: string): void {
  const input = screen.getByRole('textbox', { name: 'Web address' }) as HTMLInputElement
  fireEvent.change(input, { target: { value } })
  fireEvent.submit(input.closest('form') as HTMLFormElement)
}

describe('Agent 浏览器工作台页面', () => {
  it('仅呈现当前目标的地址、画面与导航；显隐按工作台目标启停', () => {
    const view = { ...ready, pages: [page, secondPage], selectedId: 'first', frame: secondFrame,
      actions: [{ kind: 'navigate' as const, at: 1 }] }
    const panel = mount(view, { targetId: 'second' })
    expect(screen.getByRole('region', { name: 'Agent Browser' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Web address' }) as HTMLInputElement).value)
      .toBe('https://second.example/')
    expect((screen.getByAltText('Current page view') as HTMLImageElement).src).toContain('ZGVm')
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Forward' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Action history' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Text to send to page' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close this page' })).toBeNull()
    expect(screen.queryByText(/Browser running|Pages:|Opened a page/u)).toBeNull()
    expect(panel.show).toHaveBeenCalledWith(true, 'second')
    panel.rerender(<AgentBrowserPanel {...panel.props} useTabInfo={() => ({
      ...panel.props.useTabInfo(), shown: false,
    })} />)
    expect(panel.show).toHaveBeenCalledWith(false, 'second')
    panel.unmount()
    expect(panel.show).toHaveBeenLastCalledWith(false, 'second')
  })

  it('切换工作台目标时隔离旧画面、地址与投递目标，不依赖内部选中页', async () => {
    const view = { ...ready, pages: [page, secondPage], selectedId: 'first' }
    const panel = mount(view)
    loadFrame()
    const otherTab = { ...panel.props, useTabInfo: () => ({
      shown: true, tab: { id: 'browser-second', params: { targetId: 'second' } },
    }) } as unknown as AgentBrowserProps
    panel.rerender(<AgentBrowserPanel {...otherTab} />)
    expect(screen.getByText('Page view is not available yet')).toBeTruthy()
    expect(screen.queryByAltText('Current page view')).toBeNull()
    expect((screen.getByRole('textbox', { name: 'Web address' }) as HTMLInputElement).value)
      .toBe(secondPage.url)
    expect(panel.show).toHaveBeenCalledWith(false, 'first')
    expect(panel.show).toHaveBeenCalledWith(true, 'second')
    expect(panel.send).not.toHaveBeenCalled()

    panel.rerender(<AgentBrowserPanel {...otherTab} useBrowserEgo={choose => choose({ ...view, frame: secondFrame })} />)
    const preview = loadFrame()
    await act(async () => { fireEvent.click(preview, { clientX: 100, clientY: 75 }) })
    expect(panel.send.mock.calls).toEqual([
      ['second', { type: 'mousePressed', x: 100, y: 75, button: 'left', buttons: 1, clickCount: 1 }],
      ['second', { type: 'mouseReleased', x: 100, y: 75, button: 'left', buttons: 0, clickCount: 1 }],
    ])
    panel.unmount()
  })

  it('切换到同网址的另一页面时不保留前一页的地址草稿', () => {
    const sameUrl = { ...secondPage, url: page.url }
    const panel = mount({ ...ready, pages: [page, sameUrl] })
    const input = screen.getByRole('textbox', { name: 'Web address' })
    fireEvent.change(input, { target: { value: 'draft.example' } })
    const otherTab = { ...panel.props, useTabInfo: () => ({
      shown: true, tab: { id: 'browser-second', params: { targetId: 'second' } },
    }) } as unknown as AgentBrowserProps
    panel.rerender(<AgentBrowserPanel {...otherTab} />)
    expect((screen.getByRole('textbox', { name: 'Web address' }) as HTMLInputElement).value).toBe(page.url)
    panel.unmount()
  })

  it('无可用页面时保留空状态，未知目标不能显示其它页面画面', () => {
    const empty = mount({ ...ready, pages: [], frame: null }, { targetId: null })
    expect(screen.getByText('No pages are open yet')).toBeTruthy()
    expect(screen.queryByAltText('Current page view')).toBeNull()
    empty.unmount()

    const missing = mount(ready, { targetId: 'missing' })
    expect(screen.getByText('This page is unavailable. Switch to another tab.')).toBeTruthy()
    expect(screen.queryByAltText('Current page view')).toBeNull()
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true)
    missing.unmount()
  })

  it('空白会话可通过地址栏打开首张网页，目标身份由会话创建', async () => {
    const panel = mount({ ...ready, pages: [], selectedId: null, frame: null }, { targetId: null })
    await act(async () => { submitAddress('example.org') })
    expect(panel.navigate).toHaveBeenCalledWith(undefined, 'navigate', 'https://example.org/')
    panel.unmount()
  })

  it('失焦和点击打开按钮都使用当前输入值，草稿不在重渲染时被空目录清除', async () => {
    const panel = mount({ ...ready, pages: [], selectedId: null, frame: null }, { targetId: null })
    const input = screen.getByRole('textbox', { name: 'Web address' }) as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'example.org' } })
    fireEvent.blur(input)
    expect(input.value).toBe('example.org')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open website' })) })
    expect(panel.navigate).toHaveBeenCalledWith(undefined, 'navigate', 'https://example.org/')
    expect(input.value).toBe('https://example.org/')
    panel.unmount()
  })

  it('回车提交当前草稿且阻止原生表单离开工作台', async () => {
    const panel = mount({ ...ready, pages: [], selectedId: null, frame: null }, { targetId: null })
    const input = screen.getByRole('textbox', { name: 'Web address' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'example.org' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(panel.navigate).toHaveBeenCalledWith(undefined, 'navigate', 'https://example.org/')
    expect(screen.getByRole('region', { name: 'Agent Browser' })).toBeTruthy()
    panel.unmount()
  })

  it('地址栏为无 scheme 的域名补 https，保留显式 http 地址', async () => {
    const panel = mount(ready)
    await act(async () => { submitAddress('  example.org/docs?q=1  ') })
    expect(panel.navigate).toHaveBeenCalledWith('first', 'navigate', 'https://example.org/docs?q=1')
    await act(async () => { submitAddress('http://example.org/page') })
    expect(panel.navigate).toHaveBeenLastCalledWith('first', 'navigate', 'http://example.org/page')
    expect(screen.queryByText('Enter a valid http or https address.')).toBeNull()
    panel.unmount()
  })

  it('无 scheme 的域名带端口仍应补 https', async () => {
    const panel = mount(ready)
    await act(async () => { submitAddress('example.org:8443/docs') })
    expect(panel.navigate).toHaveBeenCalledWith('first', 'navigate', 'https://example.org:8443/docs')
    panel.unmount()
  })

  it.each([
    ['可执行协议', 'javascript:alert(1)'],
    ['数据协议', 'data:text/html,<h1>unsafe</h1>'],
    ['本地文件协议', 'file:///tmp/private.html'],
    ['非网页协议', 'ftp://example.org/'],
    ['带用户名与密码的地址', 'https://alice:secret@example.org/'],
    ['省略 scheme 但带凭据的地址', 'alice@example.org/'],
    ['包含空格的地址', 'https://example.org/a b'],
    ['无主机的地址', 'https://'],
  ])('拒绝%s，不向 Host 发起导航', async (_case, draft) => {
    const panel = mount(ready)
    await act(async () => { submitAddress(draft) })
    expect(screen.getByRole('alert').textContent).toContain('Enter a valid http or https address.')
    expect(screen.getByRole('textbox', { name: 'Web address' }).getAttribute('aria-invalid')).toBe('true')
    expect(panel.navigate).not.toHaveBeenCalled()
    panel.unmount()
  })

  it('后退、前进和刷新仅对当前目标发命令，导航失败只显示固定提示', async () => {
    const panel = mount(ready)
    for (const [label, action] of [['Back', 'back'], ['Forward', 'forward'], ['Reload page', 'reload']] as const) {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) })
      expect(panel.navigate).toHaveBeenLastCalledWith('first', action)
    }
    panel.navigate.mockResolvedValueOnce(false)
    await act(async () => { submitAddress('example.org/failed') })
    expect(screen.getByRole('alert').textContent).toContain('Could not open this page. Check the address and try again.')
    expect(screen.queryByText(/stack|JSON|api\/ego/u)).toBeNull()
    expect(panel.navigate).toHaveBeenCalledTimes(4)
    panel.unmount()
  })

  it('只能在用户点击后打开浏览器窗口，失败不显示响应细节', async () => {
    const panel = mount(ready)
    const button = screen.getByRole('button', { name: 'Open in a browser window (for sign-in and human checks)' })
    expect(panel.raiseWindow).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(button) })
    expect(panel.raiseWindow).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Could not open the browser window. Please try again.')).toBeNull()
    panel.raiseWindow.mockResolvedValueOnce(false)
    await act(async () => { fireEvent.click(button) })
    expect(screen.getByRole('alert').textContent).toContain('Could not open the browser window. Please try again.')
    panel.unmount()
  })

  it('有效画面点击与滚动按页面坐标发送；未加载画面不投递', async () => {
    const panel = mount(ready)
    const preview = screen.getByRole('button', { name: 'Current page view' })
    await act(async () => { fireEvent.click(preview, { clientX: 100, clientY: 75 }) })
    expect(panel.send).not.toHaveBeenCalled()
    loadFrame()
    await act(async () => { fireEvent.click(preview, { clientX: 100, clientY: 75 }) })
    await act(async () => { fireEvent.wheel(preview, { clientX: 100, clientY: 75, deltaY: 42.6 }) })
    expect(panel.send.mock.calls).toEqual([
      ['first', { type: 'mousePressed', x: 100, y: 75, button: 'left', buttons: 1, clickCount: 1 }],
      ['first', { type: 'mouseReleased', x: 100, y: 75, button: 'left', buttons: 0, clickCount: 1 }],
      ['first', { type: 'mouseWheel', x: 100, y: 75, deltaX: 0, deltaY: 43 }],
    ])
    panel.unmount()
  })

  it('聚焦画面可输入文字、受限按键及纯文本粘贴，不转发快捷键', async () => {
    const panel = mount(ready)
    const preview = loadFrame()
    preview.focus()
    expect(document.activeElement).toBe(preview)
    await act(async () => { fireEvent.keyDown(preview, { key: 'a', code: 'KeyA', keyCode: 65 }) })
    await act(async () => { fireEvent.keyDown(preview, { key: 'Enter', code: 'Enter', keyCode: 13 }) })
    await act(async () => {
      fireEvent.paste(preview, { clipboardData: { getData: (type: string) =>
        type === 'text/plain' ? 'pasted\ntext' : '' } })
    })
    await act(async () => { fireEvent.compositionEnd(preview, { data: '你好' }) })
    fireEvent.keyDown(preview, { key: 'r', code: 'KeyR', ctrlKey: true })
    fireEvent.keyDown(preview, { key: 'a', code: 'KeyA', metaKey: true })
    fireEvent.keyDown(preview, { key: 'Tab', code: 'Tab' })
    fireEvent.keyDown(preview, { key: 'Escape', code: 'Escape' })
    expect(panel.send.mock.calls).toEqual([
      ['first', { type: 'insertText', text: 'a' }],
      ['first', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }],
      ['first', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }],
      ['first', { type: 'insertText', text: 'pasted\ntext' }],
      ['first', { type: 'insertText', text: '你好' }],
    ])
    panel.unmount()
  })

  it('输入失败只提示可重试，不回显 Host 响应内容', async () => {
    const panel = mount(ready)
    const preview = loadFrame()
    panel.send.mockResolvedValueOnce(false)
    await act(async () => { fireEvent.click(preview, { clientX: 100, clientY: 75 }) })
    expect(panel.send).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toContain('That action did not finish')
    expect(document.body.textContent).not.toMatch(/stack|JSON|api\/ego/u)
    panel.unmount()
  })

  it('仅当前目标需要人工验证时显示提示，不展示检测细节', () => {
    const view = { ...ready, pages: [{ ...page, humanCheck: true }, secondPage] }
    const quiet = mount(view, { targetId: 'second' })
    expect(screen.queryByText(/human check/u)).toBeNull()
    quiet.unmount()
    const needed = mount(view)
    expect(screen.getByText('This page needs a human check. Complete it in the view.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/recaptcha|selector|JSON/u)
    needed.unmount()
  })

  it('视频后端可用但 MSE 不受支持时回退单帧并给中性提示', () => {
    const panel = mount({ ...ready, video: { available: true, mime } }, { backend: 'ffmpeg' })
    expect(screen.getByText('Live video is unavailable; showing still frames instead')).toBeTruthy()
    expect(screen.getByAltText('Current page view')).toBeTruthy()
    expect(document.querySelector('video')).toBeNull()
    expect(document.body.textContent).not.toMatch(/video\/mp4|api\/ego|MediaSource/u)
    panel.unmount()
  })

  it('只在视频后端与活动目标就绪时尝试视频画面，隐藏后不渲染', () => {
    const still = mount({ ...ready, video: { available: true, mime } })
    expect(document.querySelector('video')).toBeNull()
    still.unmount()
    const inactive = mount({ ...ready, pages: [page, secondPage], frame: secondFrame,
      video: { available: true, mime } }, { targetId: 'second', backend: 'ffmpeg' })
    expect(document.querySelector('video')).toBeNull()
    inactive.unmount()
    const hidden = mount({ ...ready, video: { available: true, mime } }, { shown: false, backend: 'ffmpeg' })
    expect(document.querySelector('video')).toBeNull()
    hidden.unmount()
  })
})
