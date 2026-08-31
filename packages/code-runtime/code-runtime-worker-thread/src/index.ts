/**
 * Worker-thread code runtime: a fresh worker runs each host-type-stripped TypeScript program
 * and bridges bindings over its message port. This is containment, not a security boundary:
 * model code has bash-equivalent trust despite an empty environment, a heap cap, measured
 * event-loop busy-time and wall-time budgets, and termination that also stops synchronous loops.
 * @module @deepseek-ai/dsh-code-runtime-worker-thread
 */

import { randomBytes } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { stripTypeScriptTypes } from 'node:module'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  callRemoteWorkspaceBridge,
  remoteWorkspacePath,
  RemoteWorkspaceError,
  verifyRemoteWorkspaceTarget,
} from '@deepseek-ai/dsh-subprocess'
import type { RemoteWorkspaceTarget } from '@deepseek-ai/dsh-subprocess'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CodeRuntime, DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from '@deepseek-ai/dsh-code-runtime'
import type { CodeBindingNamespace, CodeJsonValue, CodeRunFailure, CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { ReplyMessage, WorkerBootData, WorkerToHost } from './protocol.ts'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from './output-json.ts'
import { decodeWorkerJson, encodeWorkerJson } from './worker-json.ts'
import type { WorkerJsonWire } from './worker-json.ts'

/** Plugin config: every execution cap, changeable from `cordis.yml` (no hardcoded tunables). */
export interface Config {
  /**
   * Busy-time budget in milliseconds: the run fails with kind `'timeout'`
   * once the worker's MEASURED event-loop active time
   * (`worker.performance.eventLoopUtilization()`) exceeds this. Metering
   * measured busy time — not wall time, not host-side pending-call
   * bookkeeping — is what makes the budget both fair (a program awaiting a
   * slow tool accrues nothing) and ungameable (a hot loop accrues whether
   * or not a decoy dispatch is in flight).
   */
  computeMs?: number
  /**
   * Wall-clock ceiling in milliseconds; never pauses for anything. The
   * backstop for what busy-time cannot see (a program awaiting a promise
   * nobody will resolve). At most `2_147_483_647` (Node's maximum
   * `setTimeout` delay, about 24.9 days): a longer value is rejected at load
   * because `setTimeout` would clamp it to 1 ms.
   */
  maxWallMs?: number
  /**
   * Hard cap for serialized log-array, completion-value, and failure-message payloads;
   * fixed result-envelope syntax is excluded.
   */
  maxOutputBytes?: number
  /**
   * worker 的旧生代堆上限，单位为 MiB（`resourceLimits`），必须是 1 到
   * 2048 的安全整数。Remote-SSH marker 会把该值作为远端子进程的字节上限；
   * 溢出会终止 worker 或子进程，并以 `'worker-exit'` 返回。
   */
  maxOldGenerationSizeMb?: number
}

/** {@link Config} after schemastery fills the defaults (every field present). */
type ResolvedConfig = Required<Config>

/**
 * How often the host samples the worker's event-loop utilization for the
 * `computeMs` budget. An internal cadence, not config: the only effect of
 * the interval is budget-expiry granularity (a run can overshoot by up to
 * one interval), and nothing a deployment could tune here improves that
 * without burning host CPU.
 */
const ELU_POLL_INTERVAL_MS = 25

/** Smallest cap that can represent the counted payloads: an empty logs array plus an empty JSON failure message. */
const MIN_OUTPUT_BYTES = 4

/** 一 MiB 的字节数；远端子进程接收字节上限而本地 worker 配置使用 MiB。 */
const BYTES_PER_MIB = 1024 * 1024

/** Go agent 与本地 worker 共用的单次内存硬上限（2 GiB）。 */
const MAX_REMOTE_MEMORY_MIB = 2_048

/** Remote agent 的 Goja runner 当前接受的最大单次墙钟预算。 */
const REMOTE_CODE_MAX_TIMEOUT_MS = 10 * 60 * 1_000

/** 一次远端 bridge RPC 的最长等待；它受调用方更短的墙钟预算进一步收紧。 */
const REMOTE_CODE_BRIDGE_TIMEOUT_MS = 30_000

/** Go agent 的 Code Mode 事件槽位上限，Host 也以它约束尚未回包的本地 binding。 */
const REMOTE_CODE_MAX_PENDING_BINDINGS = 128

/** 供 timeout 工具标识远端 RPC 自己的等待上限，不与用户取消混淆。 */
const REMOTE_CODE_BRIDGE_TIMEOUT = 'REMOTE_CODE_BRIDGE_TIMEOUT'

/** 已派发但丢失响应的 code start 最多以同一 nonce 重试一次。 */
const REMOTE_CODE_START_ATTEMPTS = 2

/**
 * The seam's language-portable identifier subset (see
 * `CodeBindingNamespace.global`): no `$`, which is JS-only spelling — the same
 * namespace list must be usable against every backend regardless of language.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The shell a program is wrapped in for the type-strip, matching the
 * grammatical context it will execute in (an async function body, where
 * top-level `return` and `await` are legal — a bare module parse would
 * reject the `return`). Strip mode is position-preserving (removed syntax
 * becomes whitespace, nothing shifts), so the wrapper survives the strip
 * byte-identical and the body slices back out with the model's own
 * line/column positions intact.
 */
const STRIP_WRAP = { prefix: 'async function __dsh_program__() {\n', suffix: '\n}' } as const

/** One in-flight run's host-side state, tracked for disposal. */
interface LiveRun {
  worker: Worker
  settle(failure: CodeRunFailure): void
  finished: Promise<void>
}

/** 一项已启动的远端 Goja 执行；与本地 worker 一样由 provider 清理。 */
interface LiveRemoteRun {
  cancel(): Promise<void>
  finished: Promise<void>
}

/**
 * The worker entry path. Source runs unbuilt (`src/worker.ts`, loadable
 * directly on this repo's Node range via native type stripping — the file
 * is erasable-only with type-only relative imports); the built package
 * ships it as a sibling CommonJS bundle (`lib/worker.cjs`, its own tsdown
 * entry) because pkg's VFS Worker hook compiles string-path entries as
 * CommonJS.
 * The URL *pathname*'s extension says which world this module is in —
 * pathname, because dev-time module runners (vitest) may suffix
 * `import.meta.url` with a query string; relative resolution drops it. Worker
 * receives a filesystem string so pkg's VFS Worker hook can resolve it.
 */
/* v8 ignore next -- the './worker.cjs' arm is the built-lib world, unreachable unbuilt by construction; the built-lib e2e pins it. */
const WORKER_PATH = fileURLToPath(new URL(new URL(import.meta.url).pathname.endsWith('.ts') ? './worker.ts' : './worker.cjs', import.meta.url))

/** Render an unknown thrown value as a message, `Error` or not. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** AbortSignal 可在任意 await 期间变化，读取时不能由当前同步控制流推断。 */
function remoteRunWasAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Resolve after a worker pipe emits all queued data, or closes/errors during termination. */
function waitForPipeDrain(stream: Readable): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      stream.off('end', done)
      stream.off('close', done)
      stream.off('error', done)
      resolve()
    }
    stream.once('end', done)
    stream.once('close', done)
    stream.once('error', done)
    // Close the event-registration race if termination finished between the
    // initial state check and the listeners above.
    /* v8 ignore next -- this race cannot be scheduled deterministically between the adjacent state check and listener registration. */
    if (stream.readableEnded || stream.destroyed) done()
  })
}

