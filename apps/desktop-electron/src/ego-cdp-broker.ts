/**
 * 桌面端 Agent 页面的虚拟 CDP 端点：ego 运行时通过它驱动由 Electron 承载的网页。
 *
 * ego-lite 的 heredoc 运行时只需要一个浏览器级 WebSocket；Electron 的 CDP 恰好缺少
 * `Target.createTarget` 与 `Target.createBrowserContext`（实测 44/Chrome 152 分别返回
 * Not supported 与 Failed to create browser context），而它依赖两者建立页面与任务空间。
 * 因此这里接管浏览器级的三个建造能力，其余方法按 CDP session 转发到页面自己。
 *
 * 目标 id 由本模块铸造，不与 Chromium 的目标 id 对应：ego 只把它当不透明标识使用，
 * 这样就不必为了对齐 id 而把整个应用的调试端口暴露给本机其它进程。
 *
 * 入口只收本机回环连接，凭据放在路径里（WebSocket 客户端由第三方运行时创建，
 * 无法附加请求头），每个桌面会话重新生成。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import type { EgoDownloadEvent, EgoDownloadSettings } from './ego-page-host.ts'

/** 单条 CDP 连接的对外能力：处理消息、断开，以及转发下载事件。 */
interface Connection {
  handle(text: string): void
  dispose(): void
  notify(event: EgoDownloadEvent): void
}

/** 页面宿主：由 Electron 侧实现，负责真正创建与关闭网页。 */
export interface EgoHostedPage {
  /** 本模块铸造的不透明标识，ego 用它引用这一页。 */
  readonly targetId: string
  /** 该页所在的任务空间上下文。 */
  readonly contextId: string
  /** 在页面自己的调试会话上执行一条 CDP 命令。 */
  send(method: string, params: Record<string, unknown>): Promise<unknown>
  /** 订阅页面事件；返回取消订阅函数。 */
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void
  /** 关闭页面；之后同一 targetId 不再出现在目标目录里。 */
  close(): void
  describe(): { url: string; title: string }
}

/** 页面集合；上下文与页面的生命周期由实现者持有。 */
export interface EgoPageHost {
  list(): EgoHostedPage[]
  find(targetId: string): EgoHostedPage | undefined
  /** 建立一个任务空间上下文。 */
  createContext(): string
  /** 关闭上下文内全部页面；未知上下文忽略。 */
  disposeContext(contextId: string): void
  /**
   * 在指定上下文里新建页面并开始加载。
   * @param contextId 必须是 createContext 返回过的上下文。
   * @param url 已经过协议层校验的地址。
   */
  createPage(contextId: string, url: string): Promise<EgoHostedPage>
  /** 未显式指定上下文时使用的共享上下文。 */
  defaultContext(): string
  /** 读取上下文（缺省为默认上下文）的 Cookie，返回 CDP 形状的记录。 */
  getCookies(contextId: string | undefined): Promise<Record<string, unknown>[]>
  /** 把 CDP 形状的 Cookie 写入上下文；无效项跳过而不整体失败。 */
  setCookies(contextId: string, cookies: Record<string, unknown>[]): Promise<void>
  /** 记录某个上下文的下载决定；ego 用它把下载落到它自己的临时目录。 */
  setDownloadBehavior(contextId: string | undefined, settings: EgoDownloadSettings): void
  /** 订阅下载开始与进度，broker 负责翻译成 CDP 事件。 */
  onDownload(listener: (event: EgoDownloadEvent) => void): () => void
}

/** 运行中的端点；`url` 才是交给 ego 的 `EGO_LINUX_CDP_URL`。 */
export interface EgoCdpBroker {
  readonly url: string
  close(): Promise<void>
}

const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
const MAX_PAGES = 32
const MAX_SESSIONS = 64
const MAX_COOKIES = 512
const SEND_TIMEOUT_MS = 30_000
/** CDP 协议错误码：参数错误、方法不存在、执行失败。 */
const INVALID_PARAMS = -32602
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32000

