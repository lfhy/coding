/**
 * Filesystem Service Definition for one execution world. Backends own stable target
 * identity, process paths and file URIs, containment, text reads, decoding,
 * binary rejection, and atomic mutations. Read windows and
 * observed-state policy stay in consumer and policy plugins; `editText`
 * remains here so version check, literal match, and rewrite share one critical
 * section.
 * @module coding-fs
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { FsError } from './types.ts'
import type { SandboxExecutionPolicy, SandboxMode } from 'coding-sandbox'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsObservation,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from './types.ts'

export {
  FsError,
  FsTargetKey,
  FsVersion,
} from './types.ts'
export type {
  FsEditOutcome,
  FsEditRequest,
  FsDirEntry,
  FsErrorCode,
  FsInfo,
  FsObservation,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fs: FileSystem
  }

  interface Events {
    /**
     * Single-slot decision for the next {@link FileSystem.writeText}. Calling
     * `next()` yields the bare provider's unconditional write; the first listener
     * that returns an intent owns the decision rather than composing with peers.
     * @param target - the resolved target about to be written.
     * @param actor - the opaque tool-execution context the decider keys off.
     * @mode waterfall
     */
    'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
    /**
     * Single-slot decision for the next {@link FileSystem.editText}. Calling
     * `next()` yields an unconditional edit; the first returned guard wins.
     * @param target - the resolved target about to be edited.
     * @param actor - the opaque tool-execution context the decider keys off.
     * @mode waterfall
     */
    'fs/edit-intent'(target: FsTarget, actor: object | undefined, next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>
    /**
     * Record an authoritative positive or negative observation. Listeners must
     * be synchronous recorders: throws fail the tool call and returned promises
     * are not awaited.
     * @param target - the target whose presence or absence was observed.
     * @param observation - present with its version, or confirmed absent.
     * @param actor - the observing tool-execution context; undefined records nothing useful.
     * @mode emit
     */
    'fs/observed'(target: FsTarget, observation: FsObservation, actor: object | undefined): void
  }
}

/**
 * Abstract filesystem provider. Targets must preserve identity across aliases;
 * reads expose regular UTF-8 text or typed errors, listings are stable and
 * content-free, and mutations are atomic. Optional guards add stale protection
 * without changing the unguarded provider contract.
 */
