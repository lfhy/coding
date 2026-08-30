/**
 * Host-filesystem implementation of `ctx.fs`. Realpath-derived target identity makes aliases
 * share stale guards, and writes through a symlink update its target without replacing the link.
 * @module @deepseek-ai/dsh-fs-local
 */

import { Context } from '@deepseek-ai/cordis'
import { constants as bufferConstants } from 'node:buffer'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  callRemoteWorkspaceBridge,
  isRemoteAbsolutePath,
  isRemotePathWithin,
  parseRemoteWorkspaceTargetKey,
  remoteWorkspacePath,
  remoteWorkspaceTargetKey,
  verifyRemoteWorkspaceTarget,
  RemoteWorkspaceError,
} from '@deepseek-ai/dsh-subprocess'
import type { RemoteWorkspacePath, RemoteWorkspaceTarget } from '@deepseek-ai/dsh-subprocess'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
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
const REMOTE_READ_MAX_BYTES = 16 * 1024 * 1024

interface RemotePathInfo {
  path: string
  type: 'file' | 'directory' | 'other' | 'symlink'
  version: string
  size?: number
}

interface RemoteFileInfo extends Omit<RemotePathInfo, 'type'> {
  type: 'file' | 'directory' | 'other'
}

function bridgeRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
  }
  return value as Record<string, unknown>
}

function bridgeString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
  }
  return value
}

function bridgeInfo(value: unknown): RemoteFileInfo
function bridgeInfo(value: unknown, allowSymlink: true): RemotePathInfo
function bridgeInfo(value: unknown, allowSymlink = false): RemotePathInfo {
  const record = bridgeRecord(value)
  const path = bridgeString(record, 'path')
  const type = bridgeString(record, 'type')
  const version = bridgeString(record, 'version')
  if (path.length === 0 || version.length === 0
    || (type !== 'file' && type !== 'directory' && type !== 'other' && (!allowSymlink || type !== 'symlink'))) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
  }
  let size: number | undefined
  if (record.size !== undefined) {
    if (typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size < 0) {
      throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
    }
    size = record.size
  }
  return { path, type, version, ...size === undefined ? {} : { size } }
}

function bridgePathWithin(workspace: Pick<RemoteWorkspaceTarget, 'remoteRoot'>, path: string): string {
  if (!isRemotePathWithin(workspace.remoteRoot, path)) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned a path outside its marker')
  }
  return path
}

/** Windows/UNC 远端路径大小写不敏感；POSIX 路径仍按原样比较。 */
function sameRemotePath(left: string, right: string): boolean {
  return isRemotePathWithin(left, right) && isRemotePathWithin(right, left)
}

