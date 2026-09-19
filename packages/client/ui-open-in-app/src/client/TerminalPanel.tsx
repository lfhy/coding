import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TerminalClientFrame, TerminalServerFrame } from './wire.ts'
import { NS } from './locales.ts'
import css from './TerminalPanel.module.css'

/** 终端底栏注入的同源 Host WebSocket URL。 */
export interface TerminalPanelInjected {
  terminalUrl: string
}

/** 底栏 owner、终端 URL 与词典组成的 props。 */
export type TerminalPanelProps =
  & PropsRuntime<'workbench.bottom'>
  & PropsLocale<typeof NS>
  & InjectFace<TerminalPanelInjected>

type TerminalStatus =
  | { readonly phase: 'connecting' }
  | { readonly phase: 'connected' }
  | { readonly phase: 'disconnected' }
  | { readonly phase: 'exited'; readonly exitCode: number | null }
  | { readonly phase: 'error'; readonly message: string }

function terminalRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid terminal frame')
  }
  return value as Record<string, unknown>
}

/**
 * 校验 Host 终端帧；未知 discriminant 不会进入渲染或 xterm。
 * @param raw - WebSocket 的文本 data。
 * @returns 封闭的 Host→浏览器帧。
 */
export function parseTerminalServerFrame(raw: unknown): TerminalServerFrame {
  if (typeof raw !== 'string') throw new Error('invalid terminal frame')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('invalid terminal frame')
  }
  const frame = terminalRecord(value)
  if (frame.type === 'ready') {
    const shell = terminalRecord(frame.shell)
    if (Object.keys(frame).some(key => !['type', 'pid', 'shell', 'cwd', 'cols', 'rows'].includes(key))
      || typeof frame.pid !== 'number' || !Number.isSafeInteger(frame.pid) || frame.pid <= 0
      || typeof shell.name !== 'string' || typeof shell.path !== 'string'
      || Object.keys(shell).some(key => key !== 'name' && key !== 'path')
      || typeof frame.cwd !== 'string'
      || typeof frame.cols !== 'number' || !Number.isSafeInteger(frame.cols)
      || typeof frame.rows !== 'number' || !Number.isSafeInteger(frame.rows)) throw new Error('invalid terminal frame')
    return {
      type: 'ready', pid: frame.pid, shell: { name: shell.name, path: shell.path }, cwd: frame.cwd,
      cols: frame.cols, rows: frame.rows,
    }
  }
  if (frame.type === 'output' && Object.keys(frame).every(key => key === 'type' || key === 'data')
    && typeof frame.data === 'string') return { type: 'output', data: frame.data }
  if (frame.type === 'exit'
    && Object.keys(frame).every(key => key === 'type' || key === 'exitCode' || key === 'signal')
    && (frame.exitCode === null || (typeof frame.exitCode === 'number' && Number.isInteger(frame.exitCode)))
    && (frame.signal === null || typeof frame.signal === 'string')) {
    return { type: 'exit', exitCode: frame.exitCode, signal: frame.signal }
  }
  if (frame.type === 'error'
    && Object.keys(frame).every(key => key === 'type' || key === 'code' || key === 'message')
    && (frame.code === 'bad-frame' || frame.code === 'terminal-unavailable' || frame.code === 'terminal-failed')
    && typeof frame.message === 'string') return { type: 'error', code: frame.code, message: frame.message }
  throw new Error('invalid terminal frame')
}

function send(socket: WebSocket | undefined, frame: TerminalClientFrame): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
}

function statusText(status: TerminalStatus, t: TerminalPanelProps['t']): string {
  if (status.phase === 'connecting') return t('terminal.connecting')
  if (status.phase === 'connected') return t('terminal.connected')
  if (status.phase === 'disconnected') return t('terminal.disconnected')
  if (status.phase === 'exited') {
    return t('terminal.exited', { code: status.exitCode === null ? '—' : String(status.exitCode) })
  }
  return t('terminal.error', { message: status.message })
}

/**
 * 保留式底栏终端。首次显示才建立连接；之后 shown 只控制展示，因此收起底栏
 * 不会断开进程。卸载关闭 WebSocket，Host 负责等待对应 PTY 停稳。
 * @param props - 布局可见状态、Host URL 和本地化文案。
 * @returns xterm 终端及连接状态。
 */
