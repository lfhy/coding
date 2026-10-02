// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceWorkbench, type WorkspaceWorkbenchProps } from '../src/client/WorkspaceWorkbench.tsx'
import { WorkbenchPanelToggles } from '../src/client/WorkbenchPanelToggles.tsx'
import { createRetainedWorkbenchStore } from '../src/client/store.ts'
import { RetainedTerminalPanel } from '../src/client/RetainedTerminalPanel.tsx'
import { parseTerminalServerFrame, TerminalPanel, type TerminalPanelProps } from '../src/client/TerminalPanel.tsx'
import { zh } from '../src/client/locales.ts'

const terminalMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    cols: number
    rows: number
    options: Record<string, unknown>
    textarea: HTMLTextAreaElement | undefined
    node: HTMLElement | undefined
    data: ((value: string) => void) | undefined
    writes: string[]
    focus: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    inputDispose: ReturnType<typeof vi.fn>
  }>,
  fitCount: 0,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    textarea: HTMLTextAreaElement | undefined
    node: HTMLElement | undefined
    data: ((value: string) => void) | undefined
    writes: string[] = []
    focus = vi.fn(() => { this.textarea?.focus() })
    dispose = vi.fn()
    inputDispose = vi.fn()

    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
      terminalMocks.instances.push(this)
    }

    loadAddon(): void {}
    open(node: HTMLElement): void {
      this.node = node
      this.textarea = document.createElement('textarea')
      node.append(this.textarea)
    }
    onData(listener: (value: string) => void) {
      this.data = listener
      return { dispose: this.inputDispose }
    }
    write(value: string): void { this.writes.push(value) }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void { terminalMocks.fitCount += 1 }
  },
}))

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly disconnect = vi.fn()
  readonly observe = vi.fn()

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sent: string[] = []
  readyState = FakeWebSocket.CONNECTING
  readonly close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED
  })

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(value: string): void { this.sent.push(value) }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: value }))
  }

  fail(): void { this.dispatchEvent(new Event('error')) }

  finish(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close'))
  }
}

const SESSION = 'terminal-session' as SessionId
const OTHER_SESSION = 'other-session' as SessionId
const RETAINED_IDS = [SESSION, OTHER_SESSION]
const t: TerminalPanelProps['t'] = makeTranslate(zh)

function retainedProps(sessionId: SessionId | undefined = SESSION, shown = true) {
  return {
    sessionId, shown, t,
    useSessions: (selector: (state: SessionListState) => unknown) => selector({ ids: RETAINED_IDS } as SessionListState),
    terminalUrl: (id: SessionId) => `ws://dsh.internal/open-in-app/terminal?sessionId=${id}`,
    closeBottom: vi.fn(),
  } as unknown as Parameters<typeof RetainedTerminalPanel>[0]
}

function props(shown = true): TerminalPanelProps {
  return {
    sessionId: SESSION,
    shown,
    terminalUrl: 'ws://dsh.internal/open-in-app/terminal?sessionId=terminal-session&cols=80&rows=24',
    closeBottom: vi.fn(),
    t,
  }
}

