/** 通过 Go agent 终端协议实现的 Remote-SSH PTY 句柄。 */

import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type {
  RemoteWorkspaceTarget,
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { callRemoteWorkspaceBridge, RemoteWorkspaceError, verifyRemoteWorkspaceTarget } from '@deepseek-ai/dsh-subprocess'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { validateTerminalSize } from './terminal-size.ts'

const TERMINAL_READ_WAIT_MS = 25_000
const TERMINAL_READ_CHUNK_MAX = 64 * 1024
/** 普通终端 RPC 的传输上限；终端关闭会更早地中止它们。 */
const TERMINAL_OPERATION_TIMEOUT_MS = 30_000
const TERMINAL_OPERATION_TIMEOUT = 'REMOTE_TERMINAL_OPERATION_TIMEOUT'
/** start 响应与孤儿回收都必须有自己的 deadline，不能继承 caller 的 abort。 */
const TERMINAL_START_TIMEOUT_MS = 30_000
const TERMINAL_START_TIMEOUT = 'REMOTE_TERMINAL_START_TIMEOUT'

interface StartResponse { id: string; pid: number }
interface StartRequest {
  path: string
  argv: string[]
  env: NodeJS.ProcessEnv
  rows: number
  cols: number
  graceMs: number
  startNonce: string
}
interface OutputChunk { sequence: number; dataBase64: string }
interface ReadResponse {
  chunks: OutputChunk[]
  cursor: number
  closed: boolean
  truncated: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
}

const SIGNALS = new Set<NodeJS.Signals>([
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGIO',
  'SIGKILL', 'SIGPIPE', 'SIGPROF', 'SIGQUIT', 'SIGSEGV', 'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP',
  'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ',
])

function record(value: unknown, message = 'remote terminal returned an invalid response'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

/** 成功响应采用封闭字段集，避免 agent 升级时悄然把未验证的数据带入 Host。 */
function closedRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const source = record(value)
  if (Object.keys(source).some(key => !fields.includes(key))) {
    throw new Error('remote terminal returned an invalid response')
  }
  return source
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) throw new Error(`remote terminal response has an invalid ${key}`)
  return field
}

function integerField(value: Record<string, unknown>, key: string, minimum = 0): number {
  const field = value[key]
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < minimum) {
    throw new Error(`remote terminal response has an invalid ${key}`)
  }
  return field
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key]
  if (typeof field !== 'boolean') throw new Error(`remote terminal response has an invalid ${key}`)
  return field
}

function nullableExitCode(value: Record<string, unknown>, key: string): number | null {
  if (value[key] === undefined || value[key] === null) return null
  return integerField(value, key)
}

function nullableSignal(value: Record<string, unknown>, key: string): NodeJS.Signals | null {
  const field = value[key]
  if (field === undefined || field === null || field === '') return null
  if (typeof field !== 'string' || !SIGNALS.has(field as NodeJS.Signals)) {
    throw new Error(`remote terminal response has an invalid ${key}`)
  }
  return field as NodeJS.Signals
}

function parseStart(value: unknown): StartResponse {
  const source = closedRecord(value, ['id', 'pid'])
  return { id: stringField(source, 'id'), pid: integerField(source, 'pid', 1) }
}

function parseAccepted(value: unknown): void {
  if (closedRecord(value, ['accepted']).accepted !== true) throw new Error('remote terminal response was not accepted')
}

function parseBase64(value: unknown, key: string, maxBytes: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`remote terminal response has an invalid ${key}`)
  }
  const data = Buffer.from(value, 'base64')
  if (data.toString('base64') !== value) throw new Error(`remote terminal response has an invalid ${key}`)
  if (data.byteLength > maxBytes) throw new Error(`remote terminal response has an oversized ${key}`)
  return data
}

