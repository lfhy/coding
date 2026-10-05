/** 主进程私有的浏览器传输；Host 只可请求共享协议中的六项操作。 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import type { BrowserCapture, BrowserSessionState, BrowserUseErrorCode } from '@deepseek-ai/dsh-browser'
import { MAX_BRIDGE_FRAME_BYTES, MAX_PNG_BYTES, parseBridgeEvent, parseBridgeFrame,
  parseBridgeRequest, parseBridgeResponse, type BridgeResponse, type BridgeStateEvent } from
  '@deepseek-ai/dsh-browser-electron/protocol'
import type { BrowserGuestManager } from './browser-guest.ts'

const PATH = '/browser-bridge'
const MAX_PENDING = 32
const MAX_SESSIONS = 32
const CODES = new Set<BrowserUseErrorCode>(['BROWSER_INVALID_URL', 'BROWSER_STALE_REF', 'BROWSER_CLOSED',
  'BROWSER_DENIED', 'BROWSER_UNAVAILABLE', 'BROWSER_FAILED', 'BROWSER_BUSY'])

function wireCapture(capture: BrowserCapture): { observation: BrowserCapture['observation']; png: string | null } {
  if (capture.png && capture.png.byteLength > MAX_PNG_BYTES) throw new Error('desktop browser PNG exceeds limit')
  return { observation: capture.observation, png: capture.png ? Buffer.from(capture.png).toString('base64') : null }
}

function failure(error: unknown): { code: BrowserUseErrorCode; message: string } {
  const value = error as { code?: unknown; message?: unknown }
  const code = CODES.has(value.code as BrowserUseErrorCode) ? value.code as BrowserUseErrorCode : 'BROWSER_FAILED'
  const message = typeof value.message === 'string' && value.message.length > 0
    ? value.message.slice(0, 512) : 'desktop browser operation failed'
  return { code, message }
}

/** 只在同一次 Host 连接存活时发送状态；失败使该连接和全部会话失效。 */
export interface BrowserBridge {
  readonly origin: string
  readonly token: string
  attach(manager: BrowserGuestManager): void
  publish(sessionId: string, state: BrowserSessionState | null, capture?: BrowserCapture): void
  dispose(): Promise<void>
}

/**
 * 在启动 helper 之前监听随机回环端口，令牌仅供显式传入其启动环境。
 * @returns 独占一个 Host 连接的桥；断线后不会在同一 epoch 重新授权。
 */
