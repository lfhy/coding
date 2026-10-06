// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'

const terminals = vi.hoisted(() => ({ instances: [] as Array<{
  writes: string[]
  dispose: ReturnType<typeof vi.fn>
}> }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown>
    textarea: HTMLTextAreaElement | undefined
    private node: HTMLElement | undefined
    readonly writes: string[] = []
    readonly dispose = vi.fn(() => { this.node?.replaceChildren() })

    constructor(options: Record<string, unknown>) {
      this.options = options
      terminals.instances.push(this)
    }

    loadAddon(): void {}
    open(node: HTMLElement): void {
      this.node = node
      this.textarea = document.createElement('textarea')
      node.append(this.textarea)
    }
    onData() { return { dispose: vi.fn() } }
    focus(): void { this.textarea?.focus() }
    write(value: string): void {
      this.writes.push(value)
      this.node?.append(document.createTextNode(value))
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))

class Socket extends EventTarget {
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  static readonly instances: Socket[] = []
  readyState = Socket.CONNECTING
  readonly close = vi.fn(() => { this.readyState = 3 })
  readonly send = vi.fn()

  constructor(readonly url: string) {
    super()
    Socket.instances.push(this)
  }

  output(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output', data }) }))
  }

  finish(): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'exit', exitCode: 0, signal: null }) }))
    this.dispatchEvent(new Event('close'))
  }
}

let runtime: SlotTestRuntime | undefined

beforeEach(() => {
  terminals.instances.length = 0
  Socket.instances.length = 0
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
})

afterEach(async () => {
  cleanup()
  await runtime?.dispose()
  runtime = undefined
  vi.unstubAllGlobals()
})

/** 以生产 slot、renderer 与插件注册路径装配两个终端入口。 */
async function bench() {
  runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('zh')
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.provide('layout', {
    openWorkbench: vi.fn(), closeWorkbench: vi.fn(),
    toggleWorkbenchFullscreen: vi.fn(),
    toggleWorkbenchBottom: vi.fn(), closeWorkbenchBottom: vi.fn(),
    workbench: () => createSnapshotStore({ open: true, fullscreen: false, bottomOpen: true }),
  })
  const first = await runtime.sessions.add({ id: 'workbench-retained-first' })
  const second = await runtime.sessions.add({ id: 'workbench-retained-second' }, { current: false })
  await runtime.declare({
    workbench: { kind: 'single', scope: 'root' },
    'workbench.bottom': { kind: 'single', scope: 'root' },
  })
  const feature = await runtime.mount({ inject: [...inject], apply })
  const workbench = runtime.renderSlot('workbench', {
    shown: true, fullscreen: false, bottomOpen: true,
  })
  const bottom = runtime.renderSlot('workbench.bottom', { sessionId: first, shown: true })
  return { runtime, feature, workbench, bottom, first, second }
}