function parseRead(value: unknown): ReadResponse {
  // Go 在进程尚未退出或未受信号终止时会省略后两个可选字段。
  const source = closedRecord(value, ['chunks', 'cursor', 'closed', 'truncated', 'exitCode', 'signal'])
  if (!Array.isArray(source.chunks)) throw new Error('remote terminal response has an invalid chunks')
  const chunks: OutputChunk[] = []
  for (const raw of source.chunks) {
    const chunk = closedRecord(raw, ['sequence', 'dataBase64'])
    const sequence = integerField(chunk, 'sequence', 1)
    const dataBase64 = stringField(chunk, 'dataBase64')
    // 此处验证编码后的字节上限；Consumer 会在序列验证后再次解码，畸形数据
    // 不会进入输出流。
    parseBase64(dataBase64, 'dataBase64', TERMINAL_READ_CHUNK_MAX)
    chunks.push({ sequence, dataBase64 })
  }
  return {
    chunks,
    cursor: integerField(source, 'cursor', 0),
    closed: booleanField(source, 'closed'),
    truncated: booleanField(source, 'truncated'),
    exitCode: nullableExitCode(source, 'exitCode'),
    signal: nullableSignal(source, 'signal'),
  }
}

function parseForeground(value: unknown): SubprocessTerminalForeground {
  const source = closedRecord(value, ['processGroupId', 'inputWaiting'])
  return {
    processGroupId: integerField(source, 'processGroupId', 1),
    inputWaiting: booleanField(source, 'inputWaiting'),
  }
}

function parseSignal(value: unknown): number {
  return integerField(closedRecord(value, ['processGroupId']), 'processGroupId', 1)
}

/** 每个分配尝试的幂等键；Go agent 仅接受恰好 16 个随机字节的 lowercase hex。 */
function terminalStartNonce(): string { return randomBytes(16).toString('hex') }

/**
 * 首次 start 已派发却没有得到可信响应时，只有这些失败仍可能留下远端 PTY。
 * 明确的业务拒绝（包括 nonce 与不同请求冲突）不会进入补偿重试。
 */
function needsTerminalStartRecovery(error: unknown, definitiveDeadlineElapsed: boolean): boolean {
  if (!(error instanceof RemoteWorkspaceError)) return false
  if (error.code === 'REMOTE_BRIDGE_UNAVAILABLE' || error.code === 'REMOTE_BRIDGE_RESPONSE_INVALID') return true
  if (error.code === 'REMOTE_BRIDGE_ABORTED') return definitiveDeadlineElapsed
  return error.code === 'REMOTE_BRIDGE_REJECTED'
    && (error.bridgeCode === 'bridge-unavailable' || error.bridgeCode === 'invalid-agent-response')
}

/** marker 重绑提交后，bridge 对旧 generation 的明确拒绝。 */
function isStaleMarkerRejection(error: unknown): boolean {
  return error instanceof RemoteWorkspaceError
    && error.code === 'REMOTE_BRIDGE_REJECTED'
    && error.bridgeCode === 'stale-marker'
}

/**
 * 以同一 nonce 重放 start 只能取得首个已发布 PTY，随后再以当前 marker 终止它。
 * 这里故意不使用首次连接的 owner：分配尚未交给调用方时，marker 重绑必须
 * fail-closed，即使这会把无法证明归属的远端会话交给 retention 回收。
 */
async function reclaimUncertainTerminalStart(target: RemoteWorkspaceTarget, request: StartRequest): Promise<void> {
  let started: StartResponse
  try {
    using lookup = deadline(undefined, TERMINAL_START_TIMEOUT_MS, TERMINAL_START_TIMEOUT)
    const current = await verifyRemoteWorkspaceTarget(target, lookup.signal)
    started = await callRemoteWorkspaceBridge(
      current, '/v1/terminals/start', 'POST', request, parseStart, lookup.signal, true, lookup.signal,
    )
  } catch {
    return
  }
  try {
    using cleanup = deadline(undefined, TERMINAL_START_TIMEOUT_MS, TERMINAL_START_TIMEOUT)
    // 重放 start 与 terminate 之间 marker 仍可能切换；不能借旧 target 终止一个
    // 已被重绑连接上的未知 id。
    const current = await verifyRemoteWorkspaceTarget(target, cleanup.signal)
    await callRemoteWorkspaceBridge(
      current, '/v1/terminals/terminate', 'POST', { id: started.id }, parseAccepted,
      cleanup.signal, true, cleanup.signal,
    )
  } catch {
    // 原始 start 失败仍是调用方可见事实；补偿只能尽力，不能覆盖该诊断。
  }
}

