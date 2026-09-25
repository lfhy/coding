/** Electron 主进程独占 Go helper 的 stdio；stdout 只承载有界的 v1 NDJSON 帧。 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const MAX_LINE_BYTES = 2 << 20
const MAX_PENDING = 16
const MAX_REQUESTS = 65_536
const STARTUP_MS = 45_000
const STOP_MS = 1_000
const METHODS = new Set([
  'RemoteSSHConnect', 'RemoteSSHListDirectories', 'RemoteSSHSelectDirectory',
  'RemoteSSHClose', 'RemoteSSHCancelConnect', 'RemoteSSHRejectHostKey', 'shutdown',
  'RemoteSSHSelectUnclaimed', 'RemoteSSHRevokeUnclaimed', 'RemoteSSHClaimSelection',
])

/** 已就绪 helper 的主进程私有句柄；不得传给 renderer。 */
export interface HelperClient {
  readonly origin: string
  /** 取消只停止等待，不证明 helper 尚未执行请求；调用方应以业务 id 核对结果。 */
  request(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  /** 订阅不含诊断文字的进度，关闭或调用 disposer 后停止通知。 */
  onProgress(listener: (progress: { attemptId: string; phase: string; message: '' }) => void): () => void
  /** 第二实例请求激活时通知；激活事件不回放给晚订阅者。 */
  onActivate(listener: () => void): () => void
  /** 关闭时通知一次；晚订阅立即收到已发生的原因，异常中不含 helper 输出。 */
  onClosed(listener: (reason: 'exited' | 'protocol' | 'closed') => void): () => void
  /** 有界终止本句柄持有的子进程；需优雅退出时调用方先有界请求 shutdown。 */
  close(): Promise<void>
}

/** 显式指定 helper 启动环境；不会读取或合并进程的环境变量。 */
export interface HelperLaunchOptions {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  dispose(): void
  cancelled: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fields(value: Record<string, unknown>, names: string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === names.length && keys.every(key => names.includes(key))
}

function wireID(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
}

function origin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value)
  return match !== null && Number(match[1]) <= 65535
}

function protocolError(): Error {
  return new Error('Invalid helper stdout protocol')
}

function stoppedError(): Error {
  return new Error('Helper exited; an outstanding request may have executed')
}

function cancelledError(): Error {
  return new Error('Helper request cancelled; it may still execute')
}

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveStop) => {
    let stage = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      clearTimeout(timer)
      child.removeListener('exit', finish)
      resolveStop()
    }
    const advance = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) { finish(); return }
      if (stage++ === 0) {
        child.kill('SIGKILL')
        timer = setTimeout(finish, STOP_MS)
      } else finish()
    }
    child.once('exit', finish)
    child.kill('SIGTERM')
    if (child.exitCode === null && child.signalCode === null) timer = setTimeout(advance, STOP_MS)
    if (child.exitCode !== null || child.signalCode !== null) finish()
  })
}

/**
 * 启动唯一的 helper 子进程，等待严格的第一帧 ready；失败或取消时有界停止该子进程。
 * @param options - helper 的可执行文件、参数、目录、显式环境和可选生命周期信号。
 * @returns 持有 stdio 的客户端；使用完必须调用 close，origin 不包含授权信息。
 */
