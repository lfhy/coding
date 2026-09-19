/** 内置工作台用户终端的 WebSocket 协议与进程生命周期。 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { TextDecoder } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  remoteWorkspacePath,
  type SubprocessRuntime,
  type SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
import WebSocket, { type RawData, WebSocketServer } from 'ws'
import type {
  OpenInAppTerminalClientFrame,
  OpenInAppTerminalServerFrame,
} from './shared.ts'

const MAX_SESSION_ID_BYTES = 1024
const MAX_INPUT_BYTES = 64 * 1024
const MAX_FRAME_BYTES = MAX_INPUT_BYTES + 4 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_COLS = 500
const MAX_ROWS = 200
const TERMINATE_GRACE_MS = 1_000

/** 用户终端按此顺序选择执行世界中首个可用 Shell。 */
export const TERMINAL_SHELL_CANDIDATES = ['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd'] as const

/** 通过封闭 query 校验后的终端连接参数。 */
export interface TerminalUpgradeRequest {
  readonly sessionId: string
  readonly cols: number
  readonly rows: number
}

/** 已验证的交互 Shell 启动信息。 */
export interface ResolvedTerminalShell {
  readonly path: string
  readonly name: string
  readonly args: readonly string[]
}

type ParseResult =
  | { readonly ok: true; readonly frame: OpenInAppTerminalClientFrame }
  | { readonly ok: false; readonly message: string }

interface OpenInAppConnection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function dimensions(cols: unknown, rows: unknown): { readonly cols: number; readonly rows: number } | undefined {
  if (typeof cols !== 'number' || !Number.isSafeInteger(cols) || cols < 2 || cols > MAX_COLS
    || typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 1 || rows > MAX_ROWS) return undefined
  return { cols, rows }
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * 解析只允许 `sessionId`、`cols`、`rows` 各出现一次的 upgrade URL。
 * @param rawUrl - Node HTTP upgrade 请求中的原始 URL。
 * @returns 通过校验的参数；字段缺失、重复、多余或越界时返回 undefined。
 */
export function parseTerminalUpgradeUrl(rawUrl: string | undefined): TerminalUpgradeRequest | undefined {
  let url: URL
  try {
    url = new URL(rawUrl ?? '', 'http://localhost')
  } catch {
    return undefined
  }
  const keys = [...url.searchParams.keys()]
  if (keys.length !== 3 || keys.some(key => key !== 'sessionId' && key !== 'cols' && key !== 'rows')) {
    return undefined
  }
  const sessionIds = url.searchParams.getAll('sessionId')
  const colValues = url.searchParams.getAll('cols')
  const rowValues = url.searchParams.getAll('rows')
  if (sessionIds.length !== 1 || colValues.length !== 1 || rowValues.length !== 1) return undefined
  const sessionId = sessionIds[0] as string
  const cols = parsePositiveInteger(colValues[0] as string)
  const rows = parsePositiveInteger(rowValues[0] as string)
  const size = dimensions(cols, rows)
  if (sessionId.length === 0 || sessionId.includes('\0')
    || Buffer.byteLength(sessionId, 'utf8') > MAX_SESSION_ID_BYTES
    || size === undefined) return undefined
  return { sessionId, ...size }
}

/**
 * 校验一个已解码 JSON client frame 的封闭字段集和资源上限。
 * @param value - JSON.parse 产生的未知值。
 * @returns 可执行帧，或面向浏览器的稳定拒绝原因。
 */
export function parseTerminalClientFrame(value: unknown): ParseResult {
  const frame = recordOf(value)
  if (frame === undefined || typeof frame.type !== 'string') {
    return { ok: false, message: 'terminal frame must be a JSON object with string "type"' }
  }
  if (frame.type === 'input') {
    if (Object.keys(frame).some(key => key !== 'type' && key !== 'data') || typeof frame.data !== 'string') {
      return { ok: false, message: 'input frame must contain only string "data"' }
    }
    if (Buffer.byteLength(frame.data, 'utf8') > MAX_INPUT_BYTES) {
      return { ok: false, message: 'terminal input exceeds 65536 bytes' }
    }
    return { ok: true, frame: { type: 'input', data: frame.data } }
  }
  if (frame.type === 'resize') {
    const size = dimensions(frame.cols, frame.rows)
    if (Object.keys(frame).some(key => key !== 'type' && key !== 'cols' && key !== 'rows')
      || size === undefined) {
      return { ok: false, message: 'terminal dimensions are invalid' }
    }
    return { ok: true, frame: { type: 'resize', ...size } }
  }
  if (frame.type === 'close') {
    if (Object.keys(frame).some(key => key !== 'type')) {
      return { ok: false, message: 'close frame must contain only "type"' }
    }
    return { ok: true, frame: { type: 'close' } }
  }
  return { ok: false, message: 'unknown terminal frame type' }
}

function bytesOf(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(data)
}

/**
 * 解码一个 WebSocket 文本消息并校验 client frame。
 * @param data - ws 交付的原始消息。
 * @param isBinary - ws 的二进制消息标记。
 * @returns 可执行帧，或不包含原始载荷的拒绝原因。
 */
export function parseTerminalClientMessage(data: RawData, isBinary: boolean): ParseResult {
  if (isBinary) return { ok: false, message: 'terminal frames must be text JSON' }
  const bytes = bytesOf(data)
  if (bytes.byteLength > MAX_FRAME_BYTES) return { ok: false, message: 'terminal frame is too large' }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, message: 'terminal frame must be valid UTF-8' }
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return { ok: false, message: 'terminal frame must be valid JSON' }
  }
  return parseTerminalClientFrame(value)
}