beforeEach(() => {
  terminalMocks.instances.length = 0
  terminalMocks.fitCount = 0
  FakeResizeObserver.instances.length = 0
  FakeWebSocket.instances.length = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  cleanup()
  document.body.style.removeProperty('color')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function rightWorkbench() {
  const instance = createRetainedWorkbenchStore().create()
  const list = createSnapshotStore<Pick<SessionListState, 'ids' | 'current'>>({ ids: RETAINED_IDS, current: SESSION })
  const bottomToggle = vi.fn()
  const workbenchProps = {
    shown: true, fullscreen: false, bottomOpen: false, filesOpen: true, t,
    useStore: bindSnapshotSelector(instance.store), actions: instance.actions,
    useSessions: bindSnapshotSelector(list),
    terminalUrl: retainedProps().terminalUrl,
    listFiles: vi.fn(async () => ({ path: '/w', entries: [], truncated: false })),
    readFile: vi.fn(async () => ({ path: '/w/a.txt', content: { kind: 'text', text: 'file output' } })),
    openWorkbench: vi.fn(), closeWorkbench: vi.fn(), toggleWorkbenchFullscreen: vi.fn(),
    toggleFiles: vi.fn(), toggleBottom: bottomToggle,
    renderSlot: vi.fn((name: string, owner: {
      shown: boolean
      tabId?: string
      browserShown?: boolean
      openBrowser: (id?: string) => void
    }) => name === 'workbench.browser'
      ? <div hidden={!owner.shown}>browser page</div>
      : owner.tabId === undefined ? null : <button type="button" role="tab"
        aria-selected={owner.browserShown} onClick={() => { owner.openBrowser(owner.tabId) }}>browser tab</button>),
  } as unknown as WorkspaceWorkbenchProps
  return { instance, list, props: workbenchProps, bottomToggle }
}

describe('右侧和底栏终端', () => {
  it('菜单和页头分别打开各自终端，输入输出与关闭互不串线', async () => {
    const b = rightWorkbench()
    const closeBottom = vi.fn()
    function BothPanels() {
      const [bottomOpen, setBottomOpen] = useState(false)
      return <>
        <WorkbenchPanelToggles {...{
          sessionId: SESSION, t,
          useWorkbenchLayout: (selector: (value: unknown) => unknown) => selector({ open: true, bottomOpen }),
          toggleBottom: () => { setBottomOpen(value => !value) }, toggleWorkbench: vi.fn(),
        } as unknown as Parameters<typeof WorkbenchPanelToggles>[0]} />
        <WorkspaceWorkbench {...b.props} bottomOpen={bottomOpen} />
        <section aria-label="终端底栏"><RetainedTerminalPanel {...retainedProps(SESSION, bottomOpen)}
          closeBottom={() => { closeBottom(); setBottomOpen(false) }} /></section>
      </>
    }
    const mounted = render(<BothPanels />)
    expect(FakeWebSocket.instances).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.terminal'] }))
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(b.bottomToggle).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: zh['workbench.bottom.show'] })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.bottom.show'] }))
    expect(FakeWebSocket.instances).toHaveLength(2)
    const right = within(screen.getByRole('region', { name: zh['workbench.label'] }))
    const bottom = within(screen.getByRole('region', { name: '终端底栏' }))
    expect(right.getByRole('tab', { name: 'coding 1' }).getAttribute('aria-selected')).toBe('true')
    expect(bottom.getByRole('tab', { name: 'coding 1' }).getAttribute('aria-selected')).toBe('true')
    const [rightSocket, bottomSocket] = FakeWebSocket.instances
    const [rightTerminal, bottomTerminal] = terminalMocks.instances
    act(() => {
      for (const socket of FakeWebSocket.instances) {
        socket.open()
        socket.message('{"type":"ready","pid":123,"shell":{"name":"zsh","path":"/bin/zsh"},"cwd":"/w","cols":80,"rows":24}')
      }
      rightSocket?.message('{"type":"output","data":"right output"}')
      bottomSocket?.message('{"type":"output","data":"bottom output"}')
      rightTerminal?.data?.('right input\r')
      bottomTerminal?.data?.('bottom input\r')
    })
    expect(rightTerminal?.writes).toEqual(['right output'])
    expect(bottomTerminal?.writes).toEqual(['bottom output'])
    expect(rightSocket?.sent.map((value): unknown => JSON.parse(value))).toContainEqual({ type: 'input', data: 'right input\r' })
    expect(bottomSocket?.sent.map((value): unknown => JSON.parse(value))).toContainEqual({ type: 'input', data: 'bottom input\r' })
    expect(rightSocket?.sent.some(value => value.includes('bottom input'))).toBe(false)
    expect(bottomSocket?.sent.some(value => value.includes('right input'))).toBe(false)
    expect(right.getByRole('tab', { name: 'coding 1' }).id).not.toBe(bottom.getByRole('tab', { name: 'coding 1' }).id)
    fireEvent.click(right.getByRole('button', { name: zh['tabs.close'].replace('{name}', 'coding 1') }))
    expect(rightSocket?.close).toHaveBeenCalledOnce()
    expect(rightTerminal?.dispose).toHaveBeenCalledOnce()
    expect(bottomSocket?.close).not.toHaveBeenCalled()
    expect(bottomTerminal?.dispose).not.toHaveBeenCalled()
    expect(closeBottom).not.toHaveBeenCalled()
    expect(right.getByRole('navigation', { name: zh['workbench.menu.label'] })).toBeDefined()
    fireEvent.click(right.getByRole('button', { name: zh['workbench.menu.terminal'] }))
    const nextRight = FakeWebSocket.instances[2]
    fireEvent.click(bottom.getByRole('button', { name: zh['terminal.closeTab'].replace('{name}', 'coding 1') }))
    await waitFor(() => { expect(closeBottom).toHaveBeenCalledOnce() })
    expect(bottomSocket?.close).toHaveBeenCalledOnce()
    expect(nextRight?.close).not.toHaveBeenCalled()
    expect(right.getByRole('tab', { name: 'coding 2' })).toBeDefined()
    mounted.unmount()
    expect(nextRight?.close).toHaveBeenCalledOnce()
  })

  it('混合类型和终端标签切换保留PTY，隐藏及会话切换保留输出，移除才释放', () => {
    const b = rightWorkbench()
    const mounted = render(<WorkspaceWorkbench {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.terminal'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['terminal.newTab'] }))
    const [first, second] = FakeWebSocket.instances
    const [firstTerminal, secondTerminal] = terminalMocks.instances
    act(() => {
      first?.message('{"type":"output","data":"first scrollback"}')
      second?.message('{"type":"output","data":"second scrollback"}')
    })
    fireEvent.keyDown(screen.getByRole('tab', { name: 'coding 2' }), { key: 'Home' })
    expect(screen.getByRole('tab', { name: 'coding 1' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'coding 1' }))
    fireEvent.click(screen.getByRole('button', { name: zh['terminal.newTab'] }))
    expect(document.activeElement).toBe(terminalMocks.instances[2]?.textarea)
    fireEvent.click(screen.getByRole('button', { name: zh['tabs.close'].replace('{name}', 'coding 3') }))
    act(() => {
      b.instance.actions.openFile(SESSION, { name: 'a.txt', segments: ['a.txt'] })
      b.instance.actions.syncBrowserTabs(SESSION, [{ id: 'browser-page', name: 'Page' }], 'browser-page')
    })
    expect(screen.getByRole('tab', { name: 'a.txt' })).toBeDefined()
    expect(screen.getByRole('tab', { name: 'coding 1' })).toBeDefined()
    fireEvent.click(screen.getByRole('tab', { name: 'browser tab' }))
    expect(screen.getByText('browser page').hasAttribute('hidden')).toBe(false)
    fireEvent.click(screen.getByRole('tab', { name: 'coding 1' }), { detail: 1 })
    expect(firstTerminal?.writes).toEqual(['first scrollback'])
    expect(secondTerminal?.writes).toEqual(['second scrollback'])
    expect(document.activeElement).toBe(firstTerminal?.textarea)
    expect(FakeWebSocket.instances).toHaveLength(3)
    expect(first?.close).not.toHaveBeenCalled()
    expect(second?.close).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'coding 1' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'coding 2' }))
    mounted.rerender(<WorkspaceWorkbench {...b.props} shown={false} />)
    mounted.rerender(<WorkspaceWorkbench {...b.props} />)
    expect(document.activeElement).toBe(secondTerminal?.textarea)
    fireEvent.click(screen.getByRole('tab', { name: 'coding 1' }), { detail: 1 })
    mounted.rerender(<WorkspaceWorkbench {...b.props} shown={false} />)
    act(() => { b.list.set({ ids: RETAINED_IDS, current: OTHER_SESSION }) })
    mounted.rerender(<WorkspaceWorkbench {...b.props} />)
    expect(FakeWebSocket.instances).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.terminal'] }))
    const other = FakeWebSocket.instances[3]
    act(() => { b.list.set({ ids: RETAINED_IDS, current: SESSION }) })
    expect(FakeWebSocket.instances).toHaveLength(4)
    expect(firstTerminal?.writes).toEqual(['first scrollback'])
    expect(first?.close).not.toHaveBeenCalled()
    expect(other?.close).not.toHaveBeenCalled()
    act(() => { b.list.set({ ids: RETAINED_IDS, current: undefined }) })
    expect(first?.close).not.toHaveBeenCalled()
    act(() => { b.list.set({ ids: [OTHER_SESSION], current: OTHER_SESSION }) })
    expect(first?.close).toHaveBeenCalledOnce()
    expect(second?.close).toHaveBeenCalledOnce()
    expect(firstTerminal?.dispose).toHaveBeenCalledOnce()
    expect(other?.close).not.toHaveBeenCalled()
    mounted.unmount()
    expect(other?.close).toHaveBeenCalledOnce()
  })

  it('右侧shell退出关闭所属tab，意外断连保持tab并只重连对应socket', () => {
    const b = rightWorkbench()
    render(<WorkspaceWorkbench {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.menu.terminal'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['terminal.newTab'] }))
    const [first, second] = FakeWebSocket.instances
    act(() => { second?.finish() })
    expect(screen.getByRole('tab', { name: 'coding 2' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: zh['terminal.reconnect'] }))
    expect(FakeWebSocket.instances).toHaveLength(3)
    expect(first?.close).not.toHaveBeenCalled()
    const reconnected = FakeWebSocket.instances[2]
    act(() => {
      reconnected?.message('{"type":"exit","exitCode":0,"signal":null}')
      reconnected?.finish()
    })
    expect(screen.queryByRole('tab', { name: 'coding 2' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'coding 1' }).getAttribute('aria-selected')).toBe('true')
    act(() => { first?.message('{"type":"exit","exitCode":0,"signal":null}'); first?.finish() })
    expect(screen.getByRole('navigation', { name: zh['workbench.menu.label'] })).toBeDefined()
    expect(b.bottomToggle).not.toHaveBeenCalled()
  })
})

describe('terminal frame parser', () => {
  it('accepts the complete Host frame union', () => {
    expect(parseTerminalServerFrame('{"type":"ready","pid":123,"shell":{"name":"zsh","path":"/bin/zsh"},"cwd":"/w","cols":80,"rows":24}')).toEqual({
      type: 'ready', pid: 123, shell: { name: 'zsh', path: '/bin/zsh' }, cwd: '/w', cols: 80, rows: 24,
    })
    expect(parseTerminalServerFrame('{"type":"output","data":"hi"}')).toEqual({ type: 'output', data: 'hi' })
    expect(parseTerminalServerFrame('{"type":"exit","exitCode":0,"signal":null}'))
      .toEqual({ type: 'exit', exitCode: 0, signal: null })
    expect(parseTerminalServerFrame('{"type":"exit","exitCode":null,"signal":"SIGTERM"}'))
      .toEqual({ type: 'exit', exitCode: null, signal: 'SIGTERM' })
    expect(parseTerminalServerFrame('{"type":"error","code":"terminal-failed","message":"bad"}'))
      .toEqual({ type: 'error', code: 'terminal-failed', message: 'bad' })
  })

  it('rejects binary, malformed JSON, non-record, and invalid discriminants', () => {
    for (const value of [
      new Uint8Array(), '{', 'null', '[]',
      '{"type":"ready"}',
      '{"type":"ready","pid":0,"shell":{"name":"zsh","path":"/bin/zsh"},"cwd":"/w","cols":80,"rows":24}',
      '{"type":"ready","pid":1,"shell":null,"cwd":"/w","cols":80,"rows":24}',
      '{"type":"output","data":1}',
      '{"type":"exit","exitCode":1.5,"signal":null}',
      '{"type":"exit","exitCode":0,"signal":1}',
      '{"type":"error","code":"other","message":"bad"}',
      '{"type":"error","code":"terminal-failed","message":1}',
      '{"type":"unknown"}',
    ]) {
      expect(() => parseTerminalServerFrame(value)).toThrow('invalid terminal frame')
    }
  })
})

describe('TerminalPanel', () => {
  it('carries output, input, resize, visibility, and cleanup through one retained socket', async () => {
    const mounted = render(<TerminalPanel {...props()} />)
    const connection = FakeWebSocket.instances[0] as FakeWebSocket
    const terminal = terminalMocks.instances[0]
    expect(connection.url).toContain('terminal-session')
    expect(terminal?.options).toMatchObject({ cursorStyle: 'block', cursorInactiveStyle: 'outline' })
    expect(terminal?.options.theme).toMatchObject({
      cursor: getComputedStyle(terminal?.node as HTMLElement).color,
      cursorAccent: getComputedStyle(terminal?.node as HTMLElement).backgroundColor,
    })
    document.body.style.color = 'rgb(23, 45, 67)'
    await waitFor(() => {
      expect((terminal?.options.theme as { cursor: string }).cursor).toBe('rgb(23, 45, 67)')
    })
    expect(screen.getByRole('status').textContent).toBe(zh['terminal.connecting'])

    terminal?.data?.('before-open')
    expect(connection.sent).toEqual([])
    const node = terminal?.node as HTMLElement
    Object.defineProperty(node, 'clientWidth', { configurable: true, value: 640 })
    Object.defineProperty(node, 'clientHeight', { configurable: true, value: 240 })
    if (terminal !== undefined) { terminal.cols = 1; terminal.rows = 0 }
    connection.open()
    expect(connection.sent).toEqual([])

    if (terminal !== undefined) { terminal.cols = 90; terminal.rows = 18 }
    FakeResizeObserver.instances[0]?.trigger()
    expect(connection.sent).toEqual([])
    terminal?.data?.('echo hi\r')
    expect(connection.sent).toEqual([])

    connection.message('{"type":"ready","pid":123,"shell":{"name":"zsh","path":"/bin/zsh"},"cwd":"/w","cols":80,"rows":24}')
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(zh['terminal.connected']) })
    expect(JSON.parse(connection.sent.at(-1) ?? '{}')).toEqual({ type: 'resize', cols: 90, rows: 18 })
    if (terminal !== undefined) { terminal.cols = 1; terminal.rows = 0 }
    const sentBeforeInvalidResize = connection.sent.length
    FakeResizeObserver.instances[0]?.trigger()
    expect(connection.sent).toHaveLength(sentBeforeInvalidResize)
    if (terminal !== undefined) { terminal.cols = 90; terminal.rows = 18 }
    terminal?.data?.('echo hi\r')
    expect(JSON.parse(connection.sent.at(-1) ?? '{}')).toEqual({ type: 'input', data: 'echo hi\r' })
    connection.message('{"type":"output","data":"hello\\r\\n"}')
    expect(terminal?.writes).toEqual(['hello\r\n'])

    mounted.rerender(<TerminalPanel {...props(false)} />)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(connection.close).not.toHaveBeenCalled()
    expect(mounted.container.querySelector('section')?.hidden).toBe(true)
    mounted.rerender(<TerminalPanel {...props(true)} />)
    expect(terminal?.focus).toHaveBeenCalled()
    expect(terminal?.textarea?.getAttribute('aria-label')).toBe(zh['terminal.label'])

    connection.readyState = FakeWebSocket.CLOSING
    const sentBeforeClosingInput = connection.sent.length
    terminal?.data?.('ignored while closing')
    expect(connection.sent).toHaveLength(sentBeforeClosingInput)
    connection.readyState = FakeWebSocket.OPEN

    mounted.unmount()
    expect(connection.close).toHaveBeenCalledOnce()
    expect(terminal?.inputDispose).toHaveBeenCalledOnce()
    expect(terminal?.dispose).toHaveBeenCalledOnce()
    expect(FakeResizeObserver.instances[0]?.disconnect).toHaveBeenCalledOnce()
    connection.fail()
  })

  it('reports protocol and Host errors and reconnects without replacing xterm', async () => {
    render(<TerminalPanel {...props()} />)
    const first = FakeWebSocket.instances[0] as FakeWebSocket
    first.message(new Uint8Array())
    expect((await screen.findByRole('status')).textContent)
      .toBe(zh['terminal.error'].replace('{message}', zh['terminal.protocolError']))
    fireEvent.click(screen.getByRole('button', { name: zh['terminal.reconnect'] }))
    await waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    expect(first.close).toHaveBeenCalledOnce()
    expect(terminalMocks.instances).toHaveLength(1)

    const second = FakeWebSocket.instances[1] as FakeWebSocket
    second.message('{"type":"error","code":"terminal-unavailable","message":"permission denied"}')
    await waitFor(() => {
      expect(screen.getByRole('status').textContent)
        .toBe(zh['terminal.error'].replace('{message}', 'permission denied'))
    })
    second.fail()
    await waitFor(() => {
      expect(screen.getByRole('status').textContent)
        .toBe(zh['terminal.error'].replace('{message}', zh['terminal.disconnected']))
    })
    second.finish()
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(zh['terminal.disconnected']) })
  })

  it('shows an exited terminal and reconnects from a closed socket', async () => {
    render(<TerminalPanel {...props()} />)
    const first = FakeWebSocket.instances[0] as FakeWebSocket
    first.open()
    first.message('{"type":"exit","exitCode":7,"signal":null}')
    expect((await screen.findByRole('status')).textContent)
      .toBe(zh['terminal.exited'].replace('{code}', '7'))
    first.message('{"type":"exit","exitCode":null,"signal":"SIGTERM"}')
    expect((await screen.findByRole('status')).textContent)
      .toBe(zh['terminal.exited'].replace('{code}', '—'))
    first.finish()
    expect(screen.getByRole('status').textContent)
      .toBe(zh['terminal.exited'].replace('{code}', '—'))
    fireEvent.click(screen.getByRole('button', { name: zh['terminal.reconnect'] }))
    await waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
  })

  it('surfaces a synchronous WebSocket construction failure', async () => {
    class ThrowingWebSocket {
      static readonly OPEN = 1
      constructor() { throw new Error('constructor failed') }
    }
    vi.stubGlobal('WebSocket', ThrowingWebSocket)
    render(<TerminalPanel {...props()} />)
    expect((await screen.findByRole('status')).textContent)
      .toBe(zh['terminal.error'].replace('{message}', 'constructor failed'))
    cleanup()
    class StringThrowingWebSocket {
      static readonly OPEN = 1
      constructor() { throw 'string failure' }
    }
    vi.stubGlobal('WebSocket', StringThrowingWebSocket)
    render(<TerminalPanel {...props()} />)
    expect((await screen.findByRole('status')).textContent)
      .toBe(zh['terminal.error'].replace('{message}', 'string failure'))
  })

  it('defers terminal allocation until the bottom panel is first shown', async () => {
    const mounted = render(<RetainedTerminalPanel {...retainedProps(SESSION, false)} />)
    expect(FakeWebSocket.instances).toEqual([])
    expect(terminalMocks.instances).toEqual([])
    mounted.rerender(<RetainedTerminalPanel {...retainedProps(SESSION, true)} />)
    await waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    expect(terminalMocks.instances).toHaveLength(1)
    mounted.rerender(<RetainedTerminalPanel {...retainedProps(SESSION, false)} />)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('preserves each session PTY across conversation switches and releases removed sessions', async () => {
    const firstProps = retainedProps()
    const mounted = render(<RetainedTerminalPanel {...firstProps} />)
    const first = FakeWebSocket.instances[0] as FakeWebSocket
    const firstTerminal = terminalMocks.instances[0]
    act(() => { first.message('{"type":"output","data":"retained output"}') })

    mounted.rerender(<RetainedTerminalPanel {...firstProps} sessionId={OTHER_SESSION} shown />)
    await waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    const second = FakeWebSocket.instances[1] as FakeWebSocket
    expect(second.url).toContain('other-session')
    expect(first.close).not.toHaveBeenCalled()
    expect(firstTerminal?.dispose).not.toHaveBeenCalled()

    mounted.rerender(<RetainedTerminalPanel {...firstProps} sessionId={SESSION} shown />)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(first.close).not.toHaveBeenCalled()
    expect(firstTerminal?.writes).toEqual(['retained output'])
    expect(second.close).not.toHaveBeenCalled()

    mounted.rerender(<RetainedTerminalPanel {...firstProps} sessionId={undefined} shown={false} />)
    expect(first.close).not.toHaveBeenCalled()
    expect(second.close).not.toHaveBeenCalled()

    const reducedIds = [OTHER_SESSION]
    const reduced = {
      ...firstProps,
      useSessions: ((selector: (state: SessionListState) => unknown) =>
        selector({ ids: reducedIds } as SessionListState)) as typeof firstProps.useSessions,
    }
    mounted.rerender(<RetainedTerminalPanel {...reduced} />)
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
    mounted.unmount()
    expect(second.close).toHaveBeenCalledOnce()
  })

  it('keeps independent PTYs and output on tab switches, closes one tab, and hides the panel separately', async () => {
    const p = retainedProps()
    const mounted = render(<RetainedTerminalPanel {...p} />)
    expect(screen.getByRole('tab', { name: 'coding 1' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: zh['terminal.newTab'] }))
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(terminalMocks.instances).toHaveLength(2)
    const [first, second] = FakeWebSocket.instances
    const [firstTerminal, secondTerminal] = terminalMocks.instances
    expect(screen.getByRole('tab', { name: 'coding 2' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(secondTerminal?.textarea)
    const secondTab = screen.getByRole('tab', { name: 'coding 2' })
    secondTab.focus()
    fireEvent.keyDown(secondTab, { key: 'Home' })
    expect(screen.getByRole('tab', { name: 'coding 1' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'coding 1' }))
    fireEvent.keyDown(screen.getByRole('tab', { name: 'coding 1' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'coding 2' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(secondTab)
    second?.message('{"type":"ready","pid":123,"shell":{"name":"zsh","path":"/bin/zsh"},"cwd":"/w","cols":80,"rows":24}')
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(zh['terminal.connected']) })
    expect(document.activeElement).toBe(secondTab)
    second?.message('{"type":"output","data":"second"}')
    first?.message('{"type":"output","data":"first"}')
    fireEvent.click(screen.getByRole('tab', { name: 'coding 1' }), { detail: 1 })
    expect(document.activeElement).toBe(firstTerminal?.textarea)
    expect(firstTerminal?.writes).toEqual(['first'])
    expect(secondTerminal?.writes).toEqual(['second'])
    expect(firstTerminal?.focus).toHaveBeenCalled()
    expect(first?.close).not.toHaveBeenCalled()
    expect(second?.close).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'coding 2' }))
    const closeFirst = screen.getByRole('button', { name: zh['terminal.closeTab'].replace('{name}', 'coding 1') })
    closeFirst.focus()
    fireEvent.click(closeFirst)
    expect(first?.close).toHaveBeenCalledOnce()
    expect(firstTerminal?.dispose).toHaveBeenCalledOnce()
    expect(second?.close).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: 'coding 2' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(secondTerminal?.textarea)

    fireEvent.click(screen.getByRole('button', { name: zh['workbench.bottom.hide'] }))
    expect(p.closeBottom).toHaveBeenCalledOnce()
    mounted.rerender(<RetainedTerminalPanel {...p} shown={false} />)
    expect(second?.close).not.toHaveBeenCalled()
    mounted.rerender(<RetainedTerminalPanel {...p} shown />)
    expect(secondTerminal?.focus).toHaveBeenCalled()
    expect(document.activeElement).toBe(secondTerminal?.textarea)
    const closeSecond = screen.getByRole('button', { name: zh['terminal.closeTab'].replace('{name}', 'coding 2') })
    closeSecond.focus()
    fireEvent.click(closeSecond)
    expect(second?.close).toHaveBeenCalledOnce()
    expect(screen.queryAllByRole('tab')).toEqual([])
    expect(p.closeBottom).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh['terminal.newTab'] }))
    mounted.rerender(<RetainedTerminalPanel {...p} shown={false} />)
    mounted.rerender(<RetainedTerminalPanel {...p} shown />)
    expect(screen.getByRole('tab', { name: 'coding 3' })).toBeDefined()
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('removes only the completed tab after its exit frame and socket close', async () => {
    const p = retainedProps()
    render(<RetainedTerminalPanel {...p} />)
    fireEvent.click(screen.getByRole('button', { name: zh['terminal.newTab'] }))
    const [first, second] = FakeWebSocket.instances
    act(() => { second?.message('{"type":"exit","exitCode":7,"signal":null}') })
    expect(screen.getByRole('tab', { name: 'coding 2' })).toBeDefined()
    expect(p.closeBottom).not.toHaveBeenCalled()

    act(() => { second?.finish() })
    expect(screen.queryByRole('tab', { name: 'coding 2' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'coding 1' }).getAttribute('aria-selected')).toBe('true')
    expect(p.closeBottom).not.toHaveBeenCalled()
    act(() => { second?.finish() })
    expect(p.closeBottom).not.toHaveBeenCalled()

    act(() => { first?.message('{"type":"exit","exitCode":0,"signal":null}') })
    expect(screen.getByRole('tab', { name: 'coding 1' })).toBeDefined()
    act(() => { first?.finish() })
    await waitFor(() => { expect(p.closeBottom).toHaveBeenCalledOnce() })
    expect(screen.queryAllByRole('tab')).toEqual([])
  })

  it('retains unexpectedly disconnected tabs and ignores stale reconnect generations', async () => {
    const p = retainedProps()
    render(<RetainedTerminalPanel {...p} />)
    const first = FakeWebSocket.instances[0] as FakeWebSocket
    act(() => { first.finish() })
    expect(screen.getByRole('tab', { name: 'coding 1' })).toBeDefined()
    expect(p.closeBottom).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['terminal.reconnect'] }))
    await waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    act(() => {
      first.message('{"type":"exit","exitCode":0,"signal":null}')
      first.finish()
    })
    expect(screen.getByRole('tab', { name: 'coding 1' })).toBeDefined()
    expect(p.closeBottom).not.toHaveBeenCalled()
    const second = FakeWebSocket.instances[1] as FakeWebSocket
    act(() => { second.fail(); second.finish() })
    expect(screen.getByRole('button', { name: zh['terminal.reconnect'] })).toBeDefined()
    expect(p.closeBottom).not.toHaveBeenCalled()
  })

  it('closes the bottom once when independent terminal exits arrive in one batch', () => {
    const p = retainedProps()
    render(<RetainedTerminalPanel {...p} />)
    fireEvent.click(screen.getByRole('button', { name: zh['terminal.newTab'] }))
    const [first, second] = FakeWebSocket.instances
    act(() => {
      first?.message('{"type":"exit","exitCode":0,"signal":null}')
      second?.message('{"type":"exit","exitCode":1,"signal":null}')
      first?.finish()
      second?.finish()
    })
    expect(screen.queryAllByRole('tab')).toEqual([])
    expect(p.closeBottom).toHaveBeenCalledOnce()
  })
})
