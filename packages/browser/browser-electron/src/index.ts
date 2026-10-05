/** 桌面 Host 的 BrowserUseService：仅经私有 WS 控制 Electron guest，保留同步只读镜像。 @module @deepseek-ai/dsh-browser-electron */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BrowserUseError, BrowserUseService } from '@deepseek-ai/dsh-browser'
import type { BrowserCapture, BrowserCommand, BrowserExpectedTarget, BrowserHumanCommand, BrowserSessionState } from '@deepseek-ai/dsh-browser'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import WebSocket, { type RawData } from 'ws'
import { decodeBridgeCapture, MAX_BRIDGE_FRAME_BYTES, parseBridgeEvent, parseBridgeFrame, parseBridgeResponse } from './protocol.ts'
import type { BridgeMethod, BridgeRequest, BridgeResponse, BridgeStateEvent } from './protocol.ts'

const MAX_SESSIONS = 8
const MAX_TABS = 8
const MAX_QUEUED = 32
const REQUEST_TIMEOUT = 20_000
const CONNECT_TIMEOUT = 5_000

/** 仅保存环境变量名称；Host 启动时注入的端点和令牌绝不进入配置转储。 */
export interface Config {
  /** 桌面主进程注入私有桥地址的环境变量名，不在配置中保存地址。 */
  readonly originEnv: string
  /** 桌面主进程注入本次启动令牌的环境变量名，不在配置中保存令牌。 */
  readonly tokenEnv: string
}

interface Pending {
  readonly method: BridgeMethod
  readonly resolve: (response: BridgeResponse) => void
  readonly reject: (reason: unknown) => void
  readonly timer: NodeJS.Timeout
}

function unavailable(message: string): BrowserUseError {
  return new BrowserUseError(message, 'BROWSER_UNAVAILABLE')
}
function send(res: ServerResponse, status: number, payload?: unknown): void {
  res.statusCode = status
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  if (payload !== undefined) res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(payload === undefined ? undefined : JSON.stringify(payload))
}
function sessionId(value: string | null): value is SessionId {
  return value !== null && value.length > 0 && value.length <= 256 && /^[a-zA-Z0-9._~-]+$/.test(value)
}

async function awaitReady(ready: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) { await ready; return }
  signal.throwIfAborted()
  let onAbort = (): void => {}
  try {
    await Promise.race([ready, new Promise<never>((_resolve, reject) => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- 取消原因由调用方拥有。
      onAbort = () => { reject(signal.reason) }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })])
  } finally { signal.removeEventListener('abort', onAbort) }
}

/** 只读预览必须同时经过已有连接鉴权、环回监听与同源 Host/Origin 检查。 */
export function trustedFrameRequest(req: IncomingMessage, host: string, port: number): boolean {
  if (host !== '127.0.0.1') return false
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return false
  const authority = req.headers.host
  if (authority !== `127.0.0.1:${port}` && authority !== `localhost:${port}` && authority !== `[::1]:${port}`) return false
  return req.headers.origin === undefined || req.headers.origin === `http://${authority}`
}

/** 同进程同步查询只读镜像；桥接断线后所有调用失败，不换用独立 Chromium。 */
export default class ElectronBrowserUse extends BrowserUseService {
  static Config: z<Config> = z.object({
    originEnv: z.string().pattern(/^[A-Z_][A-Z0-9_]*$/).required(),
    tokenEnv: z.string().pattern(/^[A-Z_][A-Z0-9_]*$/).required(),
  })

