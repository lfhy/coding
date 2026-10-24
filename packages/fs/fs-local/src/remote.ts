/**
 * Remote-SSH 路由：把本地占位目录与远端绝对路径映射到已认证 bridge 请求，
 * 并统一 bridge 响应的校验与错误分类。远端工作区可以访问整台远端主机。
 * @module coding-fs-local/remote
 */

import { isAbsolute } from 'node:path'
import {
  callRemoteWorkspaceBridge,
  isRemoteWorkspaceTargetKey,
  remoteWorkspaceTargetKey,
  isRemoteAbsolutePath,
  isRemotePathWithin,
  parseRemoteWorkspaceTargetKey,
  remoteWorkspacePath,
  resolveRemotePathAgainst,
  verifyRemoteWorkspaceTarget,
  RemoteWorkspaceError,
} from 'coding-subprocess'
import type { RemoteWorkspacePath, RemoteWorkspaceTarget } from 'coding-subprocess'
import { FsError, FsTargetKey, FsVersion as version_ } from 'coding-fs'
import { applyLiteralEdit, normalizeLineEndings } from './fsio.ts'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsProvider,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from 'coding-fs'

export interface RemotePathInfo {
  path: string
  type: 'file' | 'directory' | 'other' | 'symlink'
  version: string
  size?: number
}

export interface RemoteFileInfo extends Omit<RemotePathInfo, 'type'> {
  type: 'file' | 'directory' | 'other'
}

export function bridgeRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
  }
  return value as Record<string, unknown>
}

export function bridgeString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
  }
  return value
}

export function bridgeInfo(value: unknown): RemoteFileInfo
export function bridgeInfo(value: unknown, allowSymlink: true): RemotePathInfo
export function bridgeInfo(value: unknown, allowSymlink = false): RemotePathInfo {
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

/**
 * 校验 bridge 返回的远端路径。远端工作区可以访问整台远端主机，因此不再要求
 * 落在 workspace 根内；仍拒绝非绝对路径和含 `.`／`..` 片段的路径。
 */
export function bridgeRemotePath(path: string): string {
  if (!isRemoteAbsolutePath(path) || path.replace(/\\/gu, '/').split('/').some(part => part === '.' || part === '..')) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid path')
  }
  return path
}

/** Windows/UNC 远端路径大小写不敏感；POSIX 路径仍按原样比较。 */
export function sameRemotePath(left: string, right: string): boolean {
  return isRemotePathWithin(left, right) && isRemotePathWithin(right, left)
}

/**
 * Node 的 stat/lstat API 不接受 AbortSignal。取消时先向调用方返回统一错误，
 * 底层 probe 的晚到结果仍由 race 注册的处理器消费。
 */