/**
 * Runtime shape gate for inbound port traffic. The peer runs MODEL CODE and
 * can post anything — `null`, primitives, objects with poisoned fields — so
 * the compile-time `WorkerToHost` type means nothing here: everything is
 * re-validated and REBUILT field by field (a forged extra field never rides
 * along; a non-number call id can never be echoed into a reply). Junk returns
 * `undefined` and is dropped — a throw in the host's `message` listener would
 * crash the host process.
 */
function parseWorkerMessage(raw: unknown): WorkerToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const m = raw as Record<string, unknown>
  switch (m.type) {
    case 'call': {
      if (typeof m.id !== 'number' || typeof m.global !== 'string' || typeof m.name !== 'string') return undefined
      return { type: 'call', id: m.id, global: m.global, name: m.name, args: m.args as WorkerJsonWire }
    }
    case 'log': {
      if (typeof m.text !== 'string') return undefined
      return { type: 'log', text: m.text }
    }
    case 'output-limit': return { type: 'output-limit' }
    case 'done': {
      if (m.error === undefined) return { type: 'done', ...m.value !== undefined ? { value: m.value as WorkerJsonWire } : {} }
      const error = m.error
      if (typeof error !== 'object' || error === null) return undefined
      const { kind, message } = error as Record<string, unknown>
      if ((kind !== 'exception' && kind !== 'invalid-output' && kind !== 'output-limit') || typeof message !== 'string') return undefined
      return { type: 'done', error: { kind, message } }
    }
    default: return undefined
  }
}


/** One run's combined outer-output ledger; binding values never enter it. */
class OutputLedger {
  private bytes = 2 // JSON serialization of the empty logs array: []
  private entries = 0

  constructor(private readonly maxBytes: number) {}

  /** Admit one exact log entry, or report that the hard cap was crossed. */
  admit(text: string, sink: string[]): boolean {
    const separatorBytes = this.entries > 0 ? 1 : 0
    const stringBytes = jsonStringBytesUpTo(text, this.maxBytes - this.bytes - separatorBytes)
    if (stringBytes === undefined) return false
    this.bytes += stringBytes + separatorBytes
    this.entries += 1
    sink.push(text)
    return true
  }

  /** Finalize a successful absent-or-JSON completion against the combined cap. */
  success(logs: string[], value?: CodeJsonValue): CodeRunResult {
    if (value !== undefined && jsonValueBytesUpTo(value, this.maxBytes - this.bytes) === undefined) return this.limit(logs)
    return { logs, ...value !== undefined ? { value } : {} }
  }

  /** Finalize a failure diagnostic, with output-limit taking precedence when combined bytes exceed the cap. */
  failure(logs: string[], error: CodeRunFailure): CodeRunResult {
    if (jsonStringBytesUpTo(error.message, this.maxBytes - this.bytes) === undefined) return this.limit(logs)
    return { logs, error }
  }

  /** Build the explicit output-limit failure while retaining a fitting prefix of the final log. */
  limit(logs: string[]): CodeRunResult {
    const fullMessage = `outer output exceeded ${this.maxBytes} bytes`
    // The fixed diagnostic is ASCII, so every character is one byte plus the quotes.
    const messageBytes = fullMessage.length + 2
    const retained: string[] = []
    let retainedBytes = 2
    const logBudget = this.maxBytes - messageBytes
    for (const text of logs) {
      const separatorBytes = retained.length > 0 ? 1 : 0
      const availableBytes = logBudget - retainedBytes - separatorBytes
      const stringBytes = jsonStringBytesUpTo(text, availableBytes)
      if (stringBytes !== undefined) {
        retained.push(text)
        retainedBytes += stringBytes + separatorBytes
        continue
      }
      const prefix = truncateJsonStringBytes(text, availableBytes)
      if (prefix.length > 0) {
        const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes)
        /* v8 ignore next -- truncateJsonStringBytes guarantees its returned prefix fits the same budget. */
        if (prefixBytes === undefined) throw new Error('output ledger produced an oversized log prefix')
        retained.push(prefix)
        retainedBytes += prefixBytes + separatorBytes
      }
      break
    }
    const availableMessageBytes = this.maxBytes - retainedBytes
    const message = truncateJsonStringBytes(fullMessage, availableMessageBytes)
    return { logs: retained, error: { kind: 'output-limit', message } }
  }
}

type RemoteCodeFailureKind = CodeRunFailure['kind']

interface RemoteCodeWireEvent {
  type: 'tool_call' | 'log' | 'done'
  sequence: number
  callId?: number
  global?: string
  name?: string
  arguments?: CodeJsonValue
  level?: string
  text?: string
  result?: CodeRunResult
}

