/** 通过 Go agent 进程协议实现的 Remote-SSH 子进程句柄。 */

import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { PassThrough, Writable } from 'node:stream'
import type { RemoteWorkspaceTarget, SubprocessCollect, SubprocessHandle, SubprocessOutcome, SubprocessOutputMode, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { callRemoteWorkspaceBridge, RemoteWorkspaceError, verifyRemoteWorkspaceTarget } from '@deepseek-ai/dsh-subprocess'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { RemoteOutputReader } from './remote-output.ts'

const REMOTE_READ_CHUNK_BYTES = 64 * 1024
const REMOTE_WAIT_MS = 25_000
/** start 响应和未知分配的回收不能受 caller abort 直接控制。 */
const REMOTE_PROCESS_START_TIMEOUT_MS = 30_000
const REMOTE_PROCESS_START_TIMEOUT = 'REMOTE_PROCESS_START_TIMEOUT'
/** 单次远端进程 RPC 的传输上限；主动终止会更早地中止普通请求。 */
const REMOTE_PROCESS_OPERATION_TIMEOUT_MS = 30_000
const REMOTE_PROCESS_OPERATION_TIMEOUT = 'REMOTE_PROCESS_OPERATION_TIMEOUT'
/** 终止要覆盖 agent 的 TERM 宽限期，再预留一次有界 RPC 来确认最终状态。 */
const REMOTE_PROCESS_TERMINATION_TIMEOUT = 'REMOTE_PROCESS_TERMINATION_TIMEOUT'

interface RemoteProcessSnapshot {
  id: string
  pid: number
  running: boolean
  closed: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdinClosed: boolean
  startedAt: number
  exitedAt?: number
}

interface RemoteProcessStartResponse { process: RemoteProcessSnapshot }

interface RemoteProcessStartRequest {
  path: string
  argv: string[]
  env: Record<string, string | null>
  stdin: { mode: 'ignore' | 'pipe' | 'data'; dataBase64?: string }
  stdout: { mode: 'pipe' | 'collect'; maxBytes?: number }
  stderr: { mode: 'pipe' | 'collect'; maxBytes?: number }
  graceMs: number
  startNonce: string
}

interface RemoteProcessReadResponse {
  dataBase64: string
  nextOffset: number
  lossy: boolean
  truncated: boolean
  eof: boolean
  closed: boolean
  process: RemoteProcessSnapshot
}

interface RemoteProcessWaitResponse {
  completed: boolean
  process: RemoteProcessSnapshot
}

interface RemoteProcessWriteResponse {
  written: number
  stdinClosed: boolean
  process: RemoteProcessSnapshot
}

interface PendingWrite {
  data: Buffer
  closeStdin: boolean
  callback: (error?: Error | null) => void
}

const SIGNALS = new Set<NodeJS.Signals>([
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGIO',
  'SIGKILL', 'SIGPIPE', 'SIGPROF', 'SIGQUIT', 'SIGSEGV', 'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP',
  'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ',
])

function record(value: unknown, message = 'remote process returned an invalid response'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

/** 成功响应是封闭协议；忽略未知字段会让 agent 悄然改变 Host 观察到的语义。 */
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error('remote process returned an invalid response')
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = record(value)
  onlyKeys(source, keys)
  return source
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) throw new Error(`remote process response has an invalid ${key}`)
  return field
}

function integerField(value: Record<string, unknown>, key: string, minimum = 0): number {
  const field = value[key]
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < minimum) {
    throw new Error(`remote process response has an invalid ${key}`)
  }
  return field
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key]
  if (typeof field !== 'boolean') throw new Error(`remote process response has an invalid ${key}`)
  return field
}

function nullableInteger(value: Record<string, unknown>, key: string, minimum = 0): number | null {
  if (!Object.hasOwn(value, key)) throw new Error(`remote process response has an invalid ${key}`)
  const field = value[key]
  if (field === null) return null
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < minimum) {
    throw new Error(`remote process response has an invalid ${key}`)
  }
  return field
}

function nullableSignal(value: Record<string, unknown>, key: string): NodeJS.Signals | null {
  if (!Object.hasOwn(value, key)) throw new Error(`remote process response has an invalid ${key}`)
  const field = value[key]
  if (field === null) return null
  if (typeof field !== 'string' || !SIGNALS.has(field as NodeJS.Signals)) throw new Error(`remote process response has an invalid ${key}`)
  return field as NodeJS.Signals
}