describe('root workbench terminal lifetime', () => {
  it('removes a completed hidden terminal without changing the selected file manager', async () => {
    const b = await bench()
    fireEvent.click(b.workbench.view.getByRole('button', { name: '终端' }))
    const terminalTab = b.workbench.view.getByRole('tab', { name: 'coding 1' })
    const right = Socket.instances[1]
    if (!right) throw new Error('right terminal did not connect')
    fireEvent.click(b.workbench.view.getByRole('button', { name: '返回功能菜单' }))
    fireEvent.click(b.workbench.view.getByRole('button', { name: '文件' }))
    const manager = b.workbench.view.getByRole('tab', { name: '文件管理器' })
    expect(manager.getAttribute('aria-selected')).toBe('true')
    act(() => { right.finish() })
    expect(b.workbench.view.queryByRole('tab', { name: 'coding 1' })).toBeNull()
    expect(terminalTab.isConnected).toBe(false)
    expect(manager.getAttribute('aria-selected')).toBe('true')
  })

  it('restarts an interrupted directory read when its Session is selected again', async () => {
    const requests: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = []
    const fetcher = vi.fn((_input: string | URL, options?: RequestInit) => new Promise<Response>((resolve) => {
      requests.push({ signal: options!.signal as AbortSignal, resolve })
    }))
    vi.stubGlobal('fetch', fetcher)
    const b = await bench()
    fireEvent.click(b.workbench.view.getByRole('button', { name: '文件' }))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(requests[0]!.signal.aborted).toBe(false)
    await b.runtime.sessions.setCurrent(b.second)
    expect(requests[0]!.signal.aborted).toBe(true)
    await b.runtime.sessions.setCurrent(b.first)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(requests[1]!.signal.aborted).toBe(false)
    await act(async () => {
      requests[1]!.resolve(new Response(JSON.stringify({
        displayPath: '/workspace', entries: [{ name: 'README.md', type: 'file' }, { name: 'src', type: 'directory' }], truncated: false,
      }), { status: 200 }))
    })
    await waitFor(() => { expect(b.workbench.view.getByRole('button', { name: /README\.md/ })).toBeTruthy() })
    await act(async () => {
      requests[0]!.resolve(new Response(JSON.stringify({
        displayPath: '/stale', entries: [{ name: 'stale.txt', type: 'file' }], truncated: false,
      }), { status: 200 }))
    })
    expect(b.workbench.view.queryByRole('button', { name: /stale\.txt/ })).toBeNull()
    fireEvent.click(b.workbench.view.getByRole('button', { name: 'src' }))
    expect(fetcher).toHaveBeenCalledTimes(3)
    await b.runtime.sessions.setCurrent(b.second)
    expect(requests[2]!.signal.aborted).toBe(true)
    await b.runtime.sessions.setCurrent(b.first)
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(requests[3]!.signal.aborted).toBe(false)
    await act(async () => {
      requests[3]!.resolve(new Response(JSON.stringify({
        displayPath: '/workspace/src', entries: [{ name: 'index.ts', type: 'file' }], truncated: false,
      }), { status: 200 }))
    })
    await waitFor(() => { expect(b.workbench.view.getByRole('button', { name: /index\.ts/ })).toBeTruthy() })
  })

  it('retains both terminal trees across Session changes and no selection, then releases only removed resources', async () => {
    const b = await bench()
    expect(b.runtime.slots.snapshot('workbench')[0]?.scope).toBe('root')
    fireEvent.click(b.workbench.view.getByRole('button', { name: '终端' }))
    expect(Socket.instances).toHaveLength(2)
    const [firstBottom, firstRight] = Socket.instances
    expect(firstBottom!.url).toContain(`sessionId=${b.first}`)
    expect(firstRight!.url).toContain(`sessionId=${b.first}`)
    act(() => { firstBottom!.output('first bottom output'); firstRight!.output('first right output') })
    expect(b.bottom.container.textContent).toContain('first bottom output')
    expect(b.workbench.container.textContent).toContain('first right output')

    await b.runtime.sessions.setCurrent(b.second)
    b.bottom.update({ sessionId: b.second, shown: true })
    fireEvent.click(b.workbench.view.getByRole('button', { name: '终端' }))
    expect(Socket.instances).toHaveLength(4)
    const [secondBottom, secondRight] = Socket.instances.slice(2)
    expect(secondBottom!.url).toContain(`sessionId=${b.second}`)
    expect(secondRight!.url).toContain(`sessionId=${b.second}`)
    act(() => { firstRight!.output(' while hidden'); secondRight!.output('second right output') })
    expect(firstBottom!.close).not.toHaveBeenCalled()
    expect(firstRight!.close).not.toHaveBeenCalled()

    await b.runtime.sessions.setCurrent(undefined)
    b.bottom.update({ sessionId: undefined, shown: false })
    expect(Socket.instances).toHaveLength(4)
    expect(terminals.instances.every(terminal => terminal.dispose.mock.calls.length === 0)).toBe(true)
    expect(Socket.instances.every(socket => socket.close.mock.calls.length === 0)).toBe(true)

    await b.runtime.sessions.setCurrent(b.first)
    b.bottom.update({ sessionId: b.first, shown: true })
    expect(Socket.instances).toHaveLength(4)
    expect(b.workbench.view.getByRole('tab', { name: 'coding 1' }).getAttribute('aria-selected')).toBe('true')
    expect(b.workbench.container.textContent).toContain('first right output while hidden')
    expect(b.bottom.container.textContent).toContain('first bottom output')

    await b.runtime.sessions.remove(b.first)
    b.bottom.update({ sessionId: undefined, shown: false })
    expect(firstRight!.close).toHaveBeenCalledTimes(1)
    expect(firstBottom!.close).toHaveBeenCalledTimes(1)
    expect(secondRight!.close).not.toHaveBeenCalled()
    expect(secondBottom!.close).not.toHaveBeenCalled()
    expect(terminals.instances[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(terminals.instances[1]!.dispose).toHaveBeenCalledTimes(1)

    await b.feature.dispose()
    expect(secondRight!.close).toHaveBeenCalledTimes(1)
    expect(secondBottom!.close).toHaveBeenCalledTimes(1)
    expect(terminals.instances.every(terminal => terminal.dispose.mock.calls.length === 1)).toBe(true)
    expect(b.runtime.slots.entries('workbench')).toEqual([])
    expect(b.runtime.slots.entries('workbench.bottom')).toEqual([])
    expect(b.runtime.slots.snapshot('workbench.browser')).toEqual([])
  })
})