interface RemoteCodeNext {
  events: RemoteCodeWireEvent[]
  cursor: number
  done: boolean
}

function remoteCodeRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
  }
  return value as Record<string, unknown>
}

/** 远端 agent 的每一种成功载荷都有封闭字段集，避免未知字段悄然改变协议语义。 */
function remoteCodeOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(record).some(key => !keys.includes(key))) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
  }
}

function remoteCodeString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (!Object.hasOwn(record, key) || typeof value !== 'string') {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
  }
  return value
}

function remoteCodeInteger(record: Record<string, unknown>, key: string, minimum = 0): number {
  const value = record[key]
  if (!Object.hasOwn(record, key) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
  }
  return value
}

/** 将 bridge 解出的值重新快照，拒绝 JSON 无法无损表示的外部载荷。 */
function remoteCodeJson(value: unknown): CodeJsonValue | undefined {
  try {
    return snapshotJsonValue(value) as CodeJsonValue | undefined
  } catch {
    return undefined
  }
}

function parseRemoteCodeResult(value: unknown): CodeRunResult {
  const record = remoteCodeRecord(value)
  remoteCodeOnlyKeys(record, ['logs', 'value', 'error'])
  const rawLogs = record.logs
  if (!Object.hasOwn(record, 'logs') || !Array.isArray(rawLogs)) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
  }
  const logs: string[] = []
  for (const log of rawLogs) {
    if (typeof log !== 'string') {
      throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
    }
    logs.push(log)
  }
  const hasValue = Object.hasOwn(record, 'value')
  const hasError = Object.hasOwn(record, 'error')
  if (hasValue && hasError) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
  }
  if (hasError) {
    const failure = remoteCodeRecord(record.error)
    remoteCodeOnlyKeys(failure, ['kind', 'message'])
    const kind = remoteCodeString(failure, 'kind')
    if (!isRemoteCodeFailureKind(kind)) {
      throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
    }
    return { logs, error: { kind, message: remoteCodeString(failure, 'message') } }
  }
  if (!hasValue) return { logs }
  const completion = remoteCodeJson(record.value)
  if (completion === undefined) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
  }
  return { logs, value: completion }
}

function isRemoteCodeFailureKind(value: string): value is RemoteCodeFailureKind {
  return value === 'exception' || value === 'timeout' || value === 'abort'
    || value === 'worker-exit' || value === 'invalid-output' || value === 'output-limit'
}

/** 只有父端可收敛的预算/取消终态能与尚未回包的 binding 并存。 */
function remoteCodeDoneMayContainPending(result: CodeRunResult): boolean {
  return result.error?.kind === 'timeout' || result.error?.kind === 'abort'
}

function parseRemoteCodeStart(value: unknown): string {
  const record = remoteCodeRecord(value)
  remoteCodeOnlyKeys(record, ['id'])
  const id = remoteCodeString(record, 'id')
  if (!/^[a-f0-9]{32}$/u.test(id)) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
  }
  return id
}

function parseRemoteCodeAccepted(value: unknown): void {
  const record = remoteCodeRecord(value)
  remoteCodeOnlyKeys(record, ['accepted'])
  if (!Object.hasOwn(record, 'accepted') || record.accepted !== true) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
  }
}

function parseRemoteCodeEvent(value: unknown): RemoteCodeWireEvent {
  const record = remoteCodeRecord(value)
  const type = remoteCodeString(record, 'type')
  const sequence = remoteCodeInteger(record, 'sequence', 1)
  if (type === 'log') {
    remoteCodeOnlyKeys(record, ['type', 'sequence', 'level', 'text'])
    // level 仅供远端诊断分级；CodeRuntime 的稳定结果仍是有序文本数组。
    remoteCodeString(record, 'level')
    return { type, sequence, text: remoteCodeString(record, 'text') }
  }
  if (type === 'tool_call') {
    remoteCodeOnlyKeys(record, ['type', 'sequence', 'callId', 'global', 'name', 'arguments'])
    if (!Object.hasOwn(record, 'arguments')) {
      throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
    }
    const argumentsValue = remoteCodeJson(record.arguments)
    if (argumentsValue === undefined) {
      throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
    }
    return {
      type,
      sequence,
      callId: remoteCodeInteger(record, 'callId', 1),
      global: remoteCodeString(record, 'global'),
      name: remoteCodeString(record, 'name'),
      arguments: argumentsValue,
    }
  }
  if (type === 'done') {
    remoteCodeOnlyKeys(record, ['type', 'sequence', 'value', 'logs', 'error'])
    // done 保留完整 logs；流式 log 事件可能因远端事件队列饱和而被省略。
    const result: Record<string, unknown> = {}
    for (const key of ['logs', 'value', 'error']) {
      if (Object.hasOwn(record, key)) result[key] = record[key]
    }
    return { type, sequence, result: parseRemoteCodeResult(result) }
  }
  throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
}

function parseRemoteCodeNext(value: unknown, after: number): RemoteCodeNext {
  const record = remoteCodeRecord(value)
  remoteCodeOnlyKeys(record, ['events', 'cursor', 'done'])
  if (!Object.hasOwn(record, 'events') || !Array.isArray(record.events)
    || !Object.hasOwn(record, 'done') || typeof record.done !== 'boolean') {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
  }
  const events = record.events.map(parseRemoteCodeEvent)
  const cursor = remoteCodeInteger(record, 'cursor')
  let expected = after
  let doneAt = -1
  for (const [index, event] of events.entries()) {
    if (event.sequence !== expected + 1) {
      throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
    }
    expected = event.sequence
    if (event.type === 'done') doneAt = index
  }
  // done:true 必须携带最后一条 done 事件；空批次不能伪造远端已经静默。
  if (cursor !== expected || (record.done ? doneAt < 0 || doneAt !== events.length - 1 : doneAt !== -1)) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote code runtime returned an invalid response')
  }
  return { events, cursor, done: record.done }
}

function remoteCodeFailure(message: string): CodeRunFailure {
  return { kind: 'worker-exit', message }
}

/** 为一次远端 code start 生成可跨重试复用的 agent 幂等键。 */
function remoteCodeStartNonce(): string {
  return randomBytes(16).toString('hex')
}