function parseSnapshot(value: unknown): RemoteProcessSnapshot {
  const source = record(value)
  const hasExitedAt = Object.hasOwn(source, 'exitedAt')
  onlyKeys(source, hasExitedAt
    ? ['id', 'pid', 'running', 'closed', 'exitCode', 'signal', 'stdinClosed', 'startedAt', 'exitedAt']
    : ['id', 'pid', 'running', 'closed', 'exitCode', 'signal', 'stdinClosed', 'startedAt'])
  const snapshot: RemoteProcessSnapshot = {
    id: stringField(source, 'id'),
    pid: integerField(source, 'pid', 1),
    running: booleanField(source, 'running'),
    closed: booleanField(source, 'closed'),
    exitCode: nullableInteger(source, 'exitCode'),
    signal: nullableSignal(source, 'signal'),
    stdinClosed: booleanField(source, 'stdinClosed'),
    startedAt: integerField(source, 'startedAt', 0),
  }
  if (hasExitedAt) snapshot.exitedAt = integerField(source, 'exitedAt', 0)
  // agent 会话的 closed 只表示已回收的子进程，而不是 stdin 或某条输出流的
  // 单独关闭。终态必须携带唯一的退出事实，运行态则不能伪造旧终态。
  if (snapshot.running === snapshot.closed
    || snapshot.running && (snapshot.exitCode !== null || snapshot.signal !== null || snapshot.exitedAt !== undefined)
    || !snapshot.running && (snapshot.exitCode === null) === (snapshot.signal === null)
    || !snapshot.running && (snapshot.exitedAt === undefined || snapshot.exitedAt < snapshot.startedAt)) {
    throw new Error('remote process response has inconsistent process state')
  }
  return snapshot
}

function parseStart(value: unknown): RemoteProcessStartResponse {
  return { process: parseSnapshot(exactRecord(value, ['process']).process) }
}

function parseRead(value: unknown): RemoteProcessReadResponse {
  const source = exactRecord(value, ['dataBase64', 'nextOffset', 'lossy', 'truncated', 'eof', 'closed', 'process'])
  const dataBase64 = parseBase64(source.dataBase64)
  const response = {
    dataBase64,
    nextOffset: integerField(source, 'nextOffset', 0),
    lossy: booleanField(source, 'lossy'),
    truncated: booleanField(source, 'truncated'),
    eof: booleanField(source, 'eof'),
    closed: booleanField(source, 'closed'),
    process: parseSnapshot(source.process),
  }
  // `closed` 是快照的冗余事实；若已关闭却没有剩余字节，agent 必须给出 EOF，
  // 否则 Consumer 会在一个不可能推进的游标上无限轮询。
  if (response.closed !== response.process.closed || response.eof && !response.closed
    || response.lossy && !response.truncated
    || response.closed && !response.eof && dataBase64.length === 0) {
    throw new Error('remote process response has inconsistent read state')
  }
  return response
}

function parseBase64(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2 * REMOTE_READ_CHUNK_BYTES + 8 || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error('remote process response has invalid dataBase64')
  }
  try {
    const data = Buffer.from(value, 'base64')
    if (data.byteLength > REMOTE_READ_CHUNK_BYTES || data.toString('base64') !== value) {
      throw new Error('non-canonical or oversized base64')
    }
  } catch {
    throw new Error('remote process response has invalid dataBase64')
  }
  return value
}

function parseWait(value: unknown): RemoteProcessWaitResponse {
  const source = exactRecord(value, ['completed', 'process'])
  const completed = booleanField(source, 'completed')
  const process = parseSnapshot(source.process)
  // completed=true 却仍声称运行中会令 Host 把活树当成静默。反向竞态可由
  // agent 在 timeout 与进程退出同时发生时产生，因此交由调用点按终态收敛。
  if (completed && process.running) throw new Error('remote process response has inconsistent wait state')
  return { completed, process }
}

