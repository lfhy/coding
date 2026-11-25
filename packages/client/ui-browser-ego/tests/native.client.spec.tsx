// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBrowserPanel, type AgentBrowserProps } from '../src/client/AgentBrowserPanel.tsx'
import type { WorkbenchExternalTab } from 'coding-client-ui-open-in-app/src/client/store.ts'
import type { BrowserEgoView } from '../src/client/controller.ts'
import type { EgoNativeSurface } from '../src/client/native.ts'
import { concealEgoSurface, nativeEgoSurface } from '../src/client/native.ts'
import { en } from '../src/client/locales.ts'

const page = { targetId: 'first', title: 'Example', url: 'https://example.com/', active: true,
  viewportW: 400, viewportH: 300, humanCheck: false }
const frame = { targetId: 'first', src: 'data:image/jpeg;base64,YWJj', width: 400, height: 300, ts: 1 }
// 面板只读标签 id 与其 targetId 参数，其余字段按工作台标签的完整形状补全。
const TAB: WorkbenchExternalTab = { type: 'external', id: 'browser-first', definitionId: 'agent-browser',
  kind: 'browser', name: 'Agent 浏览器', address: 'sidebar://browser', revision: 1, params: { targetId: 'first' } }
const ready: BrowserEgoView = { phase: 'ready', pages: [page], selectedId: page.targetId,
  frame, relayOff: false, pending: false, closing: null,
  status: { running: true, browserConnected: true }, video: { available: false, mime: null }, actions: [] }

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(view: BrowserEgoView, { shown = true, surface }: {
  shown?: boolean
  surface: EgoNativeSurface | null
}) {
  const show = vi.fn()
  const props = { sessionId: 'session-one',
    useTabInfo: () => ({ shown, tab: TAB }),
    useBrowserEgo: (choose: (snapshot: BrowserEgoView) => unknown) => choose(view),
    useBrowserEgoSettings: (choose: (snapshot: unknown) => unknown) => choose({ backend: 'auto' }),
    show, send: vi.fn(async () => true), hover: vi.fn(async () => null),
    resize: vi.fn(async () => true), navigate: vi.fn(async () => true),
    raiseWindow: vi.fn(async () => true), refresh: vi.fn(async () => {}),
    surface,
    t: (key: keyof typeof en, params?: Record<string, unknown>) =>
      en[key].replace(/\{(\w+)\}/gu, (match, name: string) => (name in (params ?? {}) ? String(params?.[name]) : match)),
  } as unknown as AgentBrowserProps
  return { ...render(<AgentBrowserPanel {...props} />), props }
}

/** 面板的矩形上报走 120ms 去抖；DOM 变更后按同一节奏等它落定。 */
async function settle(change: () => void): Promise<void> {
  await act(async () => {
    change()
    await new Promise(resolve => setTimeout(resolve, 160))
  })
}

describe('桌面端原生呈现', () => {
  it('桌面壳提供入口时不再渲染画面与窗口按钮，并把矩形交给桌面壳', () => {
    const present = vi.fn(async () => undefined)
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 40, top: 50, width: 500, height: 400, right: 540, bottom: 450, x: 40, y: 50 } as DOMRect)
    mount(ready, { surface: { present } })
    expect(screen.queryByAltText('Current page view')).toBeNull()
    expect(screen.queryByRole('button', { name: /Open in a browser window/u })).toBeNull()
    expect(present).toHaveBeenCalledWith({
      targetId: 'first', visible: true, bounds: { x: 40, y: 50, width: 500, height: 400 },
    })
    rect.mockRestore()
  })

  it('隐藏或换页时撤回呈现，不把旧页面留在窗口里', () => {
    const present = vi.fn(async () => undefined)
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, top: 0, width: 600, height: 500, right: 600, bottom: 500, x: 0, y: 0 } as DOMRect)
    const view = mount(ready, { surface: { present } })
    expect(present).toHaveBeenCalled()
    rect.mockRestore()
    view.rerender(<AgentBrowserPanel {...view.props} useTabInfo={() => ({ shown: false, tab: TAB,
      tabDomId: 'tab-browser-first', panelDomId: 'panel-browser-first',
      selectTab: () => {}, closeTab: () => {} })} />)
    expect(present).toHaveBeenCalledWith({
      targetId: 'first', visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 },
    })
  })

  it('Web 端没有入口时保留帧流画面', () => {
    mount(ready, { surface: null })
    expect(screen.getByAltText('Current page view')).toBeTruthy()
  })

  it('整屏浮层打开时撤下原生视图，关闭后重新呈现', async () => {
    const present = vi.fn(async () => undefined)
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 40, top: 50, width: 500, height: 400, right: 540, bottom: 450, x: 40, y: 50 } as DOMRect)
    mount(ready, { surface: { present } })
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
    // 原图预览等整屏浮层叠在网页之上；原生视图不认 z-index，必须先让出窗口。
    const lightbox = document.createElement('div')
    lightbox.setAttribute('role', 'dialog')
    lightbox.setAttribute('aria-modal', 'true')
    await settle(() => { document.body.append(lightbox) })
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({
      targetId: 'first', visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 },
    }))
    await settle(() => { lightbox.remove() })
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({
      targetId: 'first', visible: true, bounds: { x: 40, y: 50, width: 500, height: 400 },
    }))
    rect.mockRestore()
  })

  it('面板被隐藏或工作台列退出可访问树时不再占据窗口', async () => {
    const present = vi.fn(async () => undefined)
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 40, top: 50, width: 500, height: 400, right: 540, bottom: 450, x: 40, y: 50 } as DOMRect)
    const view = mount(ready, { surface: { present } })
    await settle(() => { view.container.setAttribute('inert', '') })
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
    rect.mockRestore()
  })

  it('面板收窄到放不下页面时撤回，不把旧矩形留在窗口上', async () => {
    const present = vi.fn(async () => undefined)
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 40, top: 50, width: 120, height: 90, right: 160, bottom: 140, x: 40, y: 50 } as DOMRect)
    mount(ready, { surface: { present } })
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({
      targetId: 'first', visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 },
    }))
    rect.mockRestore()
  })
})

describe('原生入口探测', () => {
  it('只接受桌面壳提供的异步 present 方法', () => {
    expect(nativeEgoSurface()).toBeNull()
    vi.stubGlobal('codingDesktop', { egoBrowser: { present: 'nope' } })
    expect(nativeEgoSurface()).toBeNull()
    const present = vi.fn(async () => undefined)
    vi.stubGlobal('codingDesktop', { egoBrowser: { present } })
    const surface = nativeEgoSurface()
    expect(surface).not.toBeNull()
    void surface?.present({ targetId: 'first', visible: true, bounds: { x: 0, y: 0, width: 1, height: 1 } })
    expect(present).toHaveBeenCalledOnce()
  })

  it('撤回缺失目标时什么也不做', () => {
    const present = vi.fn(async () => undefined)
    concealEgoSurface({ present }, null)
    concealEgoSurface({ present }, undefined)
    expect(present).not.toHaveBeenCalled()
    concealEgoSurface({ present }, 'first')
    expect(present).toHaveBeenCalledWith({ targetId: 'first', visible: false,
      bounds: { x: 0, y: 0, width: 0, height: 0 } })
  })
})