export abstract class FileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /**
   * The sandbox mode this backend enforces on mutations BY DEFAULT, or
   * `undefined` when it does not confine at all — the capability fact the tool
   * layer reads to advertise the escalation fields honestly (mirrors
   * `ShellExecutor.sandboxMode`). The base class and the bare local backend
   * report `undefined`; a sandboxing backend (`coding-fs-sandbox`)
   * overrides it with the deployment default. A session override may make the
   * effective mode narrower or wider, so strict escalation widening is checked
   * per call rather than encoded in this default-relative fact.
   * @returns the configured default mode of a sandboxing backend; `undefined`
   *   for a backend that never confines.
   */
  get sandboxMode(): SandboxMode | undefined {
    return undefined
  }

  /**
   * Resolve a model/plugin-supplied path into a stable {@link FsTarget}. May perform I/O (a
   * remote/sandboxed backend may need a round-trip to map a path to a stable identity), hence
   * async even though the local backend only normalizes + realpaths.
   *
   * @param path - the path to resolve; relative paths resolve against `opts.cwd`.
   * @param opts - optional cwd override and cancellation signal.
   * @returns the stable target; the same file yields the same `targetKey`.
   */
  abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>

  /**
   * Return the canonical absolute path a subprocess in this filesystem's
   * execution world can open. The path is deliberately separate from
   * {@link FsTarget.targetKey}: consumers may pass this value to another OS
   * capability, but must continue treating the target key as opaque.
   * @param target - the resolved target whose process path is required.
   * @returns an absolute path in the backend's execution world.
   */
  abstract processPath(target: FsTarget): string

  /**
   * Return the canonical `file:` URI for a target in this filesystem's
   * execution world. Backends own URI encoding because the host platform may
   * differ from the execution platform.
   * @param target - the resolved target to encode.
   * @returns the target's canonical file URI.
   */
  abstract fileUrl(target: FsTarget): string

  /**
   * 在不暴露或解析后端 target key 的前提下判断规范化包含关系；两个目标必须来自
   * 同一提供方。对远端后端，包含关系仍以工作区根为界：后端可以访问根外路径
   * （例如 Remote-SSH 的整台远端主机），但可写围栏与工作区归属仍按根判断。
   * @param parent - 规范化目录目标。
   * @param child - 待判断的规范化目标。
   * @returns `child` 等于 `parent` 或是其后代时为 true。
   */
  abstract contains(parent: FsTarget, child: FsTarget): boolean

  /**
   * Return target metadata, or `undefined` when the target does not exist.
   * @param target - the resolved target to stat.
   * @param signal - aborts the metadata round-trip.
   * @returns metadata only, never content; undefined for an absent target.
   */
  abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>

  /**
   * Return path metadata without following the final path component when it is a
   * symbolic link. This is intentionally path-shaped, not target-shaped:
   * {@link resolve} follows symlinks to produce the stable identity used by
   * normal reads/writes, while `lstat` lets a consumer reject the path itself
   * before that follow happens.
   *
   * `opts.cwd` follows {@link resolve}'s cwd rules. `undefined` means the path is
   * absent.
   * @param path - the path to inspect; relative paths resolve against `opts.cwd`.
   * @param opts - `cwd` overrides the backend's default base for relative paths.
   * @param signal - aborts the metadata round-trip.
   * @returns metadata only, never content; undefined for an absent path.
   */
  abstract lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>

  /**
   * Read the whole regular text file as a single decoded string.
   * @param target - the resolved target to read.
   * @param signal - aborts the read.
   * @returns the full decoded UTF-8 content.
   */
  abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>

  /**
   * Stream the whole regular text file as decoded text chunks (same text
   * semantics as {@link readText}, for large files). The backend owns
   * cross-chunk UTF-8 decoding and binary rejection so the policy layer never
   * touches raw bytes.
   * @param target - the resolved target to read.
   * @param signal - aborts the stream, including between chunks.
   * @returns the chunk iterable, decoded and validated like {@link readText}.
   */
  abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>

  /**
   * Read the whole regular file as raw bytes with no decoding or binary
   * rejection. The bound lives at this seam so a backend can never buffer an
   * unbounded file: a target known or discovered to exceed `maxBytes` fails
   * with `FS_TOO_LARGE` instead of returning a truncated result.
   * @param target - the resolved target to read.
   * @param signal - aborts the read.
   * @param maxBytes - inclusive byte cap on the complete content.
   * @returns the full raw content, at most `maxBytes` long.
   */
  abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>

  /**
   * List direct children of a directory in stable name order. Returns resolved
   * child targets plus cheap metadata only; never reads file contents.
   * @param target - the resolved directory target.
   * @param signal - aborts the listing.
   * @returns one entry per direct child, in stable name order.
   */
  abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>

  /**
   * Atomically create or replace UTF-8 text. `expected` guards intent and
   * staleness; omission allows unconditional overwrite.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root this write
   *   runs under; a sandboxing backend fences the write by it, the bare backend
   *   ignores it. Omit to leave the backend its own default.
   * @returns the outcome, including the version the write produced.
   */
  abstract writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome>

  /**
   * Atomically edit literal text. When supplied, the version guard is checked
   * before matching so stale content reports `FS_STALE_VERSION`; omission edits
   * the current content without a freshness precondition.
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root this edit runs
   *   under; a sandboxing backend fences the edit by it, the bare backend
   *   ignores it. Omit to leave the backend its own default.
   * @returns the outcome, including the version the edit produced.
   */
  abstract editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome>
}