function parseWrite(value: unknown): RemoteProcessWriteResponse {
  const source = exactRecord(value, ['written', 'stdinClosed', 'process'])
  return {
    written: integerField(source, 'written', 0),
    stdinClosed: booleanField(source, 'stdinClosed'),
    process: parseSnapshot(source.process),
  }
}

function parsePath(value: unknown): string {
  return stringField(exactRecord(value, ['path']), 'path')
}

function parseProcessResponse(value: unknown): RemoteProcessSnapshot {
  return parseSnapshot(exactRecord(value, ['process']).process)
}

function base64(data: Uint8Array): string { return Buffer.from(data).toString('base64') }

function environment(extra: NodeJS.ProcessEnv | undefined): Record<string, string | null> {
  const result: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(extra ?? {})) result[key] = value === undefined ? null : value
  return result
}

function outputMode(mode: SubprocessOutputMode): { mode: 'pipe' | 'collect'; maxBytes?: number } {
  // Go agent 不能继承 Node Host 的文件描述符；pipe 由 provider 将字节重放到
  // Host 对应的描述符。
  if (mode === 'inherit' || mode === 'pipe') return { mode: 'pipe' }
  return { mode: 'collect', maxBytes: mode.maxBytes }
}

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect { return mode !== 'pipe' && mode !== 'inherit' }

/** 只有已收到 agent 明确拒绝的启动请求，才能证明远端没有创建进程。 */
function isDefinitiveStartRejection(error: unknown): boolean {
  return error instanceof RemoteWorkspaceError
    && error.code === 'REMOTE_BRIDGE_REJECTED'
    && error.bridgeCode !== undefined
    && error.bridgeCode !== 'bridge-unavailable'
    && error.bridgeCode !== 'invalid-agent-response'
}

/** bridge 在 marker 重绑已提交后拒绝旧 generation；可仅为 owner 终止重试。 */
function isStaleMarkerRejection(error: unknown): boolean {
  return error instanceof RemoteWorkspaceError
    && error.code === 'REMOTE_BRIDGE_REJECTED'
    && error.bridgeCode === 'stale-marker'
}

/** Go agent 的进程幂等键固定为 16 字节随机数的 lowercase hex 编码。 */
function processStartNonce(): string { return randomBytes(16).toString('hex') }

/** 已派发 start 的这些不确定失败仍可能在远端留下一个尚未交付的子进程。 */
function needsProcessStartRecovery(error: unknown, definitiveDeadlineElapsed: boolean): boolean {
  if (!(error instanceof RemoteWorkspaceError)) return false
  if (error.code === 'REMOTE_BRIDGE_UNAVAILABLE' || error.code === 'REMOTE_BRIDGE_RESPONSE_INVALID') return true
  if (error.code === 'REMOTE_BRIDGE_ABORTED') return definitiveDeadlineElapsed
  return error.code === 'REMOTE_BRIDGE_REJECTED'
    && (error.bridgeCode === 'bridge-unavailable' || error.bridgeCode === 'invalid-agent-response')
}

/**
 * 仅在当前 marker 仍指向首次 target 时以同一 nonce 重放 start 并回收其进程树。
 * 未发布的进程没有可合法使用的 owner fallback；marker 重绑时宁可交给远端
 * retention，也不能让旧连接收到新的控制请求。
 */
async function reclaimUncertainProcessStart(
  target: RemoteWorkspaceTarget,
  request: RemoteProcessStartRequest,
): Promise<void> {
  let started: RemoteProcessStartResponse
  try {
    using lookup = deadline(undefined, REMOTE_PROCESS_START_TIMEOUT_MS, REMOTE_PROCESS_START_TIMEOUT)
    const current = await verifyRemoteWorkspaceTarget(target, lookup.signal)
    started = await callRemoteWorkspaceBridge(
      current, '/v1/processes/start', 'POST', request, parseStart, lookup.signal, true, lookup.signal,
    )
  } catch {
    return
  }
  try {
    using cleanup = deadline(undefined, REMOTE_PROCESS_START_TIMEOUT_MS, REMOTE_PROCESS_START_TIMEOUT)
    // 首次重放结束后仍须复验 marker，避免在两个 HTTP mutation 之间发生重绑时
    // 以旧连接回收一个不再可归属的进程。
    const current = await verifyRemoteWorkspaceTarget(target, cleanup.signal)
    const stopped = await callRemoteWorkspaceBridge(
      current, '/v1/processes/kill', 'POST', { id: started.process.id, signal: 'SIGKILL' },
      parseProcessResponse, cleanup.signal, true, cleanup.signal,
    )
    if (stopped.id !== started.process.id) throw new Error('remote process recovery returned a different process')
  } catch {
    // 调用方仍应看到原始 start 故障；补偿不能把它替换为清理的二级异常。
  }
}