function shellArgs(name: string): readonly string[] {
  const normalized = name.toLowerCase().replace(/\.exe$/u, '')
  if (normalized === 'cmd') return []
  if (normalized === 'pwsh' || normalized === 'powershell') return ['-NoLogo']
  return ['-i']
}

/**
 * 在 Session 的执行世界中按固定顺序选择第一个已安装 Shell。
 * @param subprocess - Agent 上下文解析出的 subprocess provider。
 * @param cwd - Session header 持有的工作目录。
 * @param signal - 连接关闭或插件卸载时中止探测。
 * @returns 已验证的 executable、展示名和平台正确参数。
 * @throws 所有候选均不可用时抛出稳定错误。
 */
export async function resolveTerminalShell(
  subprocess: SubprocessRuntime,
  cwd: string,
  signal: AbortSignal,
): Promise<ResolvedTerminalShell> {
  const remoteTarget = await remoteWorkspacePath('.', cwd, signal)
  for (const candidate of TERMINAL_SHELL_CANDIDATES) {
    try {
      const path = await subprocess.resolveExecutable(candidate, undefined, signal, remoteTarget)
      return { path, name: candidate, args: shellArgs(candidate) }
    } catch {
      signal.throwIfAborted()
    }
  }
  throw new Error('no supported interactive shell is available')
}

function httpStatusText(status: 400 | 401 | 403 | 404 | 409 | 503): string {
  switch (status) {
    case 400: return 'Bad Request'
    case 401: return 'Unauthorized'
    case 403: return 'Forbidden'
    case 404: return 'Not Found'
    case 409: return 'Conflict'
    case 503: return 'Service Unavailable'
  }
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 403 | 404 | 409 | 503, message: string): void {
  const body = Buffer.from(message, 'utf8')
  socket.end([
    `HTTP/1.1 ${status} ${httpStatusText(status)}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(body.byteLength)}`,
    '',
    message,
  ].join('\r\n'))
}

function sendFrame(socket: WebSocket, frame: OpenInAppTerminalServerFrame): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('terminal websocket is closed'))
      return
    }
    socket.send(JSON.stringify(frame), (error) => {
      // ws 8 在运行时以 null 表示成功，而声明只写了 undefined。
      const failure: Error | null | undefined = error ?? null
      if (failure === null) resolve()
      else reject(failure)
    })
  })
}