/** PTY 与进程会话都位于远端 Go agent 的终端句柄。 */
export class RemoteTerminalHandle implements SubprocessTerminalHandle {
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>

  private readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  private readonly pollAbort = new AbortController()
  /** 终止与自然退出都会中止尚未返回的普通控制 RPC。 */
  private readonly operationAbort = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private cursor = 0
  private lossy = false
  private closed = false
  private stopping = false
  private cleanup: Promise<void> | undefined
  /** 分配成功时捕获的连接身份，仅在 marker 失效后的补偿清理中使用。 */
  private readonly ownerTarget: RemoteWorkspaceTarget

  constructor(
    private readonly target: RemoteWorkspaceTarget,
    readonly id: string,
    readonly pid: number,
  ) {
    this.ownerTarget = { ...target }
    this.done = this.outcome.promise
    void this.readLoop()
  }

  /** 异步远端操作返回后重新读取终端的实时可用状态。 */
  private isUnavailable(): boolean { return this.closed || this.stopping }

  /** 远端清理期间仅以读取循环已经结算的终态为准。 */
  private isClosed(): boolean { return this.closed }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation))
    return operation
  }

  /** 终止在封住新操作后等待所有已进入普通 RPC 的调用结算。 */
  private async drainOperations(): Promise<void> {
    while (this.operations.size > 0) {
      await Promise.allSettled([...this.operations])
    }
  }

  /**
   * 普通读写、resize 与前台控制必须复验当前 marker，并受句柄关闭和单次 RPC 上限约束。
   * 清理路径不调用此方法，因为它在 marker 失效时需要使用已发布 owner 收回 PTY。
   */
  private async normalOperation<T>(request: (target: RemoteWorkspaceTarget, signal: AbortSignal) => Promise<T>): Promise<T> {
    using operation = deadline(this.operationAbort.signal, TERMINAL_OPERATION_TIMEOUT_MS, TERMINAL_OPERATION_TIMEOUT)
    const target = await verifyRemoteWorkspaceTarget(this.target, operation.signal)
    operation.signal.throwIfAborted()
    return await request(target, operation.signal)
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.closed) {
        using operation = deadline(this.pollAbort.signal, TERMINAL_OPERATION_TIMEOUT_MS, TERMINAL_OPERATION_TIMEOUT)
        const target = await verifyRemoteWorkspaceTarget(this.target, operation.signal)
        const response = await callRemoteWorkspaceBridge(target, '/v1/terminals/read', 'POST', {
          id: this.id, after: this.cursor, waitMs: TERMINAL_READ_WAIT_MS,
        }, parseRead, operation.signal)
        this.consume(response)
      }
    } catch (error: unknown) {
      if (!this.stopping && !this.closed) this.fail(error)
    }
  }

  private consume(response: ReadResponse): void {
    let previous = this.cursor
    for (const chunk of response.chunks) {
      if (chunk.sequence <= previous) throw new Error('remote terminal output sequence moved backwards')
      if (chunk.sequence > previous + 1) this.lossy = true
      const data = parseBase64(chunk.dataBase64, 'dataBase64', TERMINAL_READ_CHUNK_MAX)
      if (data.byteLength > 0) this.output.write(data)
      previous = chunk.sequence
    }
    if (response.cursor < this.cursor || response.cursor < previous) {
      throw new Error('remote terminal cursor moved backwards')
    }
    if (response.cursor > previous) this.lossy = true
    if (response.truncated) this.lossy = true
    this.cursor = response.cursor
    if (response.closed) this.finish({ exitCode: response.exitCode, signal: response.signal })
  }

  private finish(outcome: SubprocessOutcome): void {
    if (this.closed) return
    this.closed = true
    this.pollAbort.abort()
    this.operationAbort.abort('remote terminal process exited')
    this.output.end()
    if (this.lossy) {
      this.outcome.reject(new Error('remote terminal output was truncated before delivery'))
    } else {
      this.outcome.resolve(outcome)
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return
    this.closed = true
    this.pollAbort.abort()
    this.operationAbort.abort('remote terminal failed')
    const reason = error instanceof Error ? error : new Error(String(error))
    this.output.destroy(reason)
    this.outcome.reject(reason)
  }

  async write(data: string): Promise<void> {
    if (this.closed || this.stopping) throw new Error('remote terminal process has exited')
    const operation = this.normalOperation((target, signal) => callRemoteWorkspaceBridge(
      target,
      '/v1/terminals/write',
      'POST',
      { id: this.id, dataBase64: Buffer.from(data, 'utf8').toString('base64') },
      parseAccepted,
      signal,
    ))
    await this.track(operation)
  }

  resize(cols: number, rows: number): Promise<void> {
    if (this.isUnavailable()) return Promise.reject(new Error('remote terminal process has exited'))
    const operation = Promise.resolve().then(() => {
      validateTerminalSize(cols, rows)
      return this.normalOperation((target, signal) => callRemoteWorkspaceBridge(
        target,
        '/v1/terminals/resize',
        'POST',
        { id: this.id, cols, rows },
        parseAccepted,
        signal,
      ))
    })
    return this.track(operation)
  }

  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    if (this.isUnavailable()) return undefined
    try {
      const operation = this.normalOperation((target, signal) => callRemoteWorkspaceBridge(
        target,
        '/v1/terminals/foreground',
        'POST',
        { id: this.id },
        parseForeground,
        signal,
      ))
      return await this.track(operation)
    } catch (error: unknown) {
      if (this.isUnavailable()) return undefined
      throw error
    }
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    if (this.closed || this.stopping) throw new Error('remote terminal process has exited')
    const operation = this.normalOperation((target, operationSignal) => callRemoteWorkspaceBridge(
      target,
      '/v1/terminals/signal',
      'POST',
      { id: this.id, signal },
      parseSignal,
      operationSignal,
    ))
    return await this.track(operation)
  }

  async terminate(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    this.stopping = true
    this.pollAbort.abort()
    // 不先等待普通 RPC：它们都接收这个信号，故对已发布 PTY 的终止请求可立即
    // 发出；终止请求完成后仍会排空这些调用，确保 terminate 结算时没有遗留操作。
    this.operationAbort.abort('remote terminal termination requested')
    const cleanup = this.closeRemote()
    this.cleanup = cleanup
    try {
      await cleanup
    } catch (error) {
      this.cleanup = undefined
      // 清理传输失效时必须结算句柄；否则 provider dispose 会永久等待 done。
      this.fail(error)
      throw error
    }
  }

  /** Node Host 同步退出时使用已发布会话的连接身份尽力终止。 */
  terminateForHostExit(): void {
    this.stopping = true
    this.pollAbort.abort()
    this.operationAbort.abort('remote terminal host exited')
    void callRemoteWorkspaceBridge(this.ownerTarget, '/v1/terminals/terminate', 'POST', { id: this.id }, parseAccepted, undefined, true, undefined, true).catch(() => {})
  }

  /**
   * 返回当前 marker 身份；marker 已失效时仅退回到启动时的 owner，以便清理
   * 已发布的远端 PTY。普通控制操作绝不能调用此回退。
   */
  private async targetForCleanup(signal?: AbortSignal): Promise<{ target: RemoteWorkspaceTarget; retiredCleanup: boolean }> {
    try {
      return { target: await verifyRemoteWorkspaceTarget(this.target, signal), retiredCleanup: false }
    } catch {
      return { target: this.ownerTarget, retiredCleanup: true }
    }
  }

  private async closeRemote(): Promise<void> {
    try {
      using terminate = deadline(undefined, TERMINAL_OPERATION_TIMEOUT_MS, TERMINAL_OPERATION_TIMEOUT)
      const { target, retiredCleanup } = await this.targetForCleanup(terminate.signal)
      try {
        await callRemoteWorkspaceBridge(
          target, '/v1/terminals/terminate', 'POST', { id: this.id }, parseAccepted,
          terminate.signal, true, terminate.signal, retiredCleanup,
        )
      } catch (error: unknown) {
        // marker 复验通过后才发生的重绑同样必须能收回已发布 PTY；仅重试
        // owner 的终止 route，不允许把普通控制操作回退到旧世界。
        if (retiredCleanup || !isStaleMarkerRejection(error)) throw error
        await callRemoteWorkspaceBridge(
          this.ownerTarget, '/v1/terminals/terminate', 'POST', { id: this.id }, parseAccepted,
          terminate.signal, true, terminate.signal, true,
        )
      }
      // terminate 已等待 PTY 收敛。marker 失效已使输出失败时，不再用旧连接读取
      // 终态字节；否则仍必须复验当前 marker 后才读取最终 cursor 和退出事实。
      if (this.isClosed()) return
      try {
        using finalRead = deadline(undefined, TERMINAL_OPERATION_TIMEOUT_MS, TERMINAL_OPERATION_TIMEOUT)
        const finalTarget = await verifyRemoteWorkspaceTarget(this.target, finalRead.signal)
        const final = await callRemoteWorkspaceBridge(finalTarget, '/v1/terminals/read', 'POST', {
          id: this.id, after: this.cursor, waitMs: 1,
        }, parseRead, finalRead.signal, true, finalRead.signal)
        this.consume(final)
      } catch (error: unknown) {
        if (!this.isClosed()) this.fail(error)
      }
      if (!this.isClosed()) this.finish({ exitCode: null, signal: null })
    } finally {
      await this.drainOperations()
    }
  }
}