/** 将本地数值配置转换为远端 wire 所需的正毫秒整数。远端墙钟最多十分钟，超过它的计算预算不会先于墙钟生效。 */
function remoteCodeComputeMs(computeMs: number): number {
  return Math.min(Math.ceil(computeMs), REMOTE_CODE_MAX_TIMEOUT_MS)
}

/**
 * 只有传输层未给出确定 HTTP 结果时，才能拿同一 nonce 重试 start。业务拒绝已
 * 是确定结果，不能误作一次新的创建尝试。
 */
function canRetryRemoteCodeStart(error: unknown): boolean {
  return error instanceof RemoteWorkspaceError
    && (error.code === 'REMOTE_BRIDGE_UNAVAILABLE' || error.code === 'REMOTE_BRIDGE_RESPONSE_INVALID')
}

/** bridge 在 marker 已重绑后对旧 generation 返回的明确拒绝。 */
function isStaleMarkerRejection(error: unknown): boolean {
  return error instanceof RemoteWorkspaceError
    && error.code === 'REMOTE_BRIDGE_REJECTED'
    && error.bridgeCode === 'stale-marker'
}

/** 重试创建前必须证明 marker 仍指向最初派发 start 的同一远端世界。 */
function sameRemoteWorkspaceTarget(left: RemoteWorkspaceTarget, right: RemoteWorkspaceTarget): boolean {
  return left.markerRoot === right.markerRoot
    && left.remoteRoot === right.remoteRoot
    && left.remotePath === right.remotePath
    && left.connectionId === right.connectionId
    && left.markerGeneration === right.markerGeneration
}

/**
 * 已交付的 {@link CodeRuntime} 后端（`ctx.codeRuntime`）。它注册为
 * `codeRuntime` 服务，全部上限都来自已校验配置。隔离模型见模块说明，服务定义
 * 类的 JSDoc 规定本实现的结果字段、敌对端口、跨运行无状态和处置静默合约。
 */
export class WorkerThreadCodeRuntime extends CodeRuntime {
  static Config: z<Config> = z.object({
    computeMs: z.number().default(60_000),
    maxWallMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(67_108_864),
    maxOldGenerationSizeMb: z.number().default(512),
  })

  readonly language = 'typescript'
  readonly isolation = 'worker-thread'