export async function createBrowserBridge(): Promise<BrowserBridge> {
  const token = randomBytes(32).toString('hex')
  const secret = Buffer.from(token, 'ascii')
  const server = createServer((_request, response) => { response.writeHead(404); response.end() })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_FRAME_BYTES,
    perMessageDeflate: false, clientTracking: false })
  let manager: BrowserGuestManager | undefined
  let socket: WebSocket | undefined
  let claimed = false
  let disposed = false
  let cleanup: Promise<void> | undefined
  const sessions = new Set<string>()
  const live = new Set<string>()
  const leased = new Set<string>()
  const pending = new Set<Promise<void>>()
  const pendingBySession = new Map<string, number>()
  const ids = new Set<string>()

  const revoke = (): void => {
    const current = socket
    socket = undefined
    current?.terminate()
    const owned = [...sessions]
    sessions.clear()
    live.clear()
    leased.clear()
    const owner = manager
    if (!owner) return
    // 已接纳操作可在断线后完成；清理排在它们后面，不能留下迟到的新 guest。
    if (cleanup) return
    cleanup = Promise.allSettled([...pending]).then(async () => {
      for (const sessionId of owned) {
        try { await owner.release(sessionId) } catch { /* close 仍须继续。 */ }
        try { await owner.close(sessionId) } catch { /* dispose 再兜底。 */ }
      }
    })
  }

  const publish = (sessionId: string, state: BrowserSessionState | null, capture?: BrowserCapture): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN || disposed) return
    if (state === null) live.delete(sessionId)
    else { live.add(sessionId); sessions.add(sessionId) }
    try {
      const event: BridgeStateEvent = { v: 1, type: 'state', sessionId, state,
        ...(capture ? { capture: wireCapture(capture) } : {}) }
      parseBridgeEvent(event)
      socket.send(JSON.stringify(event))
    } catch { revoke() }
  }

  server.on('upgrade', (request, connection: Socket, head) => {
    const authorization = request.headers.authorization
    const candidate = typeof authorization === 'string' && /^Bearer [a-f0-9]{64}$/u.test(authorization)
      ? Buffer.from(authorization.slice(7), 'ascii') : Buffer.alloc(secret.length)
    const authorized = candidate.length === secret.length && timingSafeEqual(candidate, secret)
    if (disposed || claimed || request.url !== PATH || connection.remoteAddress !== '127.0.0.1' ||
      request.headers.origin !== undefined || !authorized) {
      connection.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    claimed = true
    wss.handleUpgrade(request, connection, head, (client) => {
      if (disposed) { client.terminate(); return }
      socket = client
      client.on('error', revoke)
      client.on('close', revoke)
      client.on('message', (raw, binary) => {
        if (binary || pending.size >= MAX_PENDING || client !== socket) { revoke(); return }
        let requestFrame: ReturnType<typeof parseBridgeRequest>
        try {
          const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
          requestFrame = parseBridgeRequest(parseBridgeFrame(bytes))
          if (ids.has(requestFrame.id)) throw new Error('concurrent browser request id')
          ids.add(requestFrame.id)
        } catch { revoke(); return }
        const { id, method, sessionId, command, expectedTarget } = requestFrame
        if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) { revoke(); return }
        sessions.add(sessionId)
        pendingBySession.set(sessionId, (pendingBySession.get(sessionId) ?? 0) + 1)
        const task = (async () => {
          let reply: BridgeResponse
          try {
            if (!manager || client !== socket) throw new Error('desktop browser unavailable')
            const current = manager
            const value = method === 'prepare' ? await current.prepare(sessionId)
              : method === 'execute' ? wireCapture(await current.execute(sessionId,
                command as Parameters<BrowserGuestManager['execute']>[1], expectedTarget))
                : method === 'control' ? await current.control(sessionId,
                  command as Parameters<BrowserGuestManager['control']>[1])
                  : method === 'close' ? await current.close(sessionId)
                    : method === 'lease' ? await current.lease(sessionId) : await current.release(sessionId)
            reply = { v: 1, id, ok: true, value }
            parseBridgeResponse(reply, method)
            if (method === 'lease') leased.add(sessionId)
            if (method === 'release' || method === 'close') leased.delete(sessionId)
            if (method === 'close' || method === 'control' && value === null ||
              method === 'execute' && command?.kind === 'close') live.delete(sessionId)
          } catch (error) { reply = { v: 1, id, ok: false, error: failure(error) } }
          if (client === socket && client.readyState === WebSocket.OPEN) {
            try { client.send(JSON.stringify(reply)) } catch { revoke() }
          }
        })()
        pending.add(task)
        void task.finally(() => {
          pending.delete(task)
          ids.delete(id)
          const remaining = (pendingBySession.get(sessionId) ?? 1) - 1
          if (remaining > 0) pendingBySession.set(sessionId, remaining)
          else {
            pendingBySession.delete(sessionId)
            if (!live.has(sessionId) && !leased.has(sessionId)) sessions.delete(sessionId)
          }
        })
      })
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
  } catch (error) { wss.close(); throw error }
  server.on('error', revoke)
  wss.on('error', revoke)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('desktop browser bridge has no port')
  return {
    origin: `ws://127.0.0.1:${address.port}${PATH}`,
    token,
    attach(value) { if (disposed || manager) throw new Error('desktop browser bridge already attached'); manager = value },
    publish,
    async dispose() {
      if (disposed) return
      disposed = true
      revoke()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      wss.close()
      await cleanup
    },
  }
}