function outputChunks(text: string): string[] {
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES) return text.length === 0 ? [] : [text]
  const chunks: string[] = []
  let current = ''
  let bytes = 0
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > MAX_OUTPUT_BYTES) {
      chunks.push(current)
      current = ''
      bytes = 0
    }
    current += character
    bytes += size
  }
  // 进入本分支时 text 超过上限；循环结束后必然仍有最后一段。
  chunks.push(current)
  return chunks
}

function subprocessFor(agent: Agent): SubprocessRuntime | undefined {
  return agent.ctx.get('subprocess')
}

/** WebSocket no-server 终端入口；每条连接独占并终止一个用户 PTY。 */
export class OpenInAppTerminalGateway {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  })
  private readonly sessions = new Set<Promise<void>>()
  private closing = false

  /** @param ctx - 携带 connection、Session、Agent 与 WebServer 服务的 Host 上下文。 */
  constructor(private readonly ctx: Context) {}

  /**
   * 校验并接管一个终端 upgrade。
   * @param req - 原始 HTTP upgrade 请求。
   * @param socket - 尚未协商协议的 TCP socket。
   * @param head - HTTP parser 已读取的首段 WebSocket 数据。
   */
  handle(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.closing) {
      rejectUpgrade(socket, 503, 'terminal gateway is closing')
      return
    }
    const connection = this.ctx.get('connection') as OpenInAppConnection | undefined
    const rejection = connection?.requestRejection(req)
    if (rejection !== undefined) {
      rejectUpgrade(socket, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    if (connection === undefined) {
      rejectUpgrade(socket, 503, 'connection trust service is unavailable')
      return
    }
    const request = parseTerminalUpgradeUrl(req.url)
    if (request === undefined) {
      rejectUpgrade(socket, 400, 'terminal query must contain only sessionId, cols, and rows')
      return
    }
    const id = SessionId(request.sessionId)
    const session = this.ctx.sessions.get(id)
    const agent = this.ctx.agents.get(id)
    if (session === undefined || agent === undefined || agent.session !== session) {
      rejectUpgrade(socket, 404, 'live session agent was not found')
      return
    }
    const cwd = session.header.cwd
    if (cwd === undefined) {
      rejectUpgrade(socket, 409, 'session has no workspace directory')
      return
    }
    const subprocess = subprocessFor(agent)
    if (subprocess === undefined) {
      rejectUpgrade(socket, 503, 'session subprocess provider is unavailable')
      return
    }
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      const run = this.run(websocket, request, cwd, subprocess)
      this.sessions.add(run)
      void run.then(
        () => { this.sessions.delete(run) },
        (error: unknown) => {
          this.sessions.delete(run)
          this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }

  /**
   * 停止接收新连接，断开现有 socket，并等待每个 PTY 完整 terminate。
   * @returns 所有活动连接和 no-server acceptor 停稳后的 Promise。
   */
  async close(): Promise<void> {
    if (this.closing) {
      await Promise.allSettled([...this.sessions])
      return
    }
    this.closing = true
    for (const socket of this.server.clients) socket.terminate()
    const serverClosed = new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    const outcomes = await Promise.allSettled([...this.sessions, serverClosed])
    const failures = outcomes.flatMap<unknown>(outcome => outcome.status === 'rejected'
      ? [outcome.reason as unknown]
      : [])
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'terminal gateway cleanup failed')
  }

  private async run(
    socket: WebSocket,
    request: TerminalUpgradeRequest,
    cwd: string,
    subprocess: SubprocessRuntime,
  ): Promise<void> {
    const abort = new AbortController()
    const stopped = Promise.withResolvers<void>()
    let didStop = false
    let terminal: SubprocessTerminalHandle | undefined
    let output: Promise<void> | undefined
    let controls: Promise<void> = Promise.resolve()

    const stop = (code?: number, reason?: string): void => {
      if (didStop) return
      didStop = true
      abort.abort(new Error('terminal websocket closed'))
      if (code !== undefined && socket.readyState === WebSocket.OPEN) socket.close(code, reason)
      stopped.resolve()
    }
    const report = async (
      code: 'bad-frame' | 'terminal-unavailable' | 'terminal-failed',
      message: string,
    ): Promise<void> => {
      try {
        await sendFrame(socket, { type: 'error', code, message })
      } catch {
        // Socket loss already forces the same terminal cleanup.
      }
    }
    const onClose = (): void => { stop() }
    const onError = (): void => { stop() }
    const onMessage = (data: RawData, isBinary: boolean): void => {
      controls = controls.then(async () => {
        if (didStop) return
        const parsed = parseTerminalClientMessage(data, isBinary)
        if (!parsed.ok) {
          await report('bad-frame', parsed.message)
          stop(1008, 'invalid terminal frame')
          return
        }
        if (parsed.frame.type === 'close') {
          stop(1000, 'terminal closed')
          return
        }
        if (terminal === undefined) {
          await report('terminal-unavailable', 'terminal is not ready')
          stop(1008, 'terminal not ready')
          return
        }
        if (parsed.frame.type === 'input') await terminal.write(parsed.frame.data)
        else await terminal.resize(parsed.frame.cols, parsed.frame.rows)
      }).catch(async () => {
        await report('terminal-failed', 'terminal control failed')
        stop(1011, 'terminal control failed')
      })
    }
    socket.once('close', onClose)
    socket.once('error', onError)
    socket.on('message', onMessage)

    try {
      const shell = await resolveTerminalShell(subprocess, cwd, abort.signal)
      const handle = await subprocess.spawnTerminal({
        argv: [shell.path, ...shell.args],
        cwd,
        env: { DSH_SESSION_ID: request.sessionId, TERM: 'xterm-256color' },
        rows: request.rows,
        cols: request.cols,
        graceMs: TERMINATE_GRACE_MS,
        signal: abort.signal,
      })
      terminal = handle
      abort.signal.throwIfAborted()
      if (typeof terminal.resize !== 'function') throw new Error('terminal provider does not support resize')
      await sendFrame(socket, {
        type: 'ready',
        pid: terminal.pid,
        shell: { name: shell.name, path: shell.path },
        cwd,
        cols: request.cols,
        rows: request.rows,
      })
      output = this.pumpOutput(socket, terminal).catch((error: unknown) => {
        if (didStop || socket.readyState !== WebSocket.OPEN) return
        throw error
      })
      const completed = await Promise.race([
        stopped.promise.then(() => false),
        output.then(() => true),
      ])
      if (completed) stop(1000, 'terminal exited')
    } catch (error) {
      if (!abort.signal.aborted) {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        await report('terminal-failed', 'terminal could not be started or its connection failed')
        stop(1011, 'terminal failed')
      }
    } finally {
      stop()
      const cleanup = terminal?.terminate()
      const outcomes = await Promise.allSettled([
        controls,
        ...cleanup === undefined ? [] : [cleanup],
        ...output === undefined ? [] : [output.catch(() => {})],
      ])
      socket.off('close', onClose)
      socket.off('error', onError)
      socket.off('message', onMessage)
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.terminate()
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      if (failure !== undefined) throw failure.reason
    }
  }

  private async pumpOutput(socket: WebSocket, terminal: SubprocessTerminalHandle): Promise<void> {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    for await (const chunk of terminal.output) {
      const text = decoder.decode(chunk as Buffer, { stream: true })
      for (const data of outputChunks(text)) await sendFrame(socket, { type: 'output', data })
    }
    for (const data of outputChunks(decoder.decode())) await sendFrame(socket, { type: 'output', data })
    const outcome = await terminal.done
    await sendFrame(socket, { type: 'exit', exitCode: outcome.exitCode, signal: outcome.signal })
  }
}