export async function awaitMetadataProbe<T>(
  probeOperation: () => Promise<T>,
  signal: AbortSignal | undefined,
  verb: 'stat' | 'lstat',
): Promise<T> {
  if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
  if (signal === undefined) return await probeOperation()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(new FsError(`${verb} aborted`, 'FS_ABORTED')) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([probeOperation(), aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 将远端 agent 已规范化的路径转换为该执行世界可交给 LSP 的 file URI。不能使用
 * 本机的 pathToFileURL：Remote-SSH 目标可以与 Host 采用不同的平台路径语法。
 */
export function remoteFileUrl(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  const encodePath = (value: string): string => value.split('/').map((part, index) => {
    // Windows 驱动器中的冒号是 file URI 的语法，不是待转义的数据。
    if (index === 0 && /^[A-Za-z]:$/u.test(part)) return part
    return encodeURIComponent(part)
  }).join('/')
  if (normalized.startsWith('//')) {
    const [host, ...parts] = normalized.slice(2).split('/')
    if (host === undefined || host.length === 0 || parts.length === 0) {
      throw new FsError(`cannot create file URI for remote target ${JSON.stringify(path)}`, 'FS_IO_ERROR')
    }
    return `file://${host}/${encodePath(parts.join('/'))}`
  }
  if (/^[A-Za-z]:\//u.test(normalized)) return `file:///${encodePath(normalized)}`
  if (normalized.startsWith('/')) return `file://${encodePath(normalized)}`
  throw new FsError(`cannot create file URI for remote target ${JSON.stringify(path)}`, 'FS_IO_ERROR')
}

export function fsRemoteError(error: unknown, operation: string, displayPath: string): FsError {
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
      case 'sftp-hardlink-unsupported':
        return new FsError(`cannot ${operation} "${displayPath}": atomic create requires the SFTP hardlink extension`, 'FS_IO_ERROR')
      case 'sftp-posix-rename-unsupported':
        return new FsError(`cannot ${operation} "${displayPath}": atomic replacement requires the SFTP posix-rename extension`, 'FS_IO_ERROR')
      default:
        return new FsError(`cannot ${operation} "${displayPath}": remote workspace bridge failed`, 'FS_IO_ERROR')
    }
  }
  return new FsError(`cannot ${operation} "${displayPath}": remote workspace bridge failed`, 'FS_IO_ERROR')
}

/** 将远端完整读响应适配为一次性 AsyncIterable，保留 streamText 的返回契约。 */
export function singleTextChunk(content: string): AsyncIterable<string> {
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

/** 远端单次读取的字节上限。 */
export const REMOTE_READ_MAX_BYTES = 16 * 1024 * 1024

export const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

export function bridgeBytes(record: Record<string, unknown>, maxBytes: number): Uint8Array {
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


/** marker 路由的拥有者；`LocalFileSystem` 把远端分支委托给它。 */
export class RemoteWorkspaceRouter implements FsProvider {
  /** 远端后端的稳定标识。 */
  readonly id = 'remote-workspace'

  /** 远端后端不自行施加部署级围栏；围栏由 `coding-fs-sandbox` 负责。 */
  get sandboxMode(): undefined { return undefined }

  /**
   * 判断工作区是否落在某个 marker 占位目录内。
   * @param cwd - 会话工作区路径。
   * @returns 存在 marker 时为 true。
   */
  async matches(cwd: string): Promise<boolean> {
    return await remoteWorkspacePath('.', cwd) !== undefined
  }

  /**
   * 判断不透明目标是否由远端 marker 产生；只做前缀判定，不做 I/O。
   * @param targetKey - 后端在 resolve 时写入的身份。
   * @returns 属于远端目标时为 true。
   */
  owns(targetKey: string): boolean {
    return isRemoteWorkspaceTargetKey(targetKey)
  }

  /** 将一个本地调用路径识别为 marker 工作区；普通本地路径保持原有流程。 */
  async workspaceFor(
    path: string,
    cwd: string,
    signal: AbortSignal | undefined,
    operation: string,
  ): Promise<RemoteWorkspacePath | undefined> {
    try {
      const workspace = await remoteWorkspacePath('.', cwd, signal)
      if (workspace === undefined) return await remoteWorkspacePath(path, cwd, signal)
      const sameWorkspace = (candidate: RemoteWorkspacePath): boolean => candidate.markerRoot === workspace.markerRoot
        && candidate.remoteRoot === workspace.remoteRoot && candidate.connectionId === workspace.connectionId
        && candidate.markerGeneration === workspace.markerGeneration && candidate.mode === workspace.mode
      if (isAbsolute(path)) {
        // 宿主绝对路径先按本地语义解析：仍落在同一 marker 内时沿用占位目录映射。
        const localAbsolute = await remoteWorkspacePath(path, cwd, signal)
        if (localAbsolute !== undefined && sameWorkspace(localAbsolute)) return localAbsolute
      }
      // 远端工作区可以访问整台远端主机：绝对路径按远端路径解释，`c:\` 与 UNC
      // 形式在非 Windows 宿主上也一样。
      if (isRemoteAbsolutePath(path)) return { ...workspace, remotePath: path }
      const mapped = await remoteWorkspacePath(path, cwd, signal)
      if (mapped !== undefined) {
        // 落到另一个 marker 的路径属于另一条 SSH 工作区，不能借用当前连接。
        if (sameWorkspace(mapped)) return mapped
        throw new FsError(`cannot ${operation} "${path}": path is outside the remote workspace`, 'FS_NOT_FOUND')
      }
      // 相对路径按远端根解析，因此 `../x` 指向远端父目录，而不是本地占位目录的父目录。
      return { ...workspace, remotePath: resolveRemotePathAgainst(workspace.remoteRoot, path) }
    } catch (error: unknown) {
      throw fsRemoteError(error, operation, path)
    }
  }

  /** 每次远端 I/O 前复核 targetKey 的 marker，避免连接切换后复用旧 target。 */
  async verifyTarget(
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
  async resolveWorkspace(workspace: RemoteWorkspacePath, signal: AbortSignal | undefined): Promise<RemoteWorkspaceTarget> {
    try {
      const remotePath = await callRemoteWorkspaceBridge(workspace, '/v1/resolve', 'POST', { path: workspace.remotePath }, (value) => {
        const record = bridgeRecord(value)
        const path = bridgeRemotePath(bridgeString(record, 'path'))
        if (record.info !== undefined) {
          const info = bridgeInfo(record.info)
          if (!sameRemotePath(info.path, path)) {
            throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
          }
        }
        return path
      }, signal)
      return {
        markerRoot: workspace.markerRoot,
        remoteRoot: workspace.remoteRoot,
        remotePath,
        connectionId: workspace.connectionId,
        markerGeneration: workspace.markerGeneration,
        mode: workspace.mode,
      }
    } catch (error: unknown) {
      throw fsRemoteError(error, 'resolve', workspace.remotePath)
    }
  }


  /**
   * 解析远端目标；调用方已确认该后端负责这个工作区。
   * @param path - 模型给出的路径。
   * @param opts - cwd 与取消信号。
   * @returns 远端目标身份。
   */
  /**
   * 尝试把路径解析为远端目标；路径不在 marker 工作区内时返回 undefined，
   * 由调用方回退本地后端。
   * @param path - 模型给出的路径。
   * @param opts - cwd 与取消信号。
   * @returns 远端目标，或不在远端工作区时的 undefined。
   */
  async tryResolve(path: string, opts?: { cwd?: string | undefined; signal?: AbortSignal | undefined }): Promise<FsTarget | undefined> {
    const workspace = await this.workspaceFor(path, opts?.cwd ?? process.cwd(), opts?.signal, 'resolve')
    if (workspace === undefined) return undefined
    const target = await this.resolveWorkspace(workspace, opts?.signal)
    return { targetKey: FsTargetKey(remoteWorkspaceTargetKey(target)), displayPath: target.remotePath }
  }

  /** `FsProvider` 契约下的解析：非远端路径视为错误。 */
  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const target = await this.tryResolve(path, opts)
    if (target === undefined) throw new FsError(`cannot resolve "${path}": no remote workspace`, 'FS_NOT_FOUND')
    return target
  }

  /** 远端目标的执行世界路径就是远端绝对路径。 */
  processPath(target: FsTarget): string {
    return this.remoteTargetOrThrow(target, 'processPath').remotePath
  }

  /** 远端目标的 `file:` URI 由远端平台语法编码。 */
  fileUrl(target: FsTarget): string {
    return remoteFileUrl(this.remoteTargetOrThrow(target, 'fileUrl').remotePath)
  }

  /** 同一 marker 身份下按远端路径判断包含关系。 */
  contains(parent: FsTarget, child: FsTarget): boolean {
    const remoteParent = parseRemoteWorkspaceTargetKey(String(parent.targetKey))
    const remoteChild = parseRemoteWorkspaceTargetKey(String(child.targetKey))
    return remoteParent !== undefined && remoteChild !== undefined
      && remoteParent.markerRoot === remoteChild.markerRoot
      && remoteParent.remoteRoot === remoteChild.remoteRoot
      && remoteParent.connectionId === remoteChild.connectionId
      && remoteParent.markerGeneration === remoteChild.markerGeneration
      && remoteParent.mode === remoteChild.mode
      && isRemotePathWithin(remoteParent.remotePath, remoteChild.remotePath)
  }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const remote = await this.verified(target, signal, 'stat')
    try {
      const info = await callRemoteWorkspaceBridge(remote, '/v1/stat', 'POST', { path: remote.remotePath }, (value) => {
        const record = bridgeRecord(value)
        if (record.info === undefined) return undefined
        const response = bridgeInfo(record.info)
        if (!sameRemotePath(bridgeRemotePath(response.path), remote.remotePath)) {
          throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned metadata for a different path')
        }
        return response
      }, signal)
      return info === undefined ? undefined : {
        version: version_(info.version),
        type: info.type,
        ...info.size === undefined ? {} : { size: info.size },
      }
    } catch (error: unknown) {
      throw fsRemoteError(error, 'stat', target.displayPath)
    }
  }

  /**
   * 尝试读取远端路径元数据；不在 marker 工作区内时返回 undefined。
   * @param path - 待检查的路径。
   * @param opts - cwd 覆盖。
   * @param signal - 取消信号。
   * @returns 元数据，或不属于远端工作区时的 undefined。
   */
  async tryLstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const workspace = await this.workspaceFor(path, opts?.cwd ?? process.cwd(), signal, 'lstat')
    if (workspace === undefined) return undefined
    return await this.remoteLstat({ ...workspace }, path, signal)
  }

  /** `FsProvider` 契约下的 lstat：非远端路径视为错误。 */
  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const info = await this.tryLstat(path, opts, signal)
    if (info === undefined) throw new FsError(`cannot lstat "${path}": no remote workspace`, 'FS_NOT_FOUND')
    return info
  }

  private async remoteLstat(workspace: RemoteWorkspacePath, path: string, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const remote = await this.verifyTarget({ targetKey: FsTargetKey(remoteWorkspaceTargetKey(workspace)), displayPath: workspace.remotePath }, signal, 'lstat')
      ?? { ...workspace }
    try {
      const info = await callRemoteWorkspaceBridge(remote, '/v1/stat', 'POST', { path: remote.remotePath, noFollow: true }, (value) => {
        const record = bridgeRecord(value)
        if (record.info === undefined) return undefined
        const response = bridgeInfo(record.info, true)
        if (!sameRemotePath(bridgeRemotePath(response.path), remote.remotePath)) {
          throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned metadata for a different path')
        }
        return response
      }, signal)
      return info === undefined ? undefined : {
        version: version_(info.version),
        type: info.type,
        ...info.size === undefined ? {} : { size: info.size },
      }
    } catch (error: unknown) {
      throw fsRemoteError(error, 'lstat', path)
    }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const remote = await this.verified(target, signal, 'read')
    try {
      return await callRemoteWorkspaceBridge(remote, '/v1/read_file', 'POST', {
        path: remote.remotePath,
        maxBytes: REMOTE_READ_MAX_BYTES,
      }, (value) => {
        const record = bridgeRecord(value)
        const path = bridgeRemotePath(bridgeString(record, 'path'))
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

  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return this.readText(target, signal).then(singleTextChunk)
  }

  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const remote = await this.verified(target, signal, 'read')
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new FsError(`cannot read "${target.displayPath}": maxBytes must be a non-negative safe integer`, 'FS_TOO_LARGE')
    }
    try {
      return await callRemoteWorkspaceBridge(remote, '/v1/read_bytes', 'POST', {
        path: remote.remotePath,
        maxBytes: Math.min(maxBytes, REMOTE_READ_MAX_BYTES),
      }, (value) => {
        const record = bridgeRecord(value)
        const path = bridgeRemotePath(bridgeString(record, 'path'))
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

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const remote = await this.verified(target, signal, 'list')
    try {
      return await callRemoteWorkspaceBridge(remote, '/v1/directories', 'POST', { path: remote.remotePath }, (value) => {
        const record = bridgeRecord(value)
        const path = bridgeRemotePath(bridgeString(record, 'path'))
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
            target: { targetKey: FsTargetKey(remoteWorkspaceTargetKey(child)), displayPath: info.path },
            version: version_(info.version),
            ...info.size === undefined ? {} : { size: info.size },
          }
        })
      }, signal)
    } catch (error: unknown) {
      throw fsRemoteError(error, 'list', target.displayPath)
    }
  }

  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    const remote = await this.verified(target, signal, 'write')
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
        return { operation, version: version_(version), before: record.before, after }
      }, signal, true)
    } catch (error: unknown) {
      throw fsRemoteError(error, 'write', target.displayPath)
    }
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    const remote = await this.verified(target, signal, 'edit')
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
        return { version: version_(version), before, after }
      }, signal, true)
    } catch (error: unknown) {
      throw fsRemoteError(error, 'edit', target.displayPath)
    }
  }

  /** 校验目标属于本后端；注册表只在 owns 成立时调用这里。 */
  private remoteTargetOrThrow(target: FsTarget, operation: string): RemoteWorkspaceTarget {
    const parsed = parseRemoteWorkspaceTargetKey(String(target.targetKey))
    if (parsed === undefined) {
      throw new FsError(`cannot ${operation} "${target.displayPath}": not a remote target`, 'FS_IO_ERROR')
    }
    return parsed
  }

  /** 每次 I/O 前复核 marker；目标不再属于该工作区时按统一错误失败。 */
  private async verified(target: FsTarget, signal: AbortSignal | undefined, operation: string): Promise<RemoteWorkspaceTarget> {
    const parsed = this.remoteTargetOrThrow(target, operation)
    const current = await this.verifyTarget(target, signal, operation)
    return current ?? parsed
  }
}