/** 一条从运行时发来的 CDP 命令。 */
interface Command {
  id: number
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 协议错误只带可读原因，不把页面内容或堆栈交给运行时。 */
class CdpError extends Error {
  readonly code: number
  constructor(code: number, message: string) { super(message); this.code = code }
}

function parseCommand(raw: string): Command {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new CdpError(INVALID_PARAMS, 'invalid CDP message') }
  if (!record(value)) throw new CdpError(INVALID_PARAMS, 'invalid CDP message')
  const { id, method, params, sessionId } = value
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) throw new CdpError(INVALID_PARAMS, 'invalid command id')
  if (typeof method !== 'string' || method.length === 0 || method.length > 128) throw new CdpError(INVALID_PARAMS, 'invalid command method')
  if (params !== undefined && !record(params)) throw new CdpError(INVALID_PARAMS, 'invalid command params')
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128)) {
    throw new CdpError(INVALID_PARAMS, 'invalid session id')
  }
  return { id, method, params: params ?? {}, ...sessionId === undefined ? {} : { sessionId } }
}

/** 只接受网页可以安全加载的地址；其余协议在执行前拒绝。 */
function pageUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) throw new CdpError(INVALID_PARAMS, 'invalid target url')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new CdpError(INVALID_PARAMS, 'invalid target url') }
  if (!['http:', 'https:', 'file:', 'about:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') {
    throw new CdpError(INVALID_PARAMS, 'unsupported target url')
  }
  return value
}

/** 下载决定只接受 CDP 定义的三个取值。 */
function downloadBehavior(value: unknown): 'allow' | 'deny' | 'default' {
  if (value === 'deny' || value === 'default') return value
  return 'allow'
}

/** 下载目录只接受本机绝对路径语义的字符串，长度有界。 */
function downloadPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : undefined
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new CdpError(INVALID_PARAMS, `invalid ${key}`)
  }
  return value
}