/**
 * 一个执行世界的文件系统后端。十二个原语与 `FileSystem` 相同；额外三项只用于
 * 分派：`id` 是稳定标识，`matches` 在缺少显式绑定时按工作区路径选择后端，
 * `owns` 让同步方法按不透明 target key 找回后端而不做 I/O。
 */
export interface FsProvider {
  /** 后端标识；同一注册表内唯一，用于显式绑定与诊断。 */
  readonly id: string
  /** 该后端默认强制的沙箱模式；`undefined` 表示不做任何围栏。 */
  readonly sandboxMode: SandboxMode | undefined
  /**
   * 判断该后端是否负责这个工作区路径。
   * @param cwd - 会话工作区（绝对路径）。
   * @returns 负责该工作区时为 true。
   */
  matches(cwd: string): boolean | Promise<boolean>
  /**
   * 判断一个不透明 target key 是否由该后端产生。
   * @param targetKey - 后端在 `resolve()` 时写入的身份。
   * @returns 属于该后端时为 true。
   */
  owns(targetKey: string): boolean

  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  processPath(target: FsTarget): string
  fileUrl(target: FsTarget): string
  contains(parent: FsTarget, child: FsTarget): boolean
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
  readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
  writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome>
  editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome>
}

/** 已注册后端；dispose 后注册表不再选择它。 */
interface Registration {
  provider: FsProvider
  /** 无可选后端时优先选择的默认后端。 */
  fallback: boolean
  dispose(): void
}

/**
 * `ctx.fs` 的分派实现。异步原语按 `opts.cwd` 选择后端：显式工作区绑定优先，
 * 其次是后端自己的 `matches(cwd)`，最后使用显式标记的回退后端，再回退到最近注册的后端；
 * 同步原语按 `owns(targetKey)` 找回后端。
 * 后端注册是 effect：注册返回 disposer，随宿主 fiber 卸载撤销。
 */
export class FsRegistry extends FileSystem {
  private readonly registrations: Registration[] = []
  private readonly bindings = new Map<string, string>()

  /**
   * 注册一个后端。
   * @param provider - 后端实现。
   * @param options - `fallback: true` 把该后端标记为无 cwd 或无匹配时的默认后端；
   *   同一注册表最多只能有一个回退后端。
   * @returns 撤销该注册的 disposer；重复调用无副作用。
   * @throws {FsError} 当同一 id 已注册、或第二个后端要求默认身份时。
   */
  register(provider: FsProvider, options: { fallback?: boolean } = {}): () => void {
    if (provider.id === '') throw new FsError('filesystem backend id must be non-empty', 'FS_IO_ERROR')
    if (this.registrations.some(registration => registration.provider.id === provider.id)) {
      throw new FsError(`filesystem backend "${provider.id}" is already registered`, 'FS_IO_ERROR')
    }
    if (options.fallback === true && this.registrations.some(registration => registration.fallback)) {
      throw new FsError('a filesystem backend is already marked as the fallback', 'FS_IO_ERROR')
    }
    const registration: Registration = {
      provider,
      fallback: options.fallback === true,
      dispose: () => {
        const index = this.registrations.indexOf(registration)
        if (index >= 0) this.registrations.splice(index, 1)
        for (const [cwd, id] of this.bindings) {
          if (id === provider.id) this.bindings.delete(cwd)
        }
      },
    }
    this.registrations.push(registration)
    return () => { registration.dispose() }
  }

  /**
   * 记录一个工作区到后端的显式绑定；工作区创建与恢复时写入。
   * @param cwd - 工作区绝对路径。
   * @param backendId - 已注册的后端 id。
   * @returns 撤销该绑定的 disposer。
   * @throws {FsError} 当后端尚未注册时。
   */
  bind(cwd: string, backendId: string): () => void {
    if (!this.registrations.some(registration => registration.provider.id === backendId)) {
      throw new FsError(`filesystem backend "${backendId}" is not registered`, 'FS_IO_ERROR')
    }
    this.bindings.set(cwd, backendId)
    return () => {
      if (this.bindings.get(cwd) === backendId) this.bindings.delete(cwd)
    }
  }