  private readonly config: ResolvedConfig
  private readonly live = new Set<LiveRun>()
  private readonly remoteLive = new Set<LiveRemoteRun>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery 已补齐默认值；断言记录该事实。正数约束不属于 schema 的
    // 普通 number 类型，必须在 provider 注册时复核。
    this.config = config as ResolvedConfig
    for (const [key, value] of Object.entries(this.config)) {
      if (!(Number.isFinite(value) && value > 0)) throw new Error(`dsh-code-runtime-worker-thread: config.${key} must be a positive number, got ${String(value)}`)
    }
    if (!Number.isSafeInteger(this.config.maxOutputBytes) || this.config.maxOutputBytes < MIN_OUTPUT_BYTES) {
      throw new Error(`dsh-code-runtime-worker-thread: config.maxOutputBytes must be a safe integer of at least ${MIN_OUTPUT_BYTES}, got ${String(this.config.maxOutputBytes)}`)
    }
    if (!Number.isSafeInteger(this.config.maxOldGenerationSizeMb)
      || this.config.maxOldGenerationSizeMb > MAX_REMOTE_MEMORY_MIB) {
      throw new Error(`dsh-code-runtime-worker-thread: config.maxOldGenerationSizeMb must be a safe integer from 1 through ${MAX_REMOTE_MEMORY_MIB} MiB, got ${String(this.config.maxOldGenerationSizeMb)}`)
    }
    // maxWallMs reaches setTimeout, which clamps any delay above
    // MAX_TIMER_DELAY_MS to 1 ms; the positivity check above accepts such a
    // value, so a 25-day ceiling would time the run out immediately.
    if (this.config.maxWallMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`dsh-code-runtime-worker-thread: config.maxWallMs must be at most ${MAX_TIMER_DELAY_MS} (Node clamps a longer setTimeout delay to 1ms), got ${String(this.config.maxWallMs)}`)
    }
    ctx.effect(() => () => this.teardown(), 'worker code-runtime teardown')
  }

  /** 将服务置为不可用，令全部运行以 abort 结束并等待本地或远端执行静默。 */
  private async teardown(): Promise<void> {
    this.disposed = true
    const runs = [...this.live]
    const remoteRuns = [...this.remoteLive]
    for (const run of runs) run.settle({ kind: 'abort', message: 'runtime disposed' })
    await Promise.all([
      ...runs.map(run => run.finished),
      ...remoteRuns.map(async (run) => {
        await run.cancel()
        await run.finished
      }),
    ])
  }

  /**
   * 执行一个程序；marker 工作目录会选择远端 Goja，否则使用新的本地 worker。
   * 程序失败（包括未创建 worker 的类型剥离语法错误）写入 `result.error`；只有
   * 已处置运行时或非法 binding namespace 这类服务定义误用才会拒绝。
   * @param request - 程序、bindings 与取消信号。
   * @returns 此次运行的能力接口结果。
   */
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('dsh-code-runtime-worker-thread: run() after disposal')
    const bindings = this.validateBindings(request)
    if (request.signal?.aborted) {
      return this.failureBeforeWorker({ kind: 'abort', message: String(request.signal.reason) })
    }

    let remote: RemoteWorkspaceTarget | undefined
    try {
      remote = await this.remoteWorkspaceForRequest(request)
    } catch {
      return this.failureBeforeWorker(remoteCodeFailure('remote code runtime became unavailable'))
    }
    if (request.signal?.aborted) {
      return this.failureBeforeWorker({ kind: 'abort', message: String(request.signal.reason) })
    }
    if (remote !== undefined) return await this.executeRemote(request, bindings, remote)

    let code: string
    try {
      const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + request.program + STRIP_WRAP.suffix)
      code = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length)
    } catch (error: unknown) {
      // 无法通过类型剥离的程序（语法错误或 enum 等不可擦除语法）属于程序失败，
      // 与抛出异常一样写入结果，且不会创建 worker。
      return this.failureBeforeWorker({ kind: 'exception', message: messageOf(error) })
    }

    return await this.execute(request, code, bindings)
  }

  /** 把 worker 接管前的失败纳入外层输出账本。 */
  private failureBeforeWorker(error: CodeRunFailure): CodeRunResult {
    return new OutputLedger(this.config.maxOutputBytes).failure([], error)
  }

  /**
   * 远端 done 事件的 logs 是权威终态载荷；逐项重放到账本后，远端执行不能越过
   * 本机 Host 的输出配置，也不会把早先的流式 log 重复计入。
   */
  private settleRemoteOutput(result: CodeRunResult): CodeRunResult {
    const output = new OutputLedger(this.config.maxOutputBytes)
    const logs: string[] = []
    for (const log of result.logs) {
      if (!output.admit(log, logs)) return output.limit([...logs, log])
    }
    return result.error === undefined
      ? output.success(logs, result.value)
      : output.failure(logs, result.error)
  }

  /** 为一项远端 HTTP 操作创建可清理的有界 deadline。 */
  private remoteBridgeDeadline(signal: AbortSignal | undefined) {
    return deadline(
      signal,
      Math.min(this.config.maxWallMs, REMOTE_CODE_BRIDGE_TIMEOUT_MS),
      REMOTE_CODE_BRIDGE_TIMEOUT,
    )
  }

  /** 仅当调用方明确给出 marker 工作目录时，才把执行迁移到 Remote-SSH。 */
  private async remoteWorkspaceForRequest(request: CodeRunRequest): Promise<RemoteWorkspaceTarget | undefined> {
    if (request.cwd === undefined) return undefined
    try {
      const workspace = await remoteWorkspacePath('.', request.cwd, request.signal)
      if (workspace === undefined) return undefined
      return {
        markerRoot: workspace.markerRoot,
        remoteRoot: workspace.remoteRoot,
        remotePath: workspace.remotePath,
        connectionId: workspace.connectionId,
        markerGeneration: workspace.markerGeneration,
      }
    } catch (error: unknown) {
      if (request.signal?.aborted) return undefined
      throw new Error(`dsh-code-runtime-worker-thread: cannot resolve remote workspace (${messageOf(error)})`, { cause: error })
    }
  }

  /**
   * 通过 marker bridge 驱动远端 Goja 会话。程序继续在远端执行，绑定调用回到
   * 本机 Node Host，因此工具审批、Session 日志与调度的所有权不发生迁移。
   */
  private async executeRemote(
    request: CodeRunRequest,
    bindings: Map<string, CodeBindingNamespace>,
    workspace: RemoteWorkspaceTarget,
  ): Promise<CodeRunResult> {
    const transport = new AbortController()
    const abortState = new AbortController()
    const finished = Promise.withResolvers<void>()
    const pendingBindings = new Set<Promise<void>>()
    let lastCallId = 0
    let settled = false
    let id: string | undefined
    let ownerTarget: RemoteWorkspaceTarget | undefined
    let cancelPromise: Promise<void> | undefined
    const cancelTransport = async (): Promise<void> => {
      // 当前 long-poll 不能继续占用 caller 的取消路径；远端 cancel 另走
      // 独立 deadline 仍让 agent 结束已确认创建的会话，而不会无限阻塞 dispose。
      transport.abort('remote code runtime canceled')
      const sessionId = id
      if (sessionId === undefined) return
      cancelPromise ??= (async () => {
        const owner = ownerTarget
        let current: RemoteWorkspaceTarget | undefined
        try {
          // 普通清理仍先复验 marker；若 marker 已指向另一连接，绝不向新世界
          // 发送旧 session id，而是只用已发布的 owner 终止旧会话。
          using operation = this.remoteBridgeDeadline(undefined)
          current = await verifyRemoteWorkspaceTarget(workspace, operation.signal)
          if (owner !== undefined && !sameRemoteWorkspaceTarget(owner, current)) {
            await callRemoteWorkspaceBridge(
              owner,
              '/v1/code/cancel',
              'POST',
              { id: sessionId },
              parseRemoteCodeAccepted,
              operation.signal,
              false,
              undefined,
              true,
            )
            return
          }
          await callRemoteWorkspaceBridge(
            current,
            '/v1/code/cancel',
            'POST',
            { id: sessionId },
            parseRemoteCodeAccepted,
            operation.signal,
          )
        } catch (error: unknown) {
          // 已发布的 session 在 marker 失效、重绑、next/reply 传输失败后都必须
          // 尝试回收。若刚才已经向 owner 本身发送 cancel，重复请求没有更多价值。
          if (
            owner === undefined
            || (current !== undefined && sameRemoteWorkspaceTarget(owner, current) && !isStaleMarkerRejection(error))
          ) return
          try {
            using operation = this.remoteBridgeDeadline(undefined)
            await callRemoteWorkspaceBridge(
              owner,
              '/v1/code/cancel',
              'POST',
              { id: sessionId },
              parseRemoteCodeAccepted,
              operation.signal,
              false,
              undefined,
              true,
            )
          } catch {
            // 清理是 best-effort；主路径仍以 fail-closed 终态结束本地运行。
          }
        }
      })()
      await cancelPromise
    }
    const requestAbort = (): void => {
      abortState.abort(request.signal?.reason)
      void cancelTransport()
    }
    const live: LiveRemoteRun = {
      cancel: async () => {
        if (!abortState.signal.aborted) abortState.abort('runtime disposed')
        await cancelTransport()
      },
      finished: finished.promise,
    }
    this.remoteLive.add(live)
    const onAbort = (): void => { requestAbort() }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    // signal 可能在 run() 的上一次检查与 listener 安装之间触发；补一次状态读取
    // 才能保证已取消请求永远不会在远端创建新会话。
    if (request.signal?.aborted) requestAbort()
    const finish = (result: CodeRunResult): CodeRunResult => {
      if (settled) return result
      settled = true
      request.signal?.removeEventListener('abort', onAbort)
      this.remoteLive.delete(live)
      // CodeRuntime 合约把已经调用的 Host binding 交给调用方结算；这里不等待
      // 一个可能永远不返回的 Promise。所有失败和取消路径已中止 transport，故其
      // 后续完成只会被吞掉，绝不会再向远端会话发送 reply。
      finished.resolve()
      return result
    }
    const aborted = (): CodeRunResult => this.failureBeforeWorker({
      kind: 'abort', message: request.signal?.aborted ? String(request.signal.reason) : 'runtime disposed',
    })
    const failed = (): CodeRunResult => this.failureBeforeWorker(remoteCodeFailure('remote code runtime became unavailable'))

    try {
      {
        // start 一旦到达 agent 就会创建独立会话。它不能继承 caller 的取消
        // signal：必须先拿到确定响应（或在限定时间内失败），以便已提交的会话
        // 得到 cancel，而不是成为远端孤儿。
        using operation = this.remoteBridgeDeadline(undefined)
        const startTarget = await verifyRemoteWorkspaceTarget(workspace, operation.signal)
        // marker 复验与 start 之间仍可能发生取消；尚未派发前绝不能创建远端
        // 会话。派发后的取消则必须等 nonce 找回会话 id 后再终止。
        operation.signal.throwIfAborted()
        if (remoteRunWasAborted(abortState.signal)) return finish(aborted())
        const startNonce = remoteCodeStartNonce()
        const startRequest = {
          program: request.program,
          namespaces: [...bindings.values()].map(namespace => ({
            global: namespace.global,
            names: Object.keys(namespace.functions),
            ...namespace.errorClass === undefined ? {} : { errorClass: namespace.errorClass },
          })),
          timeoutMs: Math.min(this.config.maxWallMs, REMOTE_CODE_MAX_TIMEOUT_MS),
          computeMs: remoteCodeComputeMs(this.config.computeMs),
          // 远端每次运行都在受限子进程中执行；沿用本地 worker 的堆上限，避免
          // 模型程序耗尽常驻 Go agent 的内存。
          memoryLimitBytes: this.config.maxOldGenerationSizeMb * BYTES_PER_MIB,
          startNonce,
        }
        for (let attempt = 0; ; attempt += 1) {
          try {
            id = await callRemoteWorkspaceBridge(
              startTarget, '/v1/code/start', 'POST', startRequest, parseRemoteCodeStart,
              operation.signal, true, operation.signal,
            )
            break
          } catch (error: unknown) {
            if (attempt + 1 >= REMOTE_CODE_START_ATTEMPTS || !canRetryRemoteCodeStart(error) || operation.signal.aborted) {
              throw error
            }
            // 同一 nonce 只能向仍被 marker 认证的同一目标重发；重绑后宁可
            // fail-closed，也不能用尚未确认的会话身份控制旧连接。
            const retryTarget = await verifyRemoteWorkspaceTarget(workspace, operation.signal)
            if (!sameRemoteWorkspaceTarget(startTarget, retryTarget)) throw error
          }
        }
        // 仅拿到合法 start 响应后才把该连接升级为可补偿的 owner。
        ownerTarget = startTarget
      }
      if (remoteRunWasAborted(abortState.signal)) {
        await cancelTransport()
        return finish(aborted())
      }

      let after = 0
      for (;;) {
        let next: RemoteCodeNext
        try {
          using operation = this.remoteBridgeDeadline(transport.signal)
          const nextTarget = await verifyRemoteWorkspaceTarget(workspace, operation.signal)
          const owner = ownerTarget
          if (!sameRemoteWorkspaceTarget(owner, nextTarget)) {
            throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote code runtime marker changed after start')
          }
          next = await callRemoteWorkspaceBridge(nextTarget, '/v1/code/next', 'POST', {
            id,
            after,
            waitMs: 25_000,
          }, value => parseRemoteCodeNext(value, after), operation.signal)
        } catch {
          if (remoteRunWasAborted(abortState.signal)) {
            await cancelTransport()
            return finish(aborted())
          }
          await cancelTransport()
          return finish(failed())
        }
        // 一批事件先整体验证再调度：重复或倒退的 callId、超过远端事件槽位
        // 的未回包调用，以及与 pending callback 并存的非可收敛 done，都按敌对协议处理。
        const scheduled: RemoteCodeWireEvent[] = []
        for (const event of next.events) {
          if (event.sequence !== after + 1) {
            await cancelTransport()
            return finish(failed())
          }
          after = event.sequence
          if (event.type === 'tool_call') {
            const callId = event.callId
            if (callId === undefined || callId <= lastCallId
              || pendingBindings.size + scheduled.length >= REMOTE_CODE_MAX_PENDING_BINDINGS) {
              await cancelTransport()
              return finish(failed())
            }
            lastCallId = callId
            scheduled.push(event)
            continue
          }
          if (event.type === 'done') {
            // reply 的 accepted 响应与 next 的终态响应可能同一轮微任务到达，
            // 先让已完成 callback 从集合移除，再判断是否仍有真正未回包调用。
            await Promise.resolve()
            if (event.result === undefined) {
              await cancelTransport()
              return finish(failed())
            }
            const hasPending = scheduled.length > 0 || pendingBindings.size > 0
            if (hasPending && !remoteCodeDoneMayContainPending(event.result)) {
              await cancelTransport()
              return finish(failed())
            }
            if (event.result.error !== undefined) {
              // 远端已经发布终态；尚未派发或仍在本机执行的 binding 不再回传，
              // 避免迟到结果触碰已结束的会话。timeout/abort 也正是唯一允许与
              // pending binding 并存的终态（由上面的 helper 严格限定）。终态已
              // 经确认，不再额外等待 cancel RPC，否则 bridge 失联会拖住合法结果。
              transport.abort('remote code runtime completed')
              pendingBindings.clear()
            }
            return finish(this.settleRemoteOutput(event.result))
          }
        }
        for (const event of scheduled) {
          const owner = ownerTarget
          const dispatch = this.replyRemoteBinding(workspace, owner, id, bindings, event, cancelTransport, transport.signal)
          pendingBindings.add(dispatch)
          void dispatch.finally(() => { pendingBindings.delete(dispatch) }).catch(() => { void cancelTransport() })
        }
        if (next.done) return finish(failed())
        after = next.cursor
        if (remoteRunWasAborted(abortState.signal)) {
          await cancelTransport()
          return finish(aborted())
        }
      }
    } catch {
      if (remoteRunWasAborted(abortState.signal)) {
        await cancelTransport()
        return finish(aborted())
      }
      await cancelTransport()
      return finish(failed())
    }
  }

  /** 在本机执行一项远端程序请求的 binding，并把无损 JSON 结果送回会话。 */
  private async replyRemoteBinding(
    workspace: RemoteWorkspaceTarget,
    owner: RemoteWorkspaceTarget,
    id: string,
    bindings: Map<string, CodeBindingNamespace>,
    event: RemoteCodeWireEvent,
    cancel: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const callId = event.callId
    const global = event.global
    const name = event.name
    if (callId === undefined || global === undefined || name === undefined || event.arguments === undefined) {
      await cancel()
      return
    }
    const fn = bindings.get(global)?.functions
    const binding = fn !== undefined && Object.hasOwn(fn, name) ? fn[name] : undefined
    let body: Record<string, unknown>
    try {
      if (signal.aborted) {
        return
      }
      if (typeof binding !== 'function') {
        body = { id, callId, ok: false, message: `unknown binding ${JSON.stringify(`${global}.${name}`)}` }
      } else {
        const value = remoteCodeJson(await binding(event.arguments))
        if (remoteRunWasAborted(signal)) {
          return
        }
        body = value === undefined
          ? { id, callId, ok: false, message: 'binding resolution must be lossless JSON' }
          : { id, callId, ok: true, value }
      }
    } catch (error: unknown) {
      body = { id, callId, ok: false, message: messageOf(error) }
    }
    try {
      // reply 是普通会话操作，必须在本次发送前复验 marker，绝不回退 owner。
      using operation = this.remoteBridgeDeadline(signal)
      const target = await verifyRemoteWorkspaceTarget(workspace, operation.signal)
      if (!sameRemoteWorkspaceTarget(owner, target)) {
        await cancel()
        return
      }
      operation.signal.throwIfAborted()
      await callRemoteWorkspaceBridge(target, '/v1/code/reply', 'POST', body, parseRemoteCodeAccepted, operation.signal)
    } catch {
      if (signal.aborted) return
      await cancel()
    }
  }

  /** 将畸形 binding global 或类型错误声明按服务定义误用拒绝。 */
  private validateBindings(request: CodeRunRequest): Map<string, CodeBindingNamespace> {
    const bindings = new Map<string, CodeBindingNamespace>()
    for (const namespace of request.bindings) {
      if (!IDENTIFIER.test(namespace.global) || PORTABLE_RESERVED_WORDS.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-worker-thread: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`)
      }
      // RESERVED_BINDING_GLOBALS is the seam's shared backend-owned set:
      // `console` is THIS backend's log-capture slot; the dunder entries exist
      // for the Python side — its seeded/wrapped slots plus the `__debug__`
      // compile-time constant — refused here too so the namespace list stays
      // portable across backends. The seam declaration is the single home for
      // why each entry is reserved.
      if (RESERVED_BINDING_GLOBALS.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-worker-thread: reserved binding global ${JSON.stringify(namespace.global)}`)
      }
      if (bindings.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-worker-thread: duplicate binding global ${JSON.stringify(namespace.global)}`)
      }
      bindings.set(namespace.global, namespace)
    }

    const errorClassNames = new Set<string>()
    for (const namespace of request.bindings) {
      const descriptor = namespace.errorClass
      if (!descriptor) continue
      if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-worker-thread: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-worker-thread: reserved binding global ${JSON.stringify(descriptor.name)}`)
      }
      if (bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-worker-thread: duplicate injected global ${JSON.stringify(descriptor.name)}`)
      }
      const member = descriptor.memberNameProperty
      if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
        throw new Error(`dsh-code-runtime-worker-thread: binding error member property ${JSON.stringify(descriptor.memberNameProperty)} is not usable`)
      }
      errorClassNames.add(descriptor.name)
    }
    return bindings
  }

  /** Spawn the worker for one validated, type-stripped run and drive it to settlement. */
  private execute(
    request: CodeRunRequest,
    code: string,
    bindings: Map<string, CodeBindingNamespace>,
  ): Promise<CodeRunResult> {
    const bootData: WorkerBootData = {
      code,
      namespaces: [...bindings].map(([global, namespace]) => ({
        global,
        names: Object.keys(namespace.functions),
        ...namespace.errorClass ? { errorClass: namespace.errorClass } : {},
      })),
      maxOutputBytes: this.config.maxOutputBytes,
    }
    const worker = new Worker(WORKER_PATH, {
      workerData: bootData,
      // Model code gets NO ambient environment — stronger than the scrubbed
      // env the defensive-patterns rule requires for spawned commands.
      env: {},
      // Hermetic flags too: without this the worker inherits the host process's execArgv (a
      // test runner's or tsx's loader hooks), which a bare isolate with an empty environment
      // cannot satisfy.
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: this.config.maxOldGenerationSizeMb },
      // Backstop capture: the bootstrap patches JS-level writes into its own
      // ordered buffer, so these pipes normally stay silent; anything that
      // still arrives (native-level writes) is appended after the done logs.
      stdout: true,
      stderr: true,
    })

    return new Promise<CodeRunResult>((resolve) => {
      let settled = false
      const answered = new Set<number>()
      const logs: string[] = []
      const strayLogs: string[] = []
      const output = new OutputLedger(this.config.maxOutputBytes)
      let terminalOverride: CodeRunResult | undefined

      // Pipe and message-port delivery are independent. Continue bounded pipe
      // capture after a terminal message while worker termination drains bytes
      // that were already queued; `finish` materializes the result only after
      // termination completes.
      const captureStray = (chunk: Buffer): void => {
        /* v8 ignore next -- a second post-overflow chunk races immediate worker termination; the first overflow path is covered. */
        if (terminalOverride !== undefined) return
        const text = chunk.toString('utf8')
        if (!output.admit(text, strayLogs)) {
          const limited = output.limit([...logs, ...strayLogs, text])
          terminalOverride = limited
          finish(limited)
        }
      }
      worker.stdout.on('data', captureStray)
      worker.stderr.on('data', captureStray)

      // Exactly one outcome wins. Every path cleans up, terminates, and awaits the worker;
      // logs captured before timeout, abort, or failure remain in the result.
      let finishResolve!: () => void
      const finished = new Promise<void>((done) => { finishResolve = done })
      const finish = (finalize: CodeRunResult | (() => CodeRunResult)): void => {
        if (settled) return
        settled = true
        clearInterval(eluTimer)
        clearTimeout(wallTimer)
        request.signal?.removeEventListener('abort', onAbort)
        this.live.delete(live)
        // Let the poll phase deliver pipe bytes already queued independently
        // of the terminal port message before termination closes the streams.
        void new Promise<void>((resume) => { setImmediate(resume) }).then(async () => {
          const stdoutDrained = waitForPipeDrain(worker.stdout)
          const stderrDrained = waitForPipeDrain(worker.stderr)
          await Promise.all([worker.terminate(), stdoutDrained, stderrDrained])
          const result = terminalOverride ?? (typeof finalize === 'function' ? finalize() : finalize)
          finishResolve()
          resolve(result)
        })
      }

      const onDone = (message: WorkerToHost): void => {
        if (message.type !== 'done') return
        if (message.error) {
          const error = message.error
          finish(() => output.failure([...logs, ...strayLogs], error))
          return
        }
        if (message.value === undefined) {
          finish(() => output.success([...logs, ...strayLogs]))
          return
        }
        const value = decodeWorkerJson(message.value)
        if (value === undefined) {
          finish(() => output.failure([...logs, ...strayLogs], { kind: 'invalid-output', message: 'program completion must be lossless JSON' }))
        } else {
          finish(() => output.success([...logs, ...strayLogs], value))
        }
      }

      const onCall = (message: WorkerToHost): void => {
        if (message.type !== 'call' || settled) return
        // Hostile-peer rules: a duplicate id is ignored, an unknown name is
        // answered with a failure, and a binding throw/reject becomes the
        // program-side rejection — contained here, never a host crash.
        if (answered.has(message.id)) return
        answered.add(message.id)
        const reply = (payload: ReplyMessage): void => {
          if (settled) return
          // Canonical resolutions were snapshotted as lossless JSON before
          // this point, so this payload is structured-cloneable by contract.
          worker.postMessage(payload)
        }
        const record = bindings.get(message.global)?.functions
        // Own-property lookup only: a forged name like 'constructor' or
        // 'hasOwnProperty' must not walk the record's prototype chain and
        // reach a callable the consumer never declared.
        const fn = record && Object.hasOwn(record, message.name) ? record[message.name] : undefined
        if (typeof fn !== 'function') {
          reply({ type: 'reply', id: message.id, ok: false, message: `unknown binding ${JSON.stringify(`${message.global}.${message.name}`)}` })
          return
        }
        const args = decodeWorkerJson(message.args)
        if (args === undefined) {
          reply({ type: 'reply', id: message.id, ok: false, message: 'binding arguments must be lossless JSON' })
          return
        }
        void (async () => {
          try {
            const resolved = await fn(args)
            let value: CodeJsonValue | undefined
            try {
              value = snapshotJsonValue(resolved)
            } catch {
              value = undefined
            }
            if (value === undefined) {
              reply({ type: 'reply', id: message.id, ok: false, message: 'binding resolution must be lossless JSON' })
            } else {
              reply({ type: 'reply', id: message.id, ok: true, value: encodeWorkerJson(value) })
            }
          } catch (error: unknown) {
            reply({ type: 'reply', id: message.id, ok: false, message: messageOf(error) })
          }
        })()
      }

      worker.on('message', (raw: unknown) => {
        // Parse before touching: the peer can post ANY shape, and a throw in
        // this listener would crash the host process. Junk drops silently.
        const message = parseWorkerMessage(raw)
        if (!message) return
        if (message.type === 'log' && !settled && !output.admit(message.text, logs)) {
          const limited = output.limit([...logs, ...strayLogs, message.text])
          finish(limited)
          return
        }
        if (message.type === 'output-limit' && !settled) {
          const limited = output.limit([...logs, ...strayLogs])
          finish(limited)
          return
        }
        onCall(message)
        onDone(message)
      })
      worker.on('error', (error: Error) => {
        finish(() => output.failure([...logs, ...strayLogs], { kind: 'worker-exit', message: `worker error: ${error.message}` }))
      })
      worker.on('exit', (exitCode: number) => {
        finish(() => output.failure([...logs, ...strayLogs], { kind: 'worker-exit', message: `worker exited with code ${exitCode} before completing` }))
      })

      // The compute budget reads the worker's own measured busy time, so a
      // hot loop expires it no matter what dispatches are in flight, while a
      // program idling on a slow binding accrues nothing.
      const eluTimer = setInterval(() => {
        const elu = worker.performance.eventLoopUtilization()
        if (elu.active > this.config.computeMs) {
          finish(() => output.failure([...logs, ...strayLogs], { kind: 'timeout', message: `compute budget exhausted (${this.config.computeMs}ms busy)` }))
        }
      }, ELU_POLL_INTERVAL_MS)
      const wallTimer = setTimeout(() => {
        finish(() => output.failure([...logs, ...strayLogs], { kind: 'timeout', message: `wall-clock ceiling reached (${this.config.maxWallMs}ms)` }))
      }, this.config.maxWallMs)
      const onAbort = (): void => {
        finish(() => output.failure([...logs, ...strayLogs], { kind: 'abort', message: String(request.signal?.reason) }))
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const live: LiveRun = {
        worker,
        finished,
        settle: (failure: CodeRunFailure) => { finish(() => output.failure([...logs, ...strayLogs], failure)) },
      }
      this.live.add(live)
    })
  }
}

export default WorkerThreadCodeRuntime