/** 单条连接的 CDP 会话表：命令路由、上下文映射与页面事件回传。 */
function createConnection(host: EgoPageHost, send: (text: string) => void, close: () => void) {
  /** CDP sessionId → 页面及其事件退订函数。 */
  const sessions = new Map<string, { page: EgoHostedPage; unsubscribe: () => void }>()
  /** 上下文是否由本连接创建；ego 只在同一进程里用 createBrowserContext 的返回值。 */
  const contexts = new Set<string>()
  let disposed = false

  const emitEvent = (sessionId: string, method: string, params: Record<string, unknown>): void => {
    if (disposed) return
    try { send(JSON.stringify({ method, params, sessionId })) } catch { dispose() }
  }

  const bind = (page: EgoHostedPage): string => {
    if (sessions.size >= MAX_SESSIONS) throw new CdpError(INTERNAL_ERROR, 'too many CDP sessions')
    const sessionId = randomBytes(16).toString('hex')
    const unsubscribe = page.onEvent((method, params) => { emitEvent(sessionId, method, params) })
    sessions.set(sessionId, { page, unsubscribe })
    return sessionId
  }

  const unbind = (sessionId: string): boolean => {
    const entry = sessions.get(sessionId)
    if (!entry) return false
    entry.unsubscribe()
    sessions.delete(sessionId)
    return true
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    for (const [sessionId] of sessions) unbind(sessionId)
    contexts.clear()
    close()
  }

  /** 浏览级方法：Electron 没有对应实现，由本端点合成。 */
  async function browserMethod(command: Command): Promise<unknown> {
    const { method, params } = command
    switch (method) {
      case 'Target.getTargets':
        return {
          targetInfos: host.list().map((page) => {
            const info = page.describe()
            return {
              targetId: page.targetId, type: 'page', title: info.title, url: info.url,
              attached: [...sessions.values()].some(entry => entry.page === page),
              browserContextId: page.contextId,
            }
          }),
        }
      case 'Target.createBrowserContext': {
        if (host.list().length >= MAX_PAGES) throw new CdpError(INTERNAL_ERROR, 'page limit reached')
        const contextId = host.createContext()
        contexts.add(contextId)
        return { browserContextId: contextId }
      }
      case 'Target.disposeBrowserContext': {
        const contextId = requiredString(params, 'browserContextId')
        // 未在本连接创建过的上下文同样允许释放：重建页面后上下文可能来自上一进程。
        host.disposeContext(contextId)
        contexts.delete(contextId)
        return {}
      }
      case 'Target.createTarget': {
        const url = pageUrl(params.url)
        if (host.list().length >= MAX_PAGES) throw new CdpError(INTERNAL_ERROR, 'page limit reached')
        const requested = params.browserContextId
        let contextId = host.defaultContext()
        if (requested !== undefined) {
          if (typeof requested !== 'string' || requested.length === 0 || requested.length > 256) {
            throw new CdpError(INVALID_PARAMS, 'invalid browserContextId')
          }
          contextId = requested
        }
        const page = await host.createPage(contextId, url)
        return { targetId: page.targetId }
      }
      case 'Target.attachToTarget': {
        const page = host.find(requiredString(params, 'targetId'))
        if (!page) throw new CdpError(INVALID_PARAMS, 'no such target')
        if (params.flatten !== true) throw new CdpError(INVALID_PARAMS, 'flatten is required')
        return { sessionId: bind(page) }
      }
      case 'Target.detachFromTarget': {
        if (typeof params.sessionId === 'string') { unbind(params.sessionId); return {} }
        const page = host.find(requiredString(params, 'targetId'))
        for (const [sessionId, entry] of sessions) { if (entry.page === page) unbind(sessionId) }
        return {}
      }
      case 'Target.closeTarget': {
        const page = host.find(requiredString(params, 'targetId'))
        if (!page) throw new CdpError(INVALID_PARAMS, 'no such target')
        for (const [sessionId, entry] of sessions) { if (entry.page === page) unbind(sessionId) }
        page.close()
        return { success: true }
      }
      case 'Target.activateTarget':
        if (!host.find(requiredString(params, 'targetId'))) throw new CdpError(INVALID_PARAMS, 'no such target')
        // 呈现由工作台标签决定，激活只作为命令被接受。
        return {}
      case 'Target.getTargetInfo': {
        const page = host.find(requiredString(params, 'targetId'))
        if (!page) throw new CdpError(INVALID_PARAMS, 'no such target')
        const info = page.describe()
        return { targetInfo: { targetId: page.targetId, type: 'page', title: info.title, url: info.url,
          attached: true, browserContextId: page.contextId } }
      }
      case 'Target.setDiscoverTargets':
      case 'Target.setAutoAttach':
        // 页面目录按需读取；不实现自动发现事件。
        return {}
      case 'Browser.setDownloadBehavior': {
        const behavior = downloadBehavior(params.behavior)
        const path = downloadPath(params.downloadPath)
        host.setDownloadBehavior(
          typeof params.browserContextId === 'string' ? params.browserContextId : undefined,
          { behavior, ...path === undefined ? {} : { downloadPath: path } })
        return {}
      }
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: 'Coding/Electron', revision: '', userAgent: '',
          jsVersion: process.versions.v8 }
      case 'Browser.getWindowForTarget':
        // 桌面页面嵌在工作台里，没有独立的浏览器窗口可调尺寸。
        return { windowId: 1, bounds: { left: 0, top: 0, width: 0, height: 0, windowState: 'normal' } }
      case 'Browser.setWindowBounds':
        return {}
      case 'Storage.getCookies':
        return { cookies: await host.getCookies(
          typeof params.browserContextId === 'string' ? params.browserContextId : undefined) }
      case 'Storage.setCookies': {
        const cookies = params.cookies
        if (!Array.isArray(cookies) || cookies.length > MAX_COOKIES) throw new CdpError(INVALID_PARAMS, 'invalid cookies')
        const contextId = typeof params.browserContextId === 'string' ? params.browserContextId : host.defaultContext()
        await host.setCookies(contextId, cookies.filter(record))
        return {}
      }
      default:
        throw new CdpError(METHOD_NOT_FOUND, `unsupported browser method ${method}`)
    }
  }

  /** 页面方法：必须带本连接建立过的 sessionId。 */
  async function sessionMethod(command: Command): Promise<unknown> {
    const entry = command.sessionId === undefined ? undefined : sessions.get(command.sessionId)
    if (!entry) throw new CdpError(INVALID_PARAMS, 'unknown session id')
    // 旧版回退路径：页面级下载设置没有 browserContextId，用该页面的上下文代替。
    if (command.method === 'Page.setDownloadBehavior') {
      const behavior = downloadBehavior(command.params.behavior)
      const path = downloadPath(command.params.downloadPath)
      host.setDownloadBehavior(entry.page.contextId, { behavior, ...path === undefined ? {} : { downloadPath: path } })
      return {}
    }
    return withTimeout(entry.page.send(command.method, command.params))
  }

  async function handle(text: string): Promise<void> {
    let command: Command
    try { command = parseCommand(text) } catch (error) {
      const failure = error as CdpError
      send(JSON.stringify({ id: 0, error: { code: failure.code, message: failure.message } }))
      dispose()
      return
    }
    try {
      const result = command.sessionId === undefined
        ? await browserMethod(command)
        : await sessionMethod(command)
      if (disposed) return
      send(JSON.stringify({ id: command.id, result, ...command.sessionId === undefined ? {} : { sessionId: command.sessionId } }))
    } catch (error) {
      const failure = error as { code?: unknown; message?: unknown }
      const code = typeof failure.code === 'number' ? failure.code : INTERNAL_ERROR
      const message = typeof failure.message === 'string' && failure.message.length > 0
        ? failure.message.slice(0, 512) : 'page command failed'
      if (disposed) return
      send(JSON.stringify({ id: command.id, error: { code, message },
        ...command.sessionId === undefined ? {} : { sessionId: command.sessionId } }))
    }
  }

  /** 把宿主下载事件翻译成页面事件；只发给在该上下文里有页面的连接。 */
  const notify = (event: EgoDownloadEvent): void => {
    if (disposed) return
    const record = event.record
    if (![...sessions.values()].some(entry => entry.page.contextId === record.contextId)) return
    if (event.kind === 'begin') {
      send(JSON.stringify({ method: 'Page.downloadWillBegin', params: {
        frameId: record.id, guid: record.id, url: record.url, suggestedFilename: record.filename,
      } }))
      return
    }
    send(JSON.stringify({ method: 'Page.downloadProgress', params: {
      guid: record.id, totalBytes: record.totalBytes, receivedBytes: record.receivedBytes,
      state: record.state === 'progressing' ? 'inProgress' : record.state,
    } }))
  }

  return { handle, dispose, notify }
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new CdpError(INTERNAL_ERROR, 'page command timed out')) }, SEND_TIMEOUT_MS)
      }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