/** OS 侧位于所选远端 Go agent 的受管进程。 */
export class RemoteSubprocessHandle implements SubprocessHandle {
  private processId: string | undefined
  private processPid = -1
  private processStartedAt = -1
  /** 已发布进程的启动连接，仅在 marker 失效后的补偿终止中使用。 */
  private ownerTarget: RemoteWorkspaceTarget | undefined
  private processExited = false
  private settled = false
  private failed = false
  private stopping = false
  private killStarted = false
  /** start 变更一旦可能已经到达 Go agent 即为真。 */
  private startDispatched = false
  private killTimer: ReturnType<typeof setTimeout> | undefined
  /** 普通读、等、写操作共用的取消源；清理会改用独立 deadline。 */
  private readonly operationAbort = new AbortController()
  private readonly started = Promise.withResolvers<void>()
  private readonly treeExit = Promise.withResolvers<void>()
  private readonly completion = Promise.withResolvers<SubprocessOutcome>()
  private readonly pendingWrites: PendingWrite[] = []
  private flushing = false
  private readonly outputLoops: Promise<void>[] = []
  private waitLoop: Promise<void> | undefined
  private terminationWatch: Promise<void> | undefined
  private readonly outputOffsets: Record<'stdout' | 'stderr', number> = { stdout: 0, stderr: 0 }

  readonly stdin: Writable | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly collected: SubprocessHandle['collected']
  readonly done = this.completion.promise

  constructor(
    private readonly target: RemoteWorkspaceTarget,
    private readonly spec: SubprocessSpawnSpec,
  ) {
    if (spec.signal?.aborted) throw spec.signal.reason ?? new Error('aborted before remote spawn')
    // 无 pipe 的 spawn 不会等待就绪；失败通过 done 表示，避免未处理的就绪拒绝。
    this.started.promise.catch(() => {})
    // 请求已发出后的 bridge 失败无法证明远端树已退出；需要静默的调用方必须把
    // 这种不确定性视为拒绝。
    this.treeExit.promise.catch(() => {})
    this.stdout = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    this.stderr = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
    this.collected = {
      ...isCollect(spec.stdio.stdout) ? { stdout: new RemoteOutputReader(spec.stdio.stdout.maxBytes) } : {},
      ...isCollect(spec.stdio.stderr) ? { stderr: new RemoteOutputReader(spec.stdio.stderr.maxBytes) } : {},
    }
    if (spec.stdio.stdin === 'pipe') {
      this.stdin = new Writable({
        write: (chunk, encoding, callback) => {
          const data = Buffer.isBuffer(chunk)
            ? chunk
            : typeof chunk === 'string'
              ? Buffer.from(chunk, encoding)
              : undefined
          if (data === undefined) {
            callback(new TypeError('remote process stdin accepts only Buffer or string chunks'))
            return
          }
          this.pendingWrites.push({ data, closeStdin: false, callback })
          void this.flushWrites()
        },
        final: (callback) => {
          this.pendingWrites.push({ data: Buffer.alloc(0), closeStdin: true, callback })
          void this.flushWrites()
        },
      })
    }
    this.spec.signal?.addEventListener('abort', () => { this.terminate() }, { once: true })
    void this.start()
  }

  get pid(): number { return this.processPid }

  /** bridge await 后的当前终止状态。 */
  private isStopping(): boolean { return this.stopping }

  /** 只有未失败且未结算的句柄可以提交终态。 */
  private canFinish(): boolean { return !this.failed && !this.settled }

