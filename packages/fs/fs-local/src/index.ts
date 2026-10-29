/**
 * Host-filesystem implementation of `ctx.fs`. Realpath-derived target identity makes aliases
 * share stale guards, and writes through a symlink update its target without replacing the link.
 * @module coding-fs-local
 */

import { Context } from '@deepseek-ai/cordis'
import { constants as bufferConstants } from 'node:buffer'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsVersion } from 'coding-fs'
import { RemoteWorkspaceRouter, awaitMetadataProbe } from './remote.ts'
import type {
  FsDirEntry,
  FsProvider,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from 'coding-fs'
import {
  applyLiteralEdit,
  listDirectory,
  normalizeLineEndings,
  probe,
  probeNoFollow,
  readForEdit,
  readTextForDiff,
  readWholeBytes,
  readWholeText,
  resolveLocalTarget,
  restoreLineEndings,
  streamWholeText,
  writeFileAtomic,
} from './fsio.ts'
import type { FsIoInternals } from './fsio.ts'

/** Configuration for the local filesystem backend. */
export interface Config {
  /** Base directory for relative paths. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * Exclusive UTF-8 byte limit on each overwrite-diff side, capped by the
   * runtime's safe allocation/decode maximum. Defaults to 10 MiB.
   */
  diffBasisMaxBytes?: number
}

type ResolvedConfig = Required<Config>
const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024
const MAX_DIFF_BASIS_BYTES = Math.min(
  bufferConstants.MAX_LENGTH,
  bufferConstants.MAX_STRING_LENGTH,
)

/**
 * The host-filesystem backend. Reads resolve relative paths from {@link Config.cwd}
 * (a resolution default, NOT a containment boundary — see the filesystem
 * capability-seam design record); enforce
 * containment with a stricter backend or a `tools/execute` permission plugin.
 */
export class LocalFileSystemBackend implements FsProvider {
  static Config: z<Config> = z.object({
    cwd: z.string().default(process.cwd()),
    diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
  })

  /** 本地后端的稳定标识。 */
  readonly id = 'local'

  /** 本地后端不自行施加部署级围栏；围栏由 `coding-fs-sandbox` 负责。 */
  get sandboxMode(): undefined { return undefined }

  /** 本地后端是兜底后端：任何工作区都可以由它处理。 */
  matches(): boolean { return true }

  /** 本地目标都不带远端前缀，因此后端自己拥有全部剩余 target。 */
  owns(): boolean { return true }

  /** Validated config (schemastery applied the defaults before construction). */
  readonly config: ResolvedConfig
  /** 远端 marker 路由；本地路径不经过它。 */
  private readonly remoteRouter: RemoteWorkspaceRouter
  /** Test hook forwarded to fsio for atomic-publication boundaries. */
  internals: FsIoInternals = {}
  /** Per-targetKey tail promise: serializes mutating ops so the read→guard→write
   * window can't interleave, making concurrent writes/edits deterministically
   * ordered (one wins, the rest see the new version and reject as stale). */
  /** 每目标的锁链；测试用它断言临界区是否释放。 */
  readonly locks = new Map<string, Promise<unknown>>()

  constructor(config: Config) {
    const resolved = config as ResolvedConfig
    if (!Number.isSafeInteger(resolved.diffBasisMaxBytes)
      || resolved.diffBasisMaxBytes <= 0
      || resolved.diffBasisMaxBytes > MAX_DIFF_BASIS_BYTES) {
      throw new Error(`fs-local: diffBasisMaxBytes must be a positive safe integer no greater than ${MAX_DIFF_BASIS_BYTES}`)
    }
    this.config = resolved
    this.remoteRouter = new RemoteWorkspaceRouter()
  }

  /** Run `op` with exclusive access to `targetKey` (FIFO per key). */
  private async withLock<T>(targetKey: string, op: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(op, op)
    // Keep the chain alive but swallow this op's result/throw for the *next* waiter.
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) {
        this.locks.delete(targetKey)
      }
    }
  }

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const cwd = opts?.cwd ?? this.config.cwd
    const remote = await this.remoteRouter.tryResolve(path, { cwd, signal: opts?.signal })
    if (remote !== undefined) {
      if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
      return remote
    }
    const local = await resolveLocalTarget(cwd, path)
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    return { targetKey: local.targetKey, displayPath: local.displayPath }
  }

  processPath(target: FsTarget): string {
    if (this.remoteRouter.owns(String(target.targetKey))) return this.remoteRouter.processPath(target)
    return String(target.targetKey)
  }

  fileUrl(target: FsTarget): string {
    if (this.remoteRouter.owns(String(target.targetKey))) return this.remoteRouter.fileUrl(target)
    return pathToFileURL(this.processPath(target)).href
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    if (this.remoteRouter.owns(String(parent.targetKey)) || this.remoteRouter.owns(String(child.targetKey))) {
      return this.remoteRouter.contains(parent, child)
    }
    const path = relative(this.processPath(parent), this.processPath(child))
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    if (this.remoteRouter.owns(String(target.targetKey))) return await this.remoteRouter.stat(target, signal)
    const info = await awaitMetadataProbe(() => probe(target.targetKey), signal, 'stat')
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const cwd = opts?.cwd ?? this.config.cwd
    const remote = await this.remoteRouter.tryLstat(path, { cwd }, signal)
    if (remote !== undefined) {
      if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
      return remote
    }
    const info = await awaitMetadataProbe(() => probeNoFollow(resolve(cwd, path)), signal, 'lstat')
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    if (this.remoteRouter.owns(String(target.targetKey))) return await this.remoteRouter.readText(target, signal)
    return readWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
  }

  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (this.remoteRouter.owns(String(target.targetKey))) return this.remoteRouter.streamText(target, signal)
    return Promise.resolve(streamWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal))
  }

  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (this.remoteRouter.owns(String(target.targetKey))) return await this.remoteRouter.readBytes(target, signal, maxBytes)
    return readWholeBytes({ displayPath: target.displayPath, targetKey: target.targetKey }, signal, maxBytes, this.internals)
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    if (this.remoteRouter.owns(String(target.targetKey))) return await this.remoteRouter.listDir(target, signal)
    const entries = await listDirectory({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
    return entries.map(entry => ({
      name: entry.name,
      type: entry.type,
      target: { targetKey: entry.target.targetKey, displayPath: entry.target.displayPath },
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {}),
    }))
  }

  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(target.targetKey, async () => {
      if (this.remoteRouter.owns(String(target.targetKey))) {
        if (signal?.aborted) throw new FsError('write aborted', 'FS_ABORTED')
        return await this.remoteRouter.writeText(target, content, expected, signal)
      }
      const existing = await probe(target.targetKey)
      if (existing && existing.type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }

      if (expected?.kind === 'replaceIfVersion') {
        // Stale guard: the file must still exist at the version the owner observed.
        if (!existing) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (existing.version !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing) {
        // createIfAbsent onto an existing file: a blind overwrite — require a read first.
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      // No expectation means an unconditional but still atomic write.

      // Capture an optional contextual-diff basis before the write. The bounded
      // reader checks the opened file itself, so an external replacement after
      // `probe()` cannot turn this best-effort presentation read into an
      // unbounded allocation. Either side at/above the configured limit yields
      // `before: null`; consumers retain their whole-file fallback.
      const diffable = existing !== null
        && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes
      const before = diffable
        ? await readTextForDiff(target.targetKey, this.config.diffBasisMaxBytes, signal)
        : null
      await writeFileAtomic(
        target.targetKey,
        content,
        existing?.mode,
        signal,
        this.internals,
        expected?.kind === 'createIfAbsent' ? { displayPath: target.displayPath } : undefined,
      )
      const after = await probe(target.targetKey)
      return {
        operation: existing ? 'update' : 'create',
        version: this.versionAfterWrite(after, target),
        before,
        // LF-normalized to share the diff basis with `before` (also LF): a CRLF
        // overwrite must not read as every line changed. Line-ending restoration
        // is a storage detail the applied-hunk diff ignores.
        after: normalizeLineEndings(content),
      }
    })
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(target.targetKey, async () => {
      if (this.remoteRouter.owns(String(target.targetKey))) {
        if (signal?.aborted) throw new FsError('edit aborted', 'FS_ABORTED')
        return await this.remoteRouter.editText(target, edit, expected, signal)
      }
      const existing = await probe(target.targetKey)
      // Stale guard before literal matching: an edit based on an old read reports
      // FS_STALE_VERSION, not FS_EDIT_NOT_FOUND/FS_AMBIGUOUS_EDIT against newer content.
      // Missing targets use the same stale code on guarded and unconditional edit paths.
      if (!existing) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      if (existing.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      // expected === undefined: unconditional edit of the current content — no
      // version guard. Still inside the per-target lock, so the read→match→write
      // window is serialized and atomic.
      if (expected && existing.version !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }

      const original = await readForEdit(target.targetKey, target.displayPath, signal)
      const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
      const content = restoreLineEndings(edited.content, original.lineEndings)
      await writeFileAtomic(target.targetKey, content, existing.mode, signal, this.internals)

      const after = await probe(target.targetKey)
      return {
        version: this.versionAfterWrite(after, target),
        // The LF-normalized before/after text (the applied-hunk diff basis);
        // line-ending restoration is a storage detail the diff ignores.
        before: original.content,
        after: edited.content,
      }
    })
  }

  /* v8 ignore next 5 -- the post-write probe finding the file absent requires a
   * concurrent unlink between rename and stat; fall back to a sentinel version. */
  private versionAfterWrite(after: { version: FsVersion } | null, target: FsTarget): FsVersion {
    if (after) return after.version
    return FsVersion(`missing:${target.targetKey}`)
  }
}

/**
 * `ctx.fs` 的本地服务入口：保留单后端部署与既有测试的用法，内部委托给
 * {@link LocalFileSystemBackend}。多后端装配直接注册 backend，不经过这里。
 */
export class LocalFileSystem extends FileSystem {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    cwd: z.string().default(process.cwd()),
    diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
  })

  /** 单后端部署的本地实现；多后端装配直接注册它。 */
  readonly backend: LocalFileSystemBackend

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.backend = new LocalFileSystemBackend(config)
  }

  /** 校验后的配置（schemastery 已在构造前填入默认值）。 */
  get config(): ResolvedConfig { return this.backend.config }

  /** 测试用：当前的 per-target 锁。 */
  get locks(): Map<string, Promise<unknown>> { return this.backend.locks }

  /** 测试钩子转发给本地后端。 */
  get internals(): FsIoInternals { return this.backend.internals }

  set internals(value: FsIoInternals) { this.backend.internals = value }

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    // 虚拟前缀（例如随包内置技能的资源目录）先展开成真实目标，展示路径保持前缀形式。
    const alias = this.expandPathAlias(path)
    if (alias === undefined) return await this.backend.resolve(path, opts)
    const resolved = await this.backend.resolve(alias.target, opts)
    return { targetKey: resolved.targetKey, displayPath: alias.displayPath }
  }

  processPath(target: FsTarget): string { return this.backend.processPath(target) }

  fileUrl(target: FsTarget): string { return this.backend.fileUrl(target) }

  contains(parent: FsTarget, child: FsTarget): boolean { return this.backend.contains(parent, child) }

  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.backend.stat(target, signal)
  }

  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    // 虚拟前缀先展开成真实目录里的路径，no-follow 探测只看真实位置。
    return this.backend.lstat(this.expandPathAlias(path)?.target ?? path, opts, signal)
  }

  readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.backend.readText(target, signal)
  }

  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return this.backend.streamText(target, signal)
  }

  readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return this.backend.readBytes(target, signal, maxBytes)
  }

  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return this.backend.listDir(target, signal)
  }

  writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.backend.writeText(target, content, expected, signal)
  }

  editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.backend.editText(target, edit, expected, signal)
  }
}

export { RemoteWorkspaceRouter } from './remote.ts'

export default LocalFileSystem