/**
 * 启动回环端点；每个 `ego-browser nodejs` 进程各自建立一条连接。
 * @param host 页面宿主实现。
 * @returns 端点地址与关闭函数；关闭会断开所有连接。
 */
export async function createEgoCdpBroker(host: EgoPageHost): Promise<EgoCdpBroker> {
  const token = randomBytes(32).toString('hex')
  const secret = Buffer.from(`/${token}`, 'ascii')
  const connections = new Set<Connection>()
  const server = createServer((_request, response) => { response.writeHead(404); response.end() })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false, clientTracking: false })
  let closing = false

  // 下载由页面触发，可能不属于某一条连接；宿主事件统一广播给相关连接。
  const unsubscribeDownloads = host.onDownload((event) => {
    for (const session of [...connections]) session.notify(event)
  })

  const reject = (connection: Socket): void => {
    connection.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  }

  server.on('upgrade', (request, connection: Socket, head) => {
    const path = Buffer.from(request.url ?? '', 'utf8')
    const authorized = path.length === secret.length && timingSafeEqual(path, secret)
    if (closing || !authorized || connection.remoteAddress !== '127.0.0.1' ||
      request.headers.origin !== undefined) { reject(connection); return }
    wss.handleUpgrade(request, connection, head, (client) => {
      if (closing) { client.terminate(); return }
      const session = createConnection(host, (text) => {
        if (client.readyState === WebSocket.OPEN) client.send(text)
      }, () => { connections.delete(session); client.close() })
      connections.add(session)
      client.on('error', () => { session.dispose() })
      client.on('close', () => { session.dispose() })
      client.on('message', (raw, binary) => {
        if (binary) { session.dispose(); return }
        const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
        session.handle(bytes.toString('utf8')).catch(() => { session.dispose() })
      })
    })
  })

  try {
    await new Promise<void>((resolve, reject_) => {
      server.once('error', reject_)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject_); resolve() })
    })
  } catch (error) { wss.close(); throw error }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('ego CDP broker has no port')

  return {
    url: `ws://127.0.0.1:${address.port}/${token}`,
    async close() {
      if (closing) return
      closing = true
      unsubscribeDownloads()
      for (const session of [...connections]) session.dispose()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      wss.close()
    },
  }
}