function fsRemoteError(error: unknown, operation: string, displayPath: string): FsError {
  if (error instanceof FsError) return error
  if (error instanceof RemoteWorkspaceError) {
    if (error.code === 'REMOTE_BRIDGE_ABORTED') return new FsError(`${operation} aborted`, 'FS_ABORTED')
    switch (error.bridgeCode) {
      case 'not-found':
        return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND')
      case 'not-directory':
        return new FsError(`cannot ${operation} "${displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
      case 'not-text':
        return new FsError(`cannot ${operation} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
      case 'not-regular-file':
        return new FsError(`cannot ${operation} "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      case 'too-large':
      case 'response-too-large':
        return new FsError(`cannot ${operation} "${displayPath}": file is too large`, 'FS_TOO_LARGE')
      case 'permission-denied':
        return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED')
      case 'stale-version':
        return new FsError(`cannot ${operation} "${displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      case 'not-observed':
        return new FsError(`cannot ${operation} "${displayPath}": observation is required`, 'FS_NOT_OBSERVED')
      case 'ambiguous-edit':
        return new FsError(`cannot ${operation} "${displayPath}": old_string matched more than once`, 'FS_AMBIGUOUS_EDIT')
      case 'edit-not-found':
        return new FsError(`cannot ${operation} "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
      case 'outside-root':
        return new FsError(`cannot ${operation} "${displayPath}": path is outside the remote workspace`, 'FS_PERMISSION_DENIED')
      default:
        return new FsError(`cannot ${operation} "${displayPath}": remote workspace bridge failed`, 'FS_IO_ERROR')
    }
  }
  return new FsError(`cannot ${operation} "${displayPath}": remote workspace bridge failed`, 'FS_IO_ERROR')
}

/** 将远端完整读响应适配为一次性 AsyncIterable，保留 streamText 的返回契约。 */
function singleTextChunk(content: string): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      let delivered = false
      return {
        next: (): Promise<IteratorResult<string>> => {
          if (delivered) return Promise.resolve({ done: true, value: undefined })
          delivered = true
          return Promise.resolve({ done: false, value: content })
        },
      }
    },
  }
}

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

function bridgeBytes(record: Record<string, unknown>, maxBytes: number): Uint8Array {
  const encoded = bridgeString(record, 'contentBase64')
  const maxEncodedLength = Math.ceil(REMOTE_READ_MAX_BYTES / 3) * 4
  if (encoded.length > maxEncodedLength || !CANONICAL_BASE64.test(encoded)) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned invalid base64 content')
  }
  const content = Buffer.from(encoded, 'base64')
  if (content.toString('base64') !== encoded) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned non-canonical base64 content')
  }
  if (content.byteLength > maxBytes || content.byteLength > REMOTE_READ_MAX_BYTES) {
    throw new FsError('remote file exceeds the requested byte limit', 'FS_TOO_LARGE')
  }
  return content
}

/**
 * The host-filesystem backend. Reads resolve relative paths from {@link Config.cwd}
 * (a resolution default, NOT a containment boundary — see the filesystem
 * capability-seam Agent Note); enforce
 * containment with a stricter backend or a `tools/execute` permission plugin.
 */
export class LocalFileSystem extends FileSystem {
  static Config: z<Config> = z.object({
    cwd: z.string().default(process.cwd()),
    diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
  })

  /** Validated config (schemastery applied the defaults before construction). */
  readonly config: ResolvedConfig
  /** Test hook forwarded to fsio for atomic-publication boundaries. */
  internals: FsIoInternals = {}
  /** Per-targetKey tail promise: serializes mutating ops so the read→guard→write
   * window can't interleave, making concurrent writes/edits deterministically
   * ordered (one wins, the rest see the new version and reject as stale). */
  private locks = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = config as ResolvedConfig
    if (!Number.isSafeInteger(resolved.diffBasisMaxBytes)
      || resolved.diffBasisMaxBytes <= 0
      || resolved.diffBasisMaxBytes > MAX_DIFF_BASIS_BYTES) {
      throw new Error(`fs-local: diffBasisMaxBytes must be a positive safe integer no greater than ${MAX_DIFF_BASIS_BYTES}`)
    }
    this.config = resolved
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

  /** 将一个本地调用路径识别为 marker 工作区；普通本地路径保持原有流程。 */
  private async remotePath(
    path: string,
    cwd: string,
    signal: AbortSignal | undefined,
    operation: string,
  ): Promise<RemoteWorkspacePath | undefined> {
    try {
      const workspace = await remoteWorkspacePath('.', cwd, signal)
      if (workspace === undefined) return await remoteWorkspacePath(path, cwd, signal)
      if (isAbsolute(path)) {
        const localAbsolute = await remoteWorkspacePath(path, cwd, signal)
        if (localAbsolute !== undefined && localAbsolute.markerRoot === workspace.markerRoot
          && localAbsolute.remoteRoot === workspace.remoteRoot && localAbsolute.connectionId === workspace.connectionId) {
          return localAbsolute
        }
      }
      // 在 marker 会话中，模型常会复用上次结果里的远端绝对路径（例如
      // str_replace_editor 的绝对 path 参数）。它必须仍受同一 remoteRoot
      // 限制，绝不能因本地解析失败而落回桌面文件系统。
      if (isRemoteAbsolutePath(path) && isRemotePathWithin(workspace.remoteRoot, path)) {
        return { ...workspace, remotePath: path }
      }
      const mapped = await remoteWorkspacePath(path, cwd, signal)
      if (mapped !== undefined && mapped.markerRoot === workspace.markerRoot
        && mapped.remoteRoot === workspace.remoteRoot && mapped.connectionId === workspace.connectionId) {
        return mapped
      }
      throw new FsError(`cannot ${operation} "${path}": path is outside the remote workspace`, 'FS_NOT_FOUND')
    } catch (error: unknown) {
      throw fsRemoteError(error, operation, path)
    }
  }

  /** 每次远端 I/O 前复核 targetKey 的 marker，避免连接切换后复用旧 target。 */
  private async remoteTarget(
    target: FsTarget,
    signal: AbortSignal | undefined,
    operation: string,
  ): Promise<RemoteWorkspaceTarget | undefined> {
    try {
      const parsed = parseRemoteWorkspaceTargetKey(String(target.targetKey))
      return parsed === undefined ? undefined : await verifyRemoteWorkspaceTarget(parsed, signal)
    } catch (error: unknown) {
      throw fsRemoteError(error, operation, target.displayPath)
    }
  }

  /** 向 bridge 解析由 marker 派生的路径，并拒绝 agent 返回 marker 根外的路径。 */
  private async resolveRemotePath(workspace: RemoteWorkspacePath, signal: AbortSignal | undefined): Promise<RemoteWorkspaceTarget> {
    try {
      const remotePath = await callRemoteWorkspaceBridge(workspace, '/v1/resolve', 'POST', { path: workspace.remotePath }, (value) => {
        const record = bridgeRecord(value)
        const path = bridgePathWithin(workspace, bridgeString(record, 'path'))
        if (record.info !== undefined) {
          const info = bridgeInfo(record.info)
          if (!sameRemotePath(info.path, path) || !isRemotePathWithin(workspace.remoteRoot, info.path)) {
            throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
          }
        }
        return path
      }, signal)
      return {
        markerRoot: workspace.markerRoot,
        remoteRoot: workspace.remoteRoot,
        remotePath,
        ...workspace.connectionId === undefined ? {} : { connectionId: workspace.connectionId },
      }
    } catch (error: unknown) {
      throw fsRemoteError(error, 'resolve', workspace.remotePath)
    }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const cwd = opts?.cwd ?? this.config.cwd
    const remote = await this.remotePath(path, cwd, opts?.signal, 'resolve')
    if (remote !== undefined) {
      const target = await this.resolveRemotePath(remote, opts?.signal)
      if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
      return {
        targetKey: FsTargetKey(remoteWorkspaceTargetKey(target)),
        displayPath: target.remotePath,
      }
    }
    const local = await resolveLocalTarget(cwd, path)
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    return { targetKey: local.targetKey, displayPath: local.displayPath }
  }

  override processPath(target: FsTarget): string {
    try {
      const remote = parseRemoteWorkspaceTargetKey(String(target.targetKey))
      if (remote !== undefined) {
        throw new FsError(`cannot expose remote target "${target.displayPath}" to a local process`, 'FS_IO_ERROR')
      }
    } catch (error: unknown) {
      if (error instanceof FsError) throw error
      throw new FsError(`cannot expose target "${target.displayPath}" to a local process`, 'FS_IO_ERROR', { cause: error })
    }
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const remoteParent = parseRemoteWorkspaceTargetKey(String(parent.targetKey))
    const remoteChild = parseRemoteWorkspaceTargetKey(String(child.targetKey))
    if (remoteParent !== undefined || remoteChild !== undefined) {
      return remoteParent !== undefined && remoteChild !== undefined
        && remoteParent.markerRoot === remoteChild.markerRoot
        && remoteParent.remoteRoot === remoteChild.remoteRoot
        && remoteParent.connectionId === remoteChild.connectionId
        && isRemotePathWithin(remoteParent.remotePath, remoteChild.remotePath)
    }
    const path = relative(this.processPath(parent), this.processPath(child))
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    const remote = await this.remoteTarget(target, signal, 'stat')
    if (remote !== undefined) {
      try {
        const info = await callRemoteWorkspaceBridge(remote, '/v1/stat', 'POST', { path: remote.remotePath }, (value) => {
          const record = bridgeRecord(value)
          if (record.info === undefined) return undefined
          const response = bridgeInfo(record.info)
          if (!sameRemotePath(bridgePathWithin(remote, response.path), remote.remotePath)) {
            throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned metadata for a different path')
          }
          return response
        }, signal)
        if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
        return info === undefined ? undefined : {
          version: FsVersion(info.version),
          type: info.type,
          ...info.size === undefined ? {} : { size: info.size },
        }
      } catch (error: unknown) {
        throw fsRemoteError(error, 'stat', target.displayPath)
      }
    }
    const info = await probe(target.targetKey)
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const cwd = opts?.cwd ?? this.config.cwd
    const remote = await this.remotePath(path, cwd, signal, 'lstat')
    if (remote !== undefined) {
      try {
        const info = await callRemoteWorkspaceBridge(remote, '/v1/stat', 'POST', { path: remote.remotePath, noFollow: true }, (value) => {
          const record = bridgeRecord(value)
          if (record.info === undefined) return undefined
          const response = bridgeInfo(record.info, true)
          if (!sameRemotePath(bridgePathWithin(remote, response.path), remote.remotePath)) {
            throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned metadata for a different path')
          }
          return response
        }, signal)
        if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
        return info === undefined ? undefined : {
          version: FsVersion(info.version),
          type: info.type,
          ...info.size === undefined ? {} : { size: info.size },
        }
      } catch (error: unknown) {
        throw fsRemoteError(error, 'lstat', path)
      }
    }
    const info = await probeNoFollow(resolve(cwd, path))
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const remote = await this.remoteTarget(target, signal, 'read')
    if (remote !== undefined) {
      try {
        return await callRemoteWorkspaceBridge(remote, '/v1/read_file', 'POST', {
          path: remote.remotePath,
          maxBytes: REMOTE_READ_MAX_BYTES,
        }, (value) => {
          const record = bridgeRecord(value)
          const path = bridgePathWithin(remote, bridgeString(record, 'path'))
          const content = bridgeString(record, 'content')
          const version = bridgeString(record, 'version')
          if (!sameRemotePath(path, remote.remotePath) || version.length === 0) {
            throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
          }
          return content
        }, signal)
      } catch (error: unknown) {
        throw fsRemoteError(error, 'read', target.displayPath)
      }
    }
    return readWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
  }

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const remote = parseRemoteWorkspaceTargetKey(String(target.targetKey))
    if (remote !== undefined) {
      return this.readText(target, signal).then(singleTextChunk)
    }
    return Promise.resolve(streamWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal))
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const remote = await this.remoteTarget(target, signal, 'read')
    if (remote !== undefined) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new FsError(`cannot read "${target.displayPath}": maxBytes must be a non-negative safe integer`, 'FS_TOO_LARGE')
      }
      try {
        return await callRemoteWorkspaceBridge(remote, '/v1/read_bytes', 'POST', {
          path: remote.remotePath,
          maxBytes: Math.min(maxBytes, REMOTE_READ_MAX_BYTES),
        }, (value) => {
          const record = bridgeRecord(value)
          const path = bridgePathWithin(remote, bridgeString(record, 'path'))
          const version = bridgeString(record, 'version')
          if (!sameRemotePath(path, remote.remotePath) || version.length === 0) {
            throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
          }
          return bridgeBytes(record, maxBytes)
        }, signal)
      } catch (error: unknown) {
        throw fsRemoteError(error, 'read', target.displayPath)
      }
    }
    return readWholeBytes({ displayPath: target.displayPath, targetKey: target.targetKey }, signal, maxBytes, this.internals)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const remote = await this.remoteTarget(target, signal, 'list')
    if (remote !== undefined) {
      try {
        return await callRemoteWorkspaceBridge(remote, '/v1/directories', 'POST', { path: remote.remotePath }, (value) => {
          const record = bridgeRecord(value)
          const path = bridgePathWithin(remote, bridgeString(record, 'path'))
          if (!sameRemotePath(path, remote.remotePath) || !Array.isArray(record.entries)) {
            throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
          }
          return record.entries.map((entry): FsDirEntry => {
            const info = bridgeInfo(entry)
            if (!isRemotePathWithin(path, info.path)) {
              throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid directory entry')
            }
            const expectedName = info.path.slice(path.length).replace(/^[\\/]/u, '')
            if (expectedName.length === 0 || expectedName.includes('/') || expectedName.includes('\\') || bridgeString(bridgeRecord(entry), 'name') !== expectedName) {
              throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid directory entry')
            }
            const child: RemoteWorkspaceTarget = { ...remote, remotePath: info.path }
            return {
              name: expectedName,
              type: info.type,
              target: {
                targetKey: FsTargetKey(remoteWorkspaceTargetKey(child)),
                displayPath: info.path,
              },
              version: FsVersion(info.version),
              ...info.size === undefined ? {} : { size: info.size },
            }
          })
        }, signal)
      } catch (error: unknown) {
        throw fsRemoteError(error, 'list', target.displayPath)
      }
    }
    const entries = await listDirectory({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
    return entries.map(entry => ({
      name: entry.name,
      type: entry.type,
      target: { targetKey: entry.target.targetKey, displayPath: entry.target.displayPath },
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {}),
    }))
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(target.targetKey, async () => {
      const remote = await this.remoteTarget(target, signal, 'write')
      if (remote !== undefined) {
        if (signal?.aborted) throw new FsError('write aborted', 'FS_ABORTED')
        try {
          return await callRemoteWorkspaceBridge(remote, '/v1/update_file', 'POST', {
            path: remote.remotePath,
            content,
            ...expected === undefined ? {} : {
              expected: expected.kind === 'createIfAbsent'
                ? { kind: 'createIfAbsent' }
                : { kind: 'replaceIfVersion', version: String(expected.version) },
            },
          }, (value) => {
            const record = bridgeRecord(value)
            const operation = bridgeString(record, 'operation')
            const version = bridgeString(record, 'version')
            const after = bridgeString(record, 'after')
            const expectedAfter = normalizeLineEndings(content)
            if ((operation !== 'create' && operation !== 'update') || version.length === 0
              || (record.before !== null && typeof record.before !== 'string') || after !== expectedAfter
              || (typeof record.before === 'string' && record.before.includes('\r\n'))
              || (operation === 'create' && record.before !== null)
              || (expected?.kind === 'createIfAbsent' && operation !== 'create')
              || (expected?.kind === 'replaceIfVersion' && operation !== 'update')) {
              throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
            }
            return {
              operation,
              version: FsVersion(version),
              before: record.before,
              after,
            }
          }, signal, true)
        } catch (error: unknown) {
          throw fsRemoteError(error, 'write', target.displayPath)
        }
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

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(target.targetKey, async () => {
      const remote = await this.remoteTarget(target, signal, 'edit')
      if (remote !== undefined) {
        if (signal?.aborted) throw new FsError('edit aborted', 'FS_ABORTED')
        try {
          return await callRemoteWorkspaceBridge(remote, '/v1/edit_file', 'POST', {
            path: remote.remotePath,
            oldString: edit.oldString,
            newString: edit.newString,
            replaceAll: edit.replaceAll,
            ...expected === undefined ? {} : { expected: { kind: 'replaceIfVersion', version: String(expected.version) } },
          }, (value) => {
            const record = bridgeRecord(value)
            const version = bridgeString(record, 'version')
            const before = bridgeString(record, 'before')
            const after = bridgeString(record, 'after')
            let expectedAfter: string
            try {
              expectedAfter = applyLiteralEdit(before, edit.oldString, edit.newString, edit.replaceAll, target.displayPath).content
            } catch {
              throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
            }
            if (version.length === 0 || before.includes('\r\n') || after.includes('\r\n') || after !== expectedAfter) {
              throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
            }
            return { version: FsVersion(version), before, after }
          }, signal, true)
        } catch (error: unknown) {
          throw fsRemoteError(error, 'edit', target.displayPath)
        }
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

export default LocalFileSystem