  private readonly states = new Map<SessionId, BrowserSessionState>()
  private readonly captures = new Map<SessionId, BrowserCapture>()
  private readonly tails = new Map<SessionId, Promise<void>>()
  private readonly operations = new Map<SessionId, symbol>()
  private readonly pending = new Map<string, Pending>()
  private readonly socket: WebSocket
  private readonly ready: Promise<void>
  private epoch = 0
  private queued = 0
  private disposed = false
  private broken = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const origin = process.env[config.originEnv]
    const token = process.env[config.tokenEnv]
    if (!origin || !token || !/^[0-9a-f]{64}$/.test(token)) {
      throw unavailable('desktop browser bridge environment is missing or invalid')
    }
    let url: URL
    try { url = new URL(origin) }
    catch { throw unavailable('desktop browser bridge origin is invalid') }
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/browser-bridge' || url.href !== origin) {
      throw unavailable('desktop browser bridge must use a private loopback WS origin')
    }
    this.socket = new WebSocket(url.href, { headers: { Authorization: `Bearer ${token}` },
      maxPayload: MAX_BRIDGE_FRAME_BYTES, handshakeTimeout: CONNECT_TIMEOUT, perMessageDeflate: false })
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(unavailable('desktop browser bridge connection timed out')); this.invalidate() }, CONNECT_TIMEOUT)
      timer.unref()
      this.socket.once('open', () => { clearTimeout(timer); resolve() })
      this.socket.once('error', () => { clearTimeout(timer); reject(unavailable('desktop browser bridge connection failed')); this.invalidate() })
      this.socket.once('close', () => { clearTimeout(timer); reject(unavailable('desktop browser bridge closed')); this.invalidate() })
    })
    void this.ready.catch(() => {})
    this.socket.on('message', (data, binary) => { this.receive(data, binary) })
    ctx.inject(['webServer', 'connection'], (webCtx) => {
      for (const path of ['/browser-use/state', '/browser-use/frame']) {
        webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path,
          handler: (req, res) => { this.respond(req, res, path === '/browser-use/frame', webCtx) },
        }), `browser-electron: GET ${path}`)
      }
    })
    // oxlint-disable-next-line typescript/no-misused-promises -- 会话销毁须等待主进程资源释放。
    ctx.on('session/disposed', async (session) => { await this.closeSession(session.id) })
    ctx.effect(() => async () => {
      this.disposed = true
      this.invalidate()
      await Promise.all([...this.tails.values()])
    }, 'browser-electron: bridge lifetime')
  }

  private invalidate(): void {
    if (this.broken) return
    this.broken = true
    this.epoch++
    this.states.clear()
    this.captures.clear()
    this.operations.clear()
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(unavailable('desktop browser bridge was lost'))
    }
    this.pending.clear()
    this.socket.terminate()
  }

  private receive(data: RawData, binary: boolean): void {
    try {
      if (binary || !Buffer.isBuffer(data)) throw new Error('desktop browser expects text frames')
      const value = parseBridgeFrame(data)
      if (typeof value === 'object' && value !== null && 'type' in value) {
        this.publish(parseBridgeEvent(value))
      } else if (typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string') {
        const entry = this.pending.get(value.id)
        if (!entry) throw new Error('unknown desktop browser response id')
        const response = parseBridgeResponse(value, entry.method)
        this.pending.delete(value.id)
        clearTimeout(entry.timer)
        entry.resolve(response)
      } else throw new Error('invalid desktop browser frame')
    } catch { this.invalidate() }
  }

  private publish(event: BridgeStateEvent): void {
    const id = event.sessionId as SessionId
    if (event.state === null) { this.states.delete(id); this.captures.delete(id); return }
    if (!this.states.has(id) && this.states.size >= MAX_SESSIONS) throw new Error('desktop browser session limit exceeded')
    if (event.state.tabs.length > MAX_TABS) throw new Error('desktop browser tab limit exceeded')
    const previous = this.states.get(id)
    if (previous && (previous.browserGeneration !== event.state.browserGeneration ||
      event.state.stateRevision < previous.stateRevision ||
      event.state.stateRevision === previous.stateRevision &&
        (previous.activeTabId !== event.state.activeTabId ||
          previous.observation?.generation !== event.state.observation?.generation ||
          previous.observation?.revision !== event.state.observation?.revision))) {
      throw new Error('desktop browser state regressed')
    }
    const retained = previous?.browserGeneration === event.state.browserGeneration &&
      previous.stateRevision === event.state.stateRevision && previous.activeTabId === event.state.activeTabId &&
      previous.observation?.generation === event.state.observation?.generation &&
      previous.observation?.revision === event.state.observation?.revision &&
      previous.viewport.width === event.state.viewport.width && previous.viewport.height === event.state.viewport.height
    this.states.set(id, event.state)
    if (event.capture) this.captures.set(id, decodeBridgeCapture(event.capture))
    else if (!retained || !event.state.hasFrame) this.captures.delete(id)
  }

  private async request(method: BridgeMethod, id: SessionId, extras: Partial<BridgeRequest> = {},
    signal?: AbortSignal): Promise<BridgeResponse> {
    if (this.broken || this.disposed) throw unavailable('desktop browser bridge is unavailable')
    await awaitReady(this.ready, signal)
    signal?.throwIfAborted()
    if (this.socket.readyState !== WebSocket.OPEN) throw unavailable('desktop browser bridge is unavailable')
    const serial = randomUUID()
    const frame: BridgeRequest = { v: 1, id: serial, method, sessionId: id, ...extras }
    const response = new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => { this.invalidate() }, REQUEST_TIMEOUT)
      timer.unref()
      const onAbort = (): void => { this.invalidate() }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(serial, { method, timer,
        resolve: (result) => { signal?.removeEventListener('abort', onAbort); resolve(result) },
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- 取消必须保留调用方的原始 reason。
        reject: (reason) => { signal?.removeEventListener('abort', onAbort); reject(reason) },
      })
      if (signal?.aborted) { this.invalidate(); return }
      this.socket.send(JSON.stringify(frame), (error) => { if (error) this.invalidate() })
    })
    let result: BridgeResponse
    try { result = await response }
    catch (error) { signal?.throwIfAborted(); throw error }
    signal?.throwIfAborted()
    if (!result.ok) throw new BrowserUseError(result.error.message, result.error.code)
    return result
  }

  private enqueue<T>(id: SessionId, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (this.queued >= MAX_QUEUED) return Promise.reject(new BrowserUseError('browser operation queue is full', 'BROWSER_BUSY'))
    this.queued++
    const predecessor = this.tails.get(id) ?? Promise.resolve()
    const operation = predecessor.catch(() => {}).then(async () => {
      signal.throwIfAborted()
      if (this.broken || this.disposed) throw unavailable('desktop browser bridge is unavailable')
      const epoch = this.epoch
      const result = await action()
      signal.throwIfAborted()
      if (epoch !== this.epoch) throw unavailable('desktop browser bridge changed during operation')
      return result
    })
    const tail = operation.then(() => { this.queued-- }, () => { this.queued-- })
    this.tails.set(id, tail)
    void tail.then(() => { if (this.tails.get(id) === tail) this.tails.delete(id) })
    return operation
  }

  /** @inheritdoc */
  operationActive(id: SessionId): boolean { return this.operations.has(id) }

  /** @inheritdoc */
  async acquireOperation(id: SessionId, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.broken || this.operations.has(id)) throw new BrowserUseError('browser operation already active or unavailable',
      this.broken ? 'BROWSER_UNAVAILABLE' : 'BROWSER_BUSY')
    if (this.operations.size >= MAX_SESSIONS) throw new BrowserUseError('browser session lease limit reached', 'BROWSER_UNAVAILABLE')
    const token = Symbol('browser operation')
    this.operations.set(id, token)
    try {
      await this.enqueue(id, signal, async () => { await this.request('lease', id, {}, signal) })
      return () => {
        if (this.operations.get(id) !== token) return
        this.operations.delete(id)
        void this.enqueue(id, new AbortController().signal, async () => {
          await this.request('release', id)
        }).catch(() => { this.invalidate() })
      }
    } catch (error) { if (this.operations.get(id) === token) this.operations.delete(id); throw error }
  }

  /** @inheritdoc */
  override prepareTarget(id: SessionId, signal: AbortSignal): Promise<BrowserExpectedTarget> {
    return this.enqueue(id, signal, async () => {
      if (!this.operationActive(id)) throw new BrowserUseError('browser operation lease is absent', 'BROWSER_DENIED')
      const response = await this.request('prepare', id, {}, signal)
      if (!response.ok || response.value === null || !('kind' in response.value)) throw unavailable('desktop browser target response is invalid')
      return response.value
    })
  }

  /** @inheritdoc */
  execute(id: SessionId, command: BrowserCommand, signal: AbortSignal, expectedTarget?: BrowserExpectedTarget): Promise<BrowserCapture> {
    return this.enqueue(id, signal, async () => {
      if (!this.operationActive(id)) throw new BrowserUseError('browser operation lease is absent', 'BROWSER_DENIED')
      if (!this.states.has(id) && command.kind === 'navigate' && this.states.size >= MAX_SESSIONS) {
        throw new BrowserUseError('browser session limit reached', 'BROWSER_UNAVAILABLE')
      }
      const response = await this.request('execute', id, { command, ...(expectedTarget ? { expectedTarget } : {}) }, signal)
      if (!response.ok || response.value === null || !('observation' in response.value) || !('png' in response.value)) {
        throw unavailable('desktop browser capture response is invalid')
      }
      const result = decodeBridgeCapture(response.value)
      if (command.kind === 'close') { this.states.delete(id); this.captures.delete(id) }
      else if (this.states.get(id)?.observation?.revision === result.observation.revision &&
        this.states.get(id)?.observation?.generation === result.observation.generation) this.captures.set(id, result)
      return result
    })
  }

  /** @inheritdoc */
  control(id: SessionId, command: BrowserHumanCommand, signal: AbortSignal,
    guard?: () => Promise<void>): Promise<BrowserSessionState | undefined> {
    if (this.operationActive(id)) return Promise.reject(new BrowserUseError('browser is controlled by the agent', 'BROWSER_BUSY'))
    return this.enqueue(id, signal, async () => {
      await guard?.()
      signal.throwIfAborted()
      if (!this.states.has(id) && this.states.size >= MAX_SESSIONS &&
        ['ensure-tab', 'new-tab', 'navigate'].includes(command.kind)) throw new BrowserUseError('browser session limit reached', 'BROWSER_UNAVAILABLE')
      if (command.kind === 'new-tab' && (this.states.get(id)?.tabs.length ?? 0) >= MAX_TABS) {
        throw new BrowserUseError('browser tab limit reached', 'BROWSER_UNAVAILABLE')
      }
      const response = await this.request('control', id, { command }, signal)
      if (!response.ok) throw unavailable('desktop browser control response is invalid')
      const state = response.value as BrowserSessionState | null
      if (state === null) { this.states.delete(id); this.captures.delete(id); return undefined }
      const current = this.states.get(id)
      if (current && (current.browserGeneration !== state.browserGeneration ||
        current.stateRevision > state.stateRevision)) {
        throw new BrowserUseError('browser state changed during operation', 'BROWSER_STALE_REF')
      }
      this.states.set(id, state)
      if (!state.hasFrame || this.captures.get(id)?.observation.revision !== state.observation?.revision ||
        this.captures.get(id)?.observation.generation !== state.observation?.generation) this.captures.delete(id)
      return state
    })
  }

  /** @inheritdoc */
  state(id: SessionId): BrowserSessionState | undefined {
    const state = this.states.get(id)
    return state && { ...state, operationActive: this.operationActive(id) }
  }

  /** @inheritdoc */
  latest(id: SessionId): BrowserCapture | undefined {
    const state = this.states.get(id)
    const capture = this.captures.get(id)
    return state?.hasFrame && capture && state.observation?.revision === capture.observation.revision &&
      state.observation.generation === capture.observation.generation &&
      state.activeTabId === capture.observation.tabId ? capture : undefined
  }

  /** @inheritdoc */
  async closeSession(id: SessionId): Promise<void> {
    try {
      await this.enqueue(id, new AbortController().signal, async () => { await this.request('close', id) })
    } finally { this.states.delete(id); this.captures.delete(id); this.operations.delete(id) }
  }

  private respond(req: IncomingMessage, res: ServerResponse, frame: boolean, webCtx: Context): void {
    const connection = Reflect.get(webCtx, 'connection') as {
      requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
    }
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) { send(res, rejection); return }
    if (!trustedFrameRequest(req, webCtx.webServer.host, webCtx.webServer.port)) { send(res, 403); return }
    if (req.method !== 'GET') { res.setHeader('allow', 'GET'); send(res, 405); return }
    let url: URL
    try { url = new URL(req.url ?? '', 'http://localhost') }
    catch { send(res, 400); return }
    const frameKeys = ['tabId', 'browserGeneration', 'stateRevision', 'generation', 'revision']
    const keys = [...url.searchParams.keys()]
    if (keys.some(key => key !== 'sessionId' && !(frame && frameKeys.includes(key))) ||
      keys.length !== (frame ? 6 : 1) || !sessionId(url.searchParams.get('sessionId'))) { send(res, 400); return }
    const id = url.searchParams.get('sessionId') as SessionId
    const state = this.state(id)
    if (!state) {
      if (!frame && this.operationActive(id)) send(res, 200, { operationActive: true })
      else send(res, frame ? 404 : 204)
      return
    }
    if (!frame) { send(res, 200, state); return }
    const capture = this.latest(id)
    const generation = url.searchParams.get('generation')
    const tabId = url.searchParams.get('tabId')
    const browserGeneration = url.searchParams.get('browserGeneration')
    const stateRevision = url.searchParams.get('stateRevision')
    const revision = url.searchParams.get('revision')
    if (!revision || !/^[1-9][0-9]*$/.test(revision) || !stateRevision ||
      !/^(0|[1-9][0-9]*)$/.test(stateRevision) || !generation || !/^[a-zA-Z0-9-]{1,128}$/.test(generation) ||
      !tabId || !/^[a-zA-Z0-9-]{1,128}$/.test(tabId) || !browserGeneration ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(browserGeneration)) { send(res, 400); return }
    if (browserGeneration !== state.browserGeneration || Number(stateRevision) !== state.stateRevision ||
      tabId !== state.activeTabId || generation !== capture?.observation.generation ||
      Number(revision) !== capture.observation.revision || !capture.png) { send(res, 409); return }
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-type', 'image/png')
    res.end(capture.png)
  }
}