export async function launchHelper(options: HelperLaunchOptions): Promise<HelperClient> {
  if (options.signal?.aborted) throw new Error('Helper launch cancelled')
  const child = spawn(options.executable, options.args, {
    cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  let buffer = Buffer.alloc(0)
  let ready = false
  let closed = false
  let announcedOrigin = ''
  let requestCount = 0
  let closePromise: Promise<void> | undefined
  let closeReason: 'exited' | 'protocol' | 'closed' | undefined
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const pending = new Map<string, Pending>()
  const seen = new Set<string>()
  const listeners = new Set<(progress: { attemptId: string; phase: string; message: '' }) => void>()
  const activateListeners = new Set<() => void>()
  const closeListeners = new Set<(reason: 'exited' | 'protocol' | 'closed') => void>()
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const startup = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const timer = setTimeout(() => { void fail(new Error('Helper readiness timed out')) }, STARTUP_MS)

  function fail(error: Error, reason: 'exited' | 'protocol' | 'closed' = 'exited'): Promise<void> {
    if (closed) return closePromise ?? Promise.resolve()
    closed = true
    closeReason = reason
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    rejectReady(error)
    for (const entry of pending.values()) {
      entry.dispose()
      entry.reject(error)
    }
    pending.clear()
    listeners.clear()
    activateListeners.clear()
    closePromise = stopChild(child)
    for (const listener of closeListeners) {
      try { listener(reason) } catch { /* 观察者异常不能改变子进程清理。 */ }
    }
    closeListeners.clear()
    return closePromise
  }

  function frame(value: unknown): void {
    if (!record(value) || value.protocol !== 1) throw protocolError()
    if (!ready) {
      if (!fields(value, ['type', 'protocol', 'origin']) || value.type !== 'ready' || !origin(value.origin)) throw protocolError()
      announcedOrigin = value.origin
      ready = true
      clearTimeout(timer)
      resolveReady()
      return
    }
    if (value.type === 'response') {
      const valid = value.ok === true
        ? fields(value, ['type', 'protocol', 'id', 'ok', 'value'])
        : fields(value, ['type', 'protocol', 'id', 'ok', 'error']) && value.ok === false
          && record(value.error) && fields(value.error, ['code', 'message'])
          && wireID(value.error.code) && typeof value.error.message === 'string'
      if (!valid || !wireID(value.id)) throw protocolError()
      const entry = pending.get(value.id)
      if (!entry || !seen.has(value.id)) throw protocolError()
      pending.delete(value.id)
      entry.dispose()
      if (!entry.cancelled) {
        if (value.ok === true) entry.resolve(value.value)
        else entry.reject(new Error(`Helper request failed (${(value.error as { code: string }).code})`))
      }
      return
    }
    if (value.type === 'event') {
      if (!fields(value, ['type', 'protocol', 'name', 'payload']) || !record(value.payload)) throw protocolError()
      if (value.name === 'coding:activate') {
        if (!fields(value.payload, [])) throw protocolError()
        for (const listener of activateListeners) {
          try { listener() } catch { /* 窗口处理异常不能破坏 stdio 排空。 */ }
        }
        return
      }
      if (value.name !== 'coding:remote-ssh-progress' || !fields(value.payload, ['attemptId', 'phase', 'message'])
        || !wireID(value.payload.attemptId) || !wireID(value.payload.phase) || value.payload.message !== '') throw protocolError()
      const progress = value.payload as { attemptId: string; phase: string; message: '' }
      for (const listener of listeners) {
        try { listener(progress) } catch { /* 消费方异常不能破坏 stdio 排空。 */ }
      }
      return
    }
    throw protocolError()
  }

  child.stdout.on('data', (chunk: Buffer) => {
    if (closed) return
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start)
      const end = newline === -1 ? chunk.length : newline + 1
      const part = chunk.subarray(start, end)
      if (buffer.length + part.length > MAX_LINE_BYTES) { void fail(protocolError(), 'protocol'); return }
      buffer = Buffer.concat([buffer, part])
      if (newline === -1) return
      try {
        frame(JSON.parse(decoder.decode(buffer.subarray(0, -1))) as unknown)
      } catch { void fail(protocolError(), 'protocol'); return }
      buffer = Buffer.alloc(0)
      start = end
    }
  })
  child.stdout.on('end', () => { void fail(stoppedError()) })
  child.stdout.on('error', () => { void fail(stoppedError()) })
  child.stdin.on('error', () => { void fail(stoppedError()) })
  child.on('error', () => { void fail(stoppedError()) })
  child.on('exit', () => { void fail(stoppedError()) })
  // stderr 必须被排空，但内容绝不进入日志或异常（其中可能含凭据）。
  child.stderr.on('data', () => {})
  child.stderr.on('error', () => { void fail(stoppedError()) })
  options.signal?.addEventListener('abort', onAbort, { once: true })
  function onAbort(): void { void fail(ready ? stoppedError() : new Error('Helper launch cancelled'), 'closed') }
  if (options.signal?.aborted) onAbort()

  const client: HelperClient = {
    get origin() { return announcedOrigin },
    request(method, payload, signal) {
      if (closed) return Promise.reject(stoppedError())
      if (!METHODS.has(method)) return Promise.reject(new Error('Unsupported helper method'))
      if (signal?.aborted) return Promise.reject(cancelledError())
      if (pending.size >= MAX_PENDING || requestCount >= MAX_REQUESTS) return Promise.reject(new Error('Helper request capacity exhausted'))
      let body: string
      const id = randomUUID()
      try {
        if (payload === null) throw new Error('Invalid helper request payload')
        body = JSON.stringify({ type: 'request', protocol: 1, id, method, payload }) + '\n'
        if (Buffer.byteLength(body) > MAX_LINE_BYTES || !Object.hasOwn(JSON.parse(body) as object, 'payload')) {
          throw new Error('Invalid helper request payload')
        }
      } catch { return Promise.reject(new Error('Invalid helper request payload')) }
      requestCount++
      seen.add(id)
      return new Promise<unknown>((resolve, reject) => {
        const cancel = (): void => {
          const entry = pending.get(id)
          if (!entry || entry.cancelled) return
          entry.cancelled = true
          entry.dispose()
          reject(cancelledError())
        }
        const entry: Pending = { resolve, reject, dispose: () => signal?.removeEventListener('abort', cancel), cancelled: false }
        pending.set(id, entry)
        signal?.addEventListener('abort', cancel, { once: true })
        if (signal?.aborted) { cancel(); return }
        child.stdin.write(body, (error) => { if (error) void fail(stoppedError()) })
      })
    },
    onProgress(listener) {
      if (!closed) listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onActivate(listener) {
      if (!closed) activateListeners.add(listener)
      return () => { activateListeners.delete(listener) }
    },
    onClosed(listener) {
      if (closeReason !== undefined) {
        try { listener(closeReason) } catch { /* 晚订阅者异常不影响已完成的清理。 */ }
        return () => {}
      }
      closeListeners.add(listener)
      return () => { closeListeners.delete(listener) }
    },
    close() {
      if (closePromise) return closePromise
      return fail(stoppedError(), 'closed')
    },
  }
  try {
    await startup
    return client
  } catch (error) {
    await client.close()
    throw error
  }
}