/**
 * 分配一个远端 PTY 并发布其所有权句柄。
 * @param target - 已映射到 Remote-SSH marker 的工作区目标。
 * @param spec - 经 subprocess seam 校验的 PTY 启动参数。
 * @returns 负责读取、写入与终止已分配远端 PTY 的句柄。
 */
export async function spawnRemoteTerminal(
  target: RemoteWorkspaceTarget,
  spec: SubprocessTerminalSpawnSpec,
): Promise<RemoteTerminalHandle> {
  spec.signal?.throwIfAborted()
  const verified = await verifyRemoteWorkspaceTarget(target, spec.signal)
  const request: StartRequest = {
    path: verified.remotePath,
    argv: [...spec.argv],
    env: spec.env ?? {},
    rows: spec.rows,
    cols: spec.cols,
    graceMs: spec.graceMs,
    startNonce: terminalStartNonce(),
  }
  let response: StartResponse
  let startDispatched = false
  let definitiveDeadlineElapsed = false
  try {
    using definitive = deadline(undefined, TERMINAL_START_TIMEOUT_MS, TERMINAL_START_TIMEOUT)
    definitive.signal.addEventListener('abort', () => { definitiveDeadlineElapsed = true }, { once: true })
    // `callRemoteWorkspaceBridge()` 在真正 fetch 前同步检查 caller signal；这个
    // 检查以后才可把请求视为可能已经到达远端并承担孤儿回收责任。
    spec.signal?.throwIfAborted()
    startDispatched = true
    response = await callRemoteWorkspaceBridge(
      verified, '/v1/terminals/start', 'POST', request, parseStart,
      spec.signal, true, definitive.signal,
    )
  } catch (error: unknown) {
    if (startDispatched && needsTerminalStartRecovery(error, definitiveDeadlineElapsed)) {
      await reclaimUncertainTerminalStart(target, request)
    }
    throw error
  }
  const handle = new RemoteTerminalHandle(verified, response.id, response.pid)
  if (spec.signal?.aborted) {
    await handle.terminate().catch(() => {})
    throw spec.signal.reason ?? new Error('aborted during remote terminal allocation')
  }
  return handle
}