  /** 当前已注册的后端 id，按注册顺序返回。 */
  get backends(): readonly string[] {
    return this.registrations.map(registration => registration.provider.id)
  }

  /**
   * 部署级沙箱模式：取第一个声明了模式的后端（后注册优先）。普通后端不围栏、
   * 返回 `undefined`，因此包了沙箱装饰器的后端总会胜出，分派本身不改变这个事实。
   */
  override get sandboxMode(): SandboxMode | undefined {
    for (const registration of [...this.registrations].reverse()) {
      const mode = registration.provider.sandboxMode
      if (mode !== undefined) return mode
    }
    return undefined
  }

  /**
   * 按工作区选择后端。
   * @param cwd - 会话工作区；缺省时使用显式标记的回退后端（若已注册），否则使用最近注册的后端。
   * @returns 负责该工作区的后端。
   * @throws {FsError} 没有注册任何后端时。
   */
  private async backendForWorkspace(cwd: string | undefined): Promise<FsProvider> {
    if (cwd !== undefined) {
      const bound = this.bindings.get(cwd)
      if (bound !== undefined) {
        const provider = this.registrations.find(registration => registration.provider.id === bound)
        if (provider !== undefined) return provider.provider
      }
      // 后注册的后端优先参与匹配，便于在通用后端之后追加专用后端（远端、只读视图）。
      for (const registration of [...this.registrations].reverse()) {
        if (await registration.provider.matches(cwd)) return registration.provider
      }
    }
    const fallback = this.registrations.find(registration => registration.fallback) ?? this.registrations.at(-1)
    if (fallback === undefined) throw new FsError('no filesystem backend is registered', 'FS_IO_ERROR')
    return fallback.provider
  }

  /**
   * 按不透明 target key 选择后端；同步方法只走这一步。
   * @param targetKey - 后端在 resolve 时写入的身份。
   * @returns 产生该目标的后端；若没有后端拥有该 key，则优先返回显式标记的回退后端，再回退到最近注册的后端。
   * @throws {FsError} 没有注册任何后端时。
   */
  private backendForTarget(targetKey: string): FsProvider {
    const owner = [...this.registrations].reverse().find(registration => registration.provider.owns(targetKey))
    if (owner !== undefined) return owner.provider
    const fallback = this.registrations.find(registration => registration.fallback) ?? this.registrations.at(-1)
    if (fallback === undefined) throw new FsError('no filesystem backend is registered', 'FS_IO_ERROR')
    return fallback.provider
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return await (await this.backendForWorkspace(opts?.cwd)).resolve(path, opts)
  }

  override processPath(target: FsTarget): string {
    return this.backendForTarget(String(target.targetKey)).processPath(target)
  }

  override fileUrl(target: FsTarget): string {
    return this.backendForTarget(String(target.targetKey)).fileUrl(target)
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return this.backendForTarget(String(parent.targetKey)).contains(parent, child)
  }

  override stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.backendForTarget(String(target.targetKey)).stat(target, signal)
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return await (await this.backendForWorkspace(opts?.cwd)).lstat(path, opts, signal)
  }

  override readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.backendForTarget(String(target.targetKey)).readText(target, signal)
  }

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return this.backendForTarget(String(target.targetKey)).streamText(target, signal)
  }

  override readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return this.backendForTarget(String(target.targetKey)).readBytes(target, signal, maxBytes)
  }

  override listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return this.backendForTarget(String(target.targetKey)).listDir(target, signal)
  }

  override writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return this.backendForTarget(String(target.targetKey))
      .writeText(target, content, expected, signal, sandboxPolicy)
  }

  override editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return this.backendForTarget(String(target.targetKey)).editText(target, edit, expected, signal, sandboxPolicy)
  }
}


export default FileSystem
