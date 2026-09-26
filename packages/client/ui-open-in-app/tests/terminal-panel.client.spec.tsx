// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
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
const t: TerminalPanelProps['t'] = makeTranslate(zh)

function props(shown = true): TerminalPanelProps {
  return {
    sessionId: SESSION,
    shown,
    terminalUrl: 'ws://dsh.internal/open-in-app/terminal?sessionId=terminal-session&cols=80&rows=24',
    closeBottom: vi.fn(),
    t,
  } as unknown as TerminalPanelProps
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
    const mounted = render(<RetainedTerminalPanel {...props(false)} />)
    expect(FakeWebSocket.instances).toEqual([])
    expect(terminalMocks.instances).toEqual([])
    mounted.rerender(<RetainedTerminalPanel {...props(true)} />)
    await waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    expect(terminalMocks.instances).toHaveLength(1)
    mounted.rerender(<RetainedTerminalPanel {...props(false)} />)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('keeps independent PTYs and output on tab switches, closes one tab, and hides the panel separately', async () => {
    const p = props()
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
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh['terminal.newTab'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['terminal.newTab'] }))
    expect(screen.getByRole('tab', { name: 'coding 3' })).toBeDefined()
    expect(FakeWebSocket.instances).toHaveLength(3)
  })
})