  /** 普通控制请求必须随句柄终止或单次传输 deadline 结束。 */
  private async normalOperation<T>(
    request: (target: RemoteWorkspaceTarget, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    using operation = deadline(this.operationAbort.signal, REMOTE_PROCESS_OPERATION_TIMEOUT_MS, REMOTE_PROCESS_OPERATION_TIMEOUT)
    const target = await verifyRemoteWorkspaceTarget(this.target, operation.signal)
    operation.signal.throwIfAborted()
    return await request(target, operation.signal)
  }

  /** 清理观察仍必须使用当前 marker，且不能继承已取消的普通操作信号。 */
  private async cleanupOperation<T>(
    upstream: AbortSignal | undefined,
    request: (target: RemoteWorkspaceTarget, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    using operation = deadline(upstream, REMOTE_PROCESS_OPERATION_TIMEOUT_MS, REMOTE_PROCESS_OPERATION_TIMEOUT)
    const target = await verifyRemoteWorkspaceTarget(this.target, operation.signal)
    operation.signal.throwIfAborted()
    return await request(target, operation.signal)
  }

  private terminationTimeoutMs(): number {
    return Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(REMOTE_PROCESS_OPERATION_TIMEOUT_MS, this.spec.graceMs + REMOTE_PROCESS_OPERATION_TIMEOUT_MS),
    )
  }

  private async start(): Promise<void> {
    try {
      const verified = await verifyRemoteWorkspaceTarget(this.target, this.spec.signal)
      const stdin = this.spec.stdio.stdin
      const startRequest: RemoteProcessStartRequest = {
        path: verified.remotePath,
        argv: [...this.spec.argv],
        env: environment(this.spec.env),
        stdin: typeof stdin === 'object'
          ? { mode: 'data', dataBase64: base64(Buffer.from(stdin.data, 'utf8')) }
          : { mode: stdin },
        stdout: outputMode(this.spec.stdio.stdout),
        stderr: outputMode(this.spec.stdio.stderr),
        graceMs: this.spec.graceMs,
        startNonce: processStartNonce(),
      }
      // 调用方取消时 start 请求可能已经到达远端 agent。等待确定响应，才能让
      // 已接受的进程获得对应的终止，而不是成为孤儿。独立 deadline 到期后，同
      // nonce 重放只用于找回并回收已创建但未返回 id 的进程。
      let response: RemoteProcessStartResponse
      let definitiveDeadlineElapsed = false
      try {
        using definitive = deadline(undefined, REMOTE_PROCESS_START_TIMEOUT_MS, REMOTE_PROCESS_START_TIMEOUT)
        definitive.signal.addEventListener('abort', () => { definitiveDeadlineElapsed = true }, { once: true })
        // bridge 先同步检查 caller signal；通过该检查才可能发起实际 fetch。
        this.spec.signal?.throwIfAborted()
        this.startDispatched = true
        response = await callRemoteWorkspaceBridge(
          verified, '/v1/processes/start', 'POST', startRequest, parseStart,
          this.spec.signal, true, definitive.signal,
        )
      } catch (error: unknown) {
        if (this.startDispatched && needsProcessStartRecovery(error, definitiveDeadlineElapsed)) {
          await reclaimUncertainProcessStart(this.target, startRequest)
        }
        throw error
      }
      this.processId = response.process.id
      this.processPid = response.process.pid
      this.processStartedAt = response.process.startedAt
      this.observeSnapshot(response.process)
      this.ownerTarget = { ...verified }
      this.started.resolve()
      this.outputLoops.push(this.readStream('stdout', this.spec.stdio.stdout))
      this.outputLoops.push(this.readStream('stderr', this.spec.stdio.stderr))
      this.waitLoop = this.waitProcess()
      if (this.stopping) this.beginTermination()
      void this.flushWrites()
    } catch (error: unknown) {
      this.started.reject(error)
      this.fail(error)
    }
  }

  private async readStream(
    stream: 'stdout' | 'stderr',
    mode: SubprocessOutputMode,
    cleanupSignal?: AbortSignal,
  ): Promise<void> {
    const reader = isCollect(mode) ? this.collected[stream] as RemoteOutputReader : undefined
    let offset = this.outputOffsets[stream]
    try {
      for (;;) {
        if (this.processId === undefined) return
        const request = (target: RemoteWorkspaceTarget, signal: AbortSignal): Promise<RemoteProcessReadResponse> =>
          callRemoteWorkspaceBridge(target, '/v1/processes/read', 'POST', {
            id: this.processId as string, stream, from: offset, maxBytes: REMOTE_READ_CHUNK_BYTES,
          }, parseRead, signal)
        const response = cleanupSignal === undefined
          ? await this.normalOperation(request)
          : await this.cleanupOperation(cleanupSignal, request)
        const data = Buffer.from(response.dataBase64, 'base64')
        this.observeSnapshot(response.process)
        if (response.nextOffset < offset || response.nextOffset < data.length) {
          throw new Error('remote process output offset moved backwards')
        }
        const start = response.nextOffset - data.length
        if (start < offset) throw new Error('remote process output overlaps an acknowledged range')
        // truncated 是 agent 缓冲区曾经滚动的诊断事实；只有本次 from 已经
        // 落进不可恢复缺口的 lossy 才说明 Host 缺少字节。
        if (response.lossy) {
          if (reader === undefined) throw new Error(`remote process ${stream} output was lost before delivery`)
        } else if (start !== offset) {
          throw new Error('remote process output skipped bytes without reporting loss')
        }
        if (response.closed && !response.eof && data.length === 0) {
          throw new Error('remote process output closed without EOF or remaining bytes')
        }
        if (reader !== undefined) {
          reader.pushRemote(data, response.nextOffset, response.lossy)
        } else if (data.length > 0) {
          if (mode === 'inherit') (stream === 'stdout' ? process.stdout : process.stderr).write(data)
          else (stream === 'stdout' ? this.stdout : this.stderr)?.write(data)
        }
        offset = response.nextOffset
        this.outputOffsets[stream] = offset
        if (response.eof) break
        if (data.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
      }
    } catch (error: unknown) {
      if (cleanupSignal !== undefined) throw error
      if (!this.failed && !this.stopping) this.fail(error)
    }
  }

  private async waitProcess(): Promise<void> {
    try {
      for (;;) {
        if (this.processId === undefined) return
        const response = await this.normalOperation((target, signal) => callRemoteWorkspaceBridge(
          target, '/v1/processes/wait', 'POST', {
            id: this.processId as string, timeoutMs: REMOTE_WAIT_MS,
          }, parseWait, signal,
        ))
        this.observeSnapshot(response.process)
        // timeout 与 waitLoop 的退出可交错：agent 可能报告 completed:false，却在
        // 构造同一响应的快照时已经观察到终态。以终态快照收敛既保留该合法竞态，
        // 也不会被 closed-but-incomplete 的坏响应永久卡住。
        if (!response.completed && response.process.running) continue
        this.processExited = true
        await Promise.all(this.outputLoops)
        this.finish({ exitCode: response.process.exitCode, signal: response.process.signal })
        return
      }
    } catch (error: unknown) {
      if (!this.failed && !this.stopping) this.fail(error)
    }
  }

  /** 在普通 wait 被主动取消后，用当前 marker 的有界请求确认进程树终态。 */
  private async waitForTermination(signal: AbortSignal): Promise<RemoteProcessSnapshot> {
    for (;;) {
      if (this.processId === undefined) throw new Error('remote process was not allocated')
      const response = await this.cleanupOperation(signal, (target, operationSignal) => callRemoteWorkspaceBridge(
        target, '/v1/processes/wait', 'POST', {
          id: this.processId as string, timeoutMs: REMOTE_WAIT_MS,
        }, parseWait, operationSignal,
      ))
      this.observeSnapshot(response.process)
      if (!response.completed && response.process.running) continue
      this.processExited = true
      return response.process
    }
  }

  private async flushWrites(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      await this.started.promise
      while (this.pendingWrites.length > 0) {
        const pending = this.pendingWrites.shift()
        if (pending === undefined) break
        if (this.processId === undefined || this.processExited || this.failed || this.stopping) {
          pending.callback(new Error('remote process has exited'))
          continue
        }
        try {
          const response = await this.normalOperation((target, signal) => callRemoteWorkspaceBridge(
            target, '/v1/processes/write', 'POST', {
              id: this.processId as string,
              dataBase64: base64(pending.data),
              ...pending.closeStdin ? { closeStdin: true } : {},
            }, parseWrite, signal,
          ))
          this.observeSnapshot(response.process)
          if (response.written !== pending.data.length) throw new Error('remote process wrote an invalid stdin byte count')
          if (pending.closeStdin && !response.stdinClosed) throw new Error('remote process did not close stdin')
          pending.callback(null)
        } catch (error: unknown) {
          pending.callback(error instanceof Error ? error : new Error(String(error)))
          if (!this.isStopping()) {
            this.fail(error)
            this.rejectPendingWrites(new Error('remote process stdin failed'))
          }
        }
      }
    } catch (error: unknown) {
      this.rejectPendingWrites(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.flushing = false
    }
  }

  /** 以同一个失败原因结算尚未发送到远端的 stdin 写入。 */
  private rejectPendingWrites(error: Error): void {
    for (;;) {
      const pending = this.pendingWrites.shift()
      if (pending === undefined) return
      pending.callback(error)
    }
  }

  private finish(outcome: SubprocessOutcome): void {
    if (this.settled) return
    this.settled = true
    this.processExited = true
    this.operationAbort.abort('remote process exited')
    if (this.killTimer !== undefined) clearTimeout(this.killTimer)
    this.killTimer = undefined
    this.stdout?.end()
    this.stderr?.end()
    this.completion.resolve(outcome)
    this.treeExit.resolve()
    this.rejectPendingWrites(new Error('remote process has exited'))
  }

  private fail(error: unknown): void {
    if (this.failed || this.settled) return
    this.failed = true
    this.operationAbort.abort('remote process failed')
    if (this.killTimer !== undefined) clearTimeout(this.killTimer)
    this.killTimer = undefined
    const reason = error instanceof Error ? error : new Error(String(error))
    this.stdout?.destroy(reason)
    this.stderr?.destroy(reason)
    this.rejectPendingWrites(reason)
    this.completion.reject(reason)
    if (this.startDispatched && !isDefinitiveStartRejection(error)) this.treeExit.reject(reason)
    else this.treeExit.resolve()
    if (this.processId !== undefined) void this.sendKill('SIGKILL').catch(() => {})
  }

  /** 已发布进程的终止请求始终使用独立 cleanup deadline。 */
  private async sendKill(
    signal: 'SIGTERM' | 'SIGKILL',
    upstream?: AbortSignal,
  ): Promise<RemoteProcessSnapshot | undefined> {
    if (this.processId === undefined || this.killStarted && signal === 'SIGTERM') return undefined
    if (signal === 'SIGTERM') this.killStarted = true
    using operation = deadline(upstream, REMOTE_PROCESS_OPERATION_TIMEOUT_MS, REMOTE_PROCESS_OPERATION_TIMEOUT)
    const { target, retiredCleanup } = await this.targetForTermination(operation.signal)
    operation.signal.throwIfAborted()
    let snapshot: RemoteProcessSnapshot
    try {
      snapshot = await callRemoteWorkspaceBridge(
        target, '/v1/processes/kill', 'POST', {
          id: this.processId, signal,
        }, parseProcessResponse, operation.signal, true, operation.signal, retiredCleanup,
      )
    } catch (error: unknown) {
      // marker 校验与 bridge dispatch 之间恰好发生重绑时，普通 target 会被
      // bridge 拒绝。仅此时重试已发布 owner 的显式终止，不恢复任何一般操作。
      if (retiredCleanup || this.ownerTarget === undefined || !isStaleMarkerRejection(error)) throw error
      snapshot = await callRemoteWorkspaceBridge(
        this.ownerTarget, '/v1/processes/kill', 'POST', {
          id: this.processId, signal,
        }, parseProcessResponse, operation.signal, true, operation.signal, true,
      )
    }
    this.observeSnapshot(snapshot)
    return snapshot
  }

  /**
   * 终止先中止普通 read/wait，再用独立 cleanup 请求等待远端树和两个输出流收敛。
   * 任一 cleanup bridge 失效都会由调用点 fail，避免 provider dispose 等待悬空句柄。
   */
  private beginTermination(): void {
    if (this.processId === undefined || this.terminationWatch !== undefined || this.settled || this.failed) return
    const watch = this.watchTermination()
    this.terminationWatch = watch
    void watch.catch((error: unknown) => { this.fail(error) })
  }

  private async watchTermination(): Promise<void> {
    using cleanup = deadline(undefined, this.terminationTimeoutMs(), REMOTE_PROCESS_TERMINATION_TIMEOUT)
    // scheduleKill 从 TERM 请求派发时刻开始计时；即使该响应半挂起，KILL 仍会按
    // grace 发出，并由这个 watcher 的有界 wait 收敛最终状态。
    const termination = this.sendKill('SIGTERM', cleanup.signal)
    this.scheduleKill()
    const initial = await termination
    await Promise.all([...this.outputLoops, this.waitLoop ?? Promise.resolve()])
    if (this.failed || this.settled) return
    const terminal = initial?.closed ? initial : await this.waitForTermination(cleanup.signal)
    await Promise.all([
      this.readStream('stdout', this.spec.stdio.stdout, cleanup.signal),
      this.readStream('stderr', this.spec.stdio.stderr, cleanup.signal),
    ])
    if (this.canFinish()) {
      this.finish({ exitCode: terminal.exitCode, signal: terminal.signal })
    }
  }

  /**
   * 只有进程树终止可回退到已发布 owner；read、write、wait、start 和解析都必须
   * 使用当前 marker，避免旧连接在重绑后继续承接一般能力调用。
   */
  private async targetForTermination(signal?: AbortSignal): Promise<{ target: RemoteWorkspaceTarget; retiredCleanup: boolean }> {
    try {
      return { target: await verifyRemoteWorkspaceTarget(this.target, signal), retiredCleanup: false }
    } catch (error: unknown) {
      if (this.ownerTarget === undefined) throw error
      return { target: this.ownerTarget, retiredCleanup: true }
    }
  }

  private scheduleKill(): void {
    if (this.killTimer !== undefined || this.settled || this.failed) return
    this.killTimer = setTimeout(() => {
      this.killTimer = undefined
      if (!this.settled && !this.failed) void this.sendKill('SIGKILL').catch(() => {})
    }, this.spec.graceMs)
  }

  terminate(): void {
    if (this.settled || this.failed || this.stopping) return
    this.stopping = true
    // 先取消正在飞行的普通 read/wait/write；它们不能拖住 cleanup 所需的连接。
    this.operationAbort.abort('remote process termination requested')
    this.beginTermination()
  }

  /** Node Host 同步退出时使用已发布进程的连接身份尽力强制终止。 */
  terminateForHostExit(): void {
    if (this.processId === undefined || this.ownerTarget === undefined) return
    void callRemoteWorkspaceBridge(this.ownerTarget, '/v1/processes/kill', 'POST', {
      id: this.processId, signal: 'SIGKILL',
    }, parseProcessResponse, undefined, true, undefined, true).catch(() => {})
  }

  /** 拒绝被替换、回退或混入其他会话的快照，避免把错误进程的终态当作本树事实。 */
  private observeSnapshot(snapshot: RemoteProcessSnapshot): void {
    if (this.processId === undefined || snapshot.id !== this.processId
      || snapshot.pid !== this.processPid || snapshot.startedAt !== this.processStartedAt) {
      throw new Error('remote process response does not match the allocated process')
    }
    if (snapshot.closed) this.processExited = true
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false
    if (signal === undefined) {
      await this.treeExit.promise
      return true
    }
    const aborted = Promise.withResolvers<boolean>()
    const onAbort = (): void => { aborted.resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([this.treeExit.promise.then(() => true), aborted.promise])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * 通过 Go agent 清理后的 PATH 解析远端可执行文件。
 * @param target - 已映射到 Remote-SSH marker 的工作区目标。
 * @param command - 待解析的命令名或路径。
 * @param env - 覆盖远端进程环境的变量；省略时只使用 agent 的清理环境。
 * @param signal - 取消 marker 复核或 bridge 调用的信号。
 * @returns 远端 PATH 解析得到的可执行文件路径。
 */
export async function resolveRemoteExecutable(
  target: RemoteWorkspaceTarget,
  command: string,
  env: Readonly<Record<string, string>> | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const verified = await verifyRemoteWorkspaceTarget(target, signal)
  return await callRemoteWorkspaceBridge(verified, '/v1/processes/resolve', 'POST', {
    path: verified.remotePath,
    command,
    env: environment(env),
  }, parsePath, signal)
}