export function TerminalPanel({ shown, terminalUrl, t }: TerminalPanelProps): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal>()
  const socket = useRef<WebSocket>()
  const ready = useRef(false)
  const shownRef = useRef(shown)
  const tRef = useRef(t)
  /* v8 ignore next -- React 先执行初始化 layout effect，WebSocket／ResizeObserver 才能调用此 ref。 */
  const resize = useRef<() => void>(() => {})
  const [generation, setGeneration] = useState(0)
  const [status, setStatus] = useState<TerminalStatus>({ phase: 'connecting' })
  shownRef.current = shown
  tRef.current = t

  useLayoutEffect(() => {
    const node = element.current
    /* v8 ignore next -- 终端容器在此组件中无条件渲染，effect 执行时 ref 已设置。 */
    if (node === null) return
    const instance = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      minimumContrastRatio: 4.5,
      scrollback: 5_000,
    })
    const addon = new FitAddon()
    instance.loadAddon(addon)
    instance.open(node)
    const style = getComputedStyle(node)
    instance.options.theme = { background: style.backgroundColor, foreground: style.color }
    instance.textarea?.setAttribute('aria-label', t('terminal.label'))
    terminal.current = instance

    resize.current = () => {
      if (!ready.current || !shownRef.current || node.clientWidth === 0 || node.clientHeight === 0) return
      addon.fit()
      if (instance.cols >= 2 && instance.rows >= 1) {
        send(socket.current, { type: 'resize', cols: instance.cols, rows: instance.rows })
      }
    }
    const input = instance.onData((data) => {
      if (ready.current) send(socket.current, { type: 'input', data })
    })
    const observer = new ResizeObserver(() => { resize.current() })
    observer.observe(node)
    return () => {
      /* v8 ignore next -- 断开 observer 后的哨兵只防御浏览器已排队的晚到回调。 */
      resize.current = () => {}
      observer.disconnect()
      input.dispose()
      instance.dispose()
      terminal.current = undefined
    }
  }, [])

  useEffect(() => {
    terminal.current?.textarea?.setAttribute('aria-label', t('terminal.label'))
  }, [t])

  useLayoutEffect(() => {
    if (shown) {
      resize.current()
      terminal.current?.focus()
    }
  }, [shown])

  useEffect(() => {
    let disposed = false
    let ended = false
    ready.current = false
    setStatus({ phase: 'connecting' })
    let next: WebSocket
    try {
      next = new WebSocket(terminalUrl)
    } catch (error) {
      setStatus({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
      return
    }
    socket.current = next
    next.addEventListener('message', (event) => {
      try {
        const frame = parseTerminalServerFrame(event.data)
        if (frame.type === 'ready') {
          ready.current = true
          setStatus({ phase: 'connected' })
          resize.current()
        } else if (frame.type === 'output') {
          terminal.current?.write(frame.data)
        } else if (frame.type === 'exit') {
          ready.current = false
          ended = true
          setStatus({ phase: 'exited', exitCode: frame.exitCode })
        } else {
          ready.current = false
          setStatus({ phase: 'error', message: frame.message })
        }
      } catch {
        ready.current = false
        setStatus({ phase: 'error', message: tRef.current('terminal.protocolError') })
      }
    })
    next.addEventListener('error', () => {
      ready.current = false
      if (!disposed) setStatus({ phase: 'error', message: tRef.current('terminal.disconnected') })
    })
    next.addEventListener('close', () => {
      ready.current = false
      if (!disposed && !ended) setStatus({ phase: 'disconnected' })
    })
    return () => {
      disposed = true
      ready.current = false
      socket.current = undefined
      if (next.readyState === WebSocket.CONNECTING || next.readyState === WebSocket.OPEN) next.close()
    }
  }, [generation, terminalUrl])

  const reconnectable = status.phase === 'disconnected' || status.phase === 'error' || status.phase === 'exited'
  return (
    <section className={css.root} hidden={!shown} aria-label={t('terminal.label')}>
      <header className={css.header}>
        <strong>{t('terminal.label')}</strong>
        <span className={css.status} role="status" aria-live="polite">{statusText(status, t)}</span>
        {reconnectable && (
          <button type="button" className={css.reconnect} onClick={() => { setGeneration(value => value + 1) }}>
            {t('terminal.reconnect')}
          </button>
        )}
      </header>
      <div className={css.screen} ref={element} />
    </section>
  )
}
