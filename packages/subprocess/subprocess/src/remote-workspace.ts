/**
 * 桌面端 Remote-SSH 工作区的无凭据 marker 和本地 bridge 调用约定。
 * marker 只把一个本地目录映射到远端根目录；认证 token 只从 Node Host
 * 进程环境读取，绝不写入 marker、目标键或诊断。
 * @module @deepseek-ai/dsh-subprocess/remote-workspace
 */

import { open, realpath, stat } from 'node:fs/promises'
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'

/** Remote-SSH 本地 marker 的固定文件名。 */
export const REMOTE_WORKSPACE_MARKER = '.coding-remote-workspace.json'

/** Node Host 从桌面 bridge 接收的回环地址环境变量。 */
export const REMOTE_BRIDGE_URL_ENV = 'DSH_REMOTE_BRIDGE_URL'

/** Node Host 从桌面 bridge 接收的一次性 bearer token 环境变量。 */
export const REMOTE_BRIDGE_TOKEN_ENV = 'DSH_REMOTE_BRIDGE_TOKEN'

const MARKER_MAX_BYTES = 16 * 1024
const BRIDGE_MAX_RESPONSE_BYTES = 40 * 1024 * 1024
const REMOTE_TARGET_PREFIX = 'coding-remote-target:v1:'
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** marker 解析或 bridge 传输失败的稳定分类。 */
export type RemoteWorkspaceErrorCode =
  | 'REMOTE_WORKSPACE_MARKER_INVALID'
  | 'REMOTE_WORKSPACE_TARGET_INVALID'
  | 'REMOTE_BRIDGE_UNAVAILABLE'
  | 'REMOTE_BRIDGE_REJECTED'
  | 'REMOTE_BRIDGE_RESPONSE_INVALID'
  | 'REMOTE_BRIDGE_ABORTED'

/** Remote-SSH marker/bridge 边界的受控错误，消息不含 token 或 bridge URL。 */
export class RemoteWorkspaceError extends Error {
  constructor(
    readonly code: RemoteWorkspaceErrorCode,
    message: string,
    /** bridge 的机器错误码；只在已验证的失败响应上出现。 */
    readonly bridgeCode?: string,
  ) {
    super(message)
    this.name = 'RemoteWorkspaceError'
  }
}

/** 已验证 marker 的当前身份；connectionId 不是凭据。 */
export interface RemoteWorkspace {
  /** marker 目录的真实本地路径，用于防止伪造 targetKey 跨工作区。 */
  markerRoot: string
  /** marker 声明且由目录选择流程规范化的远端绝对目录。 */
  remoteRoot: string
  /** 多个 SSH 连接共用一个本地 bridge 时的路由 id。 */
  connectionId: string
  /** 与 marker 文件同轮发布的单调 generation。 */
  markerGeneration: number
}

/** 一个从本地 marker 路径映射出的远端路径。 */
export interface RemoteWorkspacePath extends RemoteWorkspace {
  /** 原始调用解析后的绝对本地路径；仅供 marker 边界判断。 */
  localPath: string
  /** 只由 marker 根和本地子路径派生的远端绝对路径。 */
  remotePath: string
}

/** 已验证的无凭据远端执行身份；可编码为 FsTargetKey。 */
export interface RemoteWorkspaceTarget extends RemoteWorkspace {
  /** 已解析并受 remoteRoot 限制的远端路径。 */
  remotePath: string
}

interface MarkerRecord {
  version: 2
  remoteRoot: string
  connectionId: string
  generation: number
}

interface BridgeConfig {
  baseUrl: URL
  token: string
}

/** bridge dispatch 所需的完整 marker 快照；缺少任一字段都不能发起远端请求。 */
type RemoteWorkspaceBridgeTarget = Pick<RemoteWorkspace, 'markerRoot' | 'remoteRoot' | 'connectionId' | 'markerGeneration'>

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RemoteWorkspaceError('REMOTE_BRIDGE_ABORTED', 'remote workspace request was aborted')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function markerInvalid(): never {
  throw new RemoteWorkspaceError('REMOTE_WORKSPACE_MARKER_INVALID', 'remote workspace marker is invalid')
}

/**
 * 判断一条路径是否采用 remote agent 可接受的绝对路径形式。
 * @param value - 待校验的远端路径。
 * @returns 路径采用 POSIX、Windows 驱动器或 UNC 绝对形式时为 true。
 */
export function isRemoteAbsolutePath(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/u.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value)
}

function hasRemoteTraversal(value: string): boolean {
  return value.replace(/\\/gu, '/').split('/').some(part => part === '.' || part === '..')
}

function parseMarker(value: unknown): MarkerRecord {
  const record = asRecord(value)
  if (record === undefined) return markerInvalid()
  const keys = Object.keys(record)
  if (keys.some(key => key !== 'version' && key !== 'remoteRoot' && key !== 'connectionId' && key !== 'generation')) return markerInvalid()
  const generation = record.generation
  if (record.version !== 2 || typeof record.remoteRoot !== 'string' || typeof record.connectionId !== 'string'
    || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation <= 0) return markerInvalid()
  const remoteRoot = record.remoteRoot
  if (remoteRoot.length === 0 || remoteRoot.length > 4096 || remoteRoot !== remoteRoot.trim()
    || remoteRoot.includes('\0') || !isRemoteAbsolutePath(remoteRoot) || hasRemoteTraversal(remoteRoot)) return markerInvalid()
  if (!CONNECTION_ID.test(record.connectionId)) return markerInvalid()
  return { version: 2, remoteRoot, connectionId: record.connectionId, generation }
}

function isMissingMarker(error: unknown): boolean {
  return error instanceof Error && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

async function readMarkerText(marker: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(marker, 'r')
  } catch {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_MARKER_INVALID', 'remote workspace marker cannot be read')
  }
  try {
    const bytes = Buffer.allocUnsafe(MARKER_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0)
    if (bytesRead > MARKER_MAX_BYTES) return markerInvalid()
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
  } catch (error: unknown) {
    if (error instanceof RemoteWorkspaceError) throw error
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_MARKER_INVALID', 'remote workspace marker cannot be read')
  } finally {
    await handle.close().catch(() => {})
  }
}

function readMarkerTextSync(marker: string): string {
  let descriptor: number
  try {
    descriptor = openSync(marker, 'r')
  } catch {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_MARKER_INVALID', 'remote workspace marker cannot be read')
  }
  try {
    const bytes = Buffer.allocUnsafe(MARKER_MAX_BYTES + 1)
    const bytesRead = readSync(descriptor, bytes, 0, bytes.byteLength, 0)
    if (bytesRead > MARKER_MAX_BYTES) return markerInvalid()
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
  } catch (error: unknown) {
    if (error instanceof RemoteWorkspaceError) throw error
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_MARKER_INVALID', 'remote workspace marker cannot be read')
  } finally {
    try {
      closeSync(descriptor)
    } catch {
      // 已读取的 marker 不依赖描述符；关闭失败不能暴露任何 marker 内容。
    }
  }
}

async function markerAt(directory: string, signal?: AbortSignal): Promise<RemoteWorkspace | undefined> {
  abortIfNeeded(signal)
  const marker = join(directory, REMOTE_WORKSPACE_MARKER)
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(marker)
  } catch (error: unknown) {
    if (isMissingMarker(error)) return undefined
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_MARKER_INVALID', 'remote workspace marker cannot be read')
  }
  if (!info.isFile() || info.size > MARKER_MAX_BYTES) return markerInvalid()
  const text = await readMarkerText(marker)
  abortIfNeeded(signal)
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return markerInvalid()
  }
  const record = parseMarker(parsed)
  let markerRoot: string
  try {
    markerRoot = await realpath(directory)
  } catch {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_MARKER_INVALID', 'remote workspace marker directory is unavailable')
  }
  return {
    markerRoot,
    remoteRoot: record.remoteRoot,
    connectionId: record.connectionId,
    markerGeneration: record.generation,
  }
}

/** 后台 Shell 的同步 start 契约所需的有界 marker 读取；不进行任何网络 I/O。 */
function markerAtSync(directory: string): RemoteWorkspace | undefined {
  const marker = join(directory, REMOTE_WORKSPACE_MARKER)
  let info: ReturnType<typeof statSync>
  try {
    info = statSync(marker)
  } catch (error: unknown) {
    if (isMissingMarker(error)) return undefined
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_MARKER_INVALID', 'remote workspace marker cannot be read')
  }
  if (!info.isFile() || info.size > MARKER_MAX_BYTES) return markerInvalid()
  let parsed: unknown
  try {
    parsed = JSON.parse(readMarkerTextSync(marker)) as unknown
  } catch {
    return markerInvalid()
  }
  const record = parseMarker(parsed)
  let markerRoot: string
  try {
    markerRoot = realpathSync(directory)
  } catch {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_MARKER_INVALID', 'remote workspace marker directory is unavailable')
  }
  return {
    markerRoot,
    remoteRoot: record.remoteRoot,
    connectionId: record.connectionId,
    markerGeneration: record.generation,
  }
}

/**
 * 读取一个确定 marker 根目录，供已解析远端 target 在每次 I/O 前复核。
 * @param markerRoot - targetKey 中保存的 canonical marker 根。
 * @param signal - 取消当前 marker 读取。
 * @returns 当前 marker；删除或修改 marker 会拒绝后续远端访问。
 */
export async function readRemoteWorkspaceMarker(markerRoot: string, signal?: AbortSignal): Promise<RemoteWorkspace> {
  if (!isAbsolute(markerRoot)) {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace target is invalid')
  }
  const marker = await markerAt(markerRoot, signal)
  if (marker === undefined || marker.markerRoot !== markerRoot) {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace target no longer has its marker')
  }
  return marker
}

function remoteSeparator(remoteRoot: string): '/' | '\\' {
  return remoteRoot.includes('\\') && !remoteRoot.includes('/') ? '\\' : '/'
}

function joinRemotePath(remoteRoot: string, localRelativePath: string): string {
  if (localRelativePath === '') return remoteRoot
  const parts = localRelativePath.split(sep)
  if (parts.length === 0 || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace path escapes its marker')
  }
  const separator = remoteSeparator(remoteRoot)
  const base = remoteRoot === separator ? remoteRoot : remoteRoot.replace(/[\\/]+$/u, '')
  return `${base}${base.endsWith(separator) ? '' : separator}${parts.join(separator)}`
}

/**
 * 判断远端路径是否在指定根内。该检查是客户端 marker 路由边界，远端服务仍
 * 必须把 SSH 账户权限视为最终执行权限。
 * @param remoteRoot - 已验证的远端工作区根目录。
 * @param candidate - 待判断的远端路径。
 * @returns candidate 在 remoteRoot 内且不含穿越片段时为 true。
 */
export function isRemotePathWithin(remoteRoot: string, candidate: string): boolean {
  if (hasRemoteTraversal(remoteRoot) || hasRemoteTraversal(candidate)) return false
  const root = remoteRoot.replace(/\\/gu, '/').replace(/\/+$/u, '') || '/'
  const path = candidate.replace(/\\/gu, '/').replace(/\/+$/u, '') || '/'
  const caseInsensitive = /^[A-Za-z]:(?:\/|$)/u.test(root) || root.startsWith('//')
  const left = caseInsensitive ? root.toLowerCase() : root
  const right = caseInsensitive ? path.toLowerCase() : path
  return left === '/' ? right.startsWith('/') : right === left || right.startsWith(`${left}/`)
}

/**
 * 把同一 marker 内的远端绝对路径映射回 marker 本地占位目录。该路径仅用于把
 * Shell 请求继续路由到 bridge，不能交给本地进程读取。
 * @param workspace - 已验证的 marker 工作区。
 * @param remotePath - 该工作区内的远端绝对路径。
 * @returns 用于后续 bridge 路由的本地 marker 占位路径。
 */
export function remoteWorkspaceLocalPath(workspace: Pick<RemoteWorkspace, 'markerRoot' | 'remoteRoot'>, remotePath: string): string {
  if (!isRemoteAbsolutePath(remotePath) || !isRemotePathWithin(workspace.remoteRoot, remotePath)) {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace path escapes its marker')
  }
  const root = workspace.remoteRoot.replace(/\\/gu, '/').replace(/\/+$/u, '') || '/'
  const candidate = remotePath.replace(/\\/gu, '/').replace(/\/+$/u, '') || '/'
  const relativePath = root === '/'
    ? candidate.slice(1)
    : candidate.slice(root.length).replace(/^\//u, '')
  if (relativePath === '') return workspace.markerRoot
  const parts = relativePath.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace path escapes its marker')
  }
  return join(workspace.markerRoot, ...parts)
}

/**
 * 从一个本地路径向上查找 marker，并派生其受限远端路径。
 * @param path - 调用者路径，绝对路径不受 cwd 影响。
 * @param cwd - 相对路径的本地解析基准。
 * @param signal - 取消 marker I/O。
 * @returns 路径未落在 marker 内时为 undefined。
 */
export async function remoteWorkspacePath(
  path: string,
  cwd = process.cwd(),
  signal?: AbortSignal,
): Promise<RemoteWorkspacePath | undefined> {
  abortIfNeeded(signal)
  const localPath = resolve(cwd, path)
  for (let directory = localPath; ; directory = dirname(directory)) {
    const workspace = await markerAt(directory, signal)
    if (workspace !== undefined) {
      const localRelativePath = relative(directory, localPath)
      if (localRelativePath === '..' || localRelativePath.startsWith(`..${sep}`) || isAbsolute(localRelativePath)) {
        throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace path escapes its marker')
      }
      const remotePath = joinRemotePath(workspace.remoteRoot, localRelativePath)
      if (!isRemotePathWithin(workspace.remoteRoot, remotePath)) {
        throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace path escapes its marker')
      }
      return { ...workspace, localPath, remotePath }
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
  }
}

/**
 * 同步识别 marker，仅供不能返回 Promise 的 `ShellExecutor.start()` 使用。
 * 读取上限与异步路径相同，且不会建立 bridge 连接或读取 token。
 * @param path - 调用者路径，绝对路径不受 cwd 影响。
 * @param cwd - 相对路径的本地解析基准。
 * @returns 路径未落在 marker 内时为 undefined。
 */
export function remoteWorkspacePathSync(path: string, cwd = process.cwd()): RemoteWorkspacePath | undefined {
  const localPath = resolve(cwd, path)
  for (let directory = localPath; ; directory = dirname(directory)) {
    const workspace = markerAtSync(directory)
    if (workspace !== undefined) {
      const localRelativePath = relative(directory, localPath)
      if (localRelativePath === '..' || localRelativePath.startsWith(`..${sep}`) || isAbsolute(localRelativePath)) {
        throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace path escapes its marker')
      }
      const remotePath = joinRemotePath(workspace.remoteRoot, localRelativePath)
      if (!isRemotePathWithin(workspace.remoteRoot, remotePath)) {
        throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace path escapes its marker')
      }
      return { ...workspace, localPath, remotePath }
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
  }
}

/**
 * 将一个已验证 marker 路径编码为不含凭据的 FsTargetKey 载荷。
 * @param target - 已验证的 marker 和远端路径身份。
 * @returns 可写入 FsTargetKey 的无凭据编码。
 */
export function remoteWorkspaceTargetKey(target: RemoteWorkspaceTarget): string {
  if (!isAbsolute(target.markerRoot) || !Number.isSafeInteger(target.markerGeneration) || target.markerGeneration <= 0
    || !isRemotePathWithin(target.remoteRoot, target.remotePath)) {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace target is invalid')
  }
  const payload = JSON.stringify({
    markerRoot: target.markerRoot,
    remoteRoot: target.remoteRoot,
    remotePath: target.remotePath,
    connectionId: target.connectionId,
    markerGeneration: target.markerGeneration,
  })
  return REMOTE_TARGET_PREFIX + Buffer.from(payload, 'utf8').toString('base64url')
}

/**
 * 解析远端 targetKey；普通本地 targetKey 返回 undefined，带本前缀的畸形键
 * 会被拒绝，不能借由伪造键绕过 marker 根限制。
 * @param targetKey - FsTargetKey 中保存的字符串。
 * @returns 已验证的远端目标；普通本地键返回 undefined。
 */
export function parseRemoteWorkspaceTargetKey(targetKey: string): RemoteWorkspaceTarget | undefined {
  if (!targetKey.startsWith(REMOTE_TARGET_PREFIX)) return undefined
  const encoded = targetKey.slice(REMOTE_TARGET_PREFIX.length)
  if (encoded.length === 0 || encoded.length > 16 * 1024) {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace target is invalid')
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace target is invalid')
  }
  const record = asRecord(value)
  const markerGeneration = record?.markerGeneration
  if (record === undefined || Object.keys(record).some(key => key !== 'markerRoot' && key !== 'remoteRoot' && key !== 'remotePath' && key !== 'connectionId' && key !== 'markerGeneration')
    || typeof record.markerRoot !== 'string' || typeof record.remoteRoot !== 'string' || typeof record.remotePath !== 'string'
    || typeof record.connectionId !== 'string' || typeof markerGeneration !== 'number' || !Number.isSafeInteger(markerGeneration) || markerGeneration <= 0
    || !isAbsolute(record.markerRoot) || !isRemoteAbsolutePath(record.remoteRoot) || !isRemoteAbsolutePath(record.remotePath)
    || !isRemotePathWithin(record.remoteRoot, record.remotePath)) {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace target is invalid')
  }
  if (!CONNECTION_ID.test(record.connectionId)) {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace target is invalid')
  }
  return {
    markerRoot: record.markerRoot,
    remoteRoot: record.remoteRoot,
    remotePath: record.remotePath,
    connectionId: record.connectionId,
    markerGeneration,
  }
}

/**
 * 在实际 bridge 调用前复核 targetKey 对应 marker 未被替换，并统一使用 marker
 * 当前的 connectionId。这样一个旧 target 不能在连接切换后继续指向另一台主机。
 * @param target - 从 FsTargetKey 解析出的远端目标。
 * @param signal - 取消当前 marker 复核。
 * @returns 与当前 marker 一致的远端目标。
 */
export async function verifyRemoteWorkspaceTarget(
  target: RemoteWorkspaceTarget,
  signal?: AbortSignal,
): Promise<RemoteWorkspaceTarget> {
  const current = await readRemoteWorkspaceMarker(target.markerRoot, signal)
  if (
    current.remoteRoot !== target.remoteRoot
    || current.connectionId !== target.connectionId
    || current.markerGeneration !== target.markerGeneration
    || !isRemotePathWithin(current.remoteRoot, target.remotePath)
  ) {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace target no longer matches its marker')
  }
  return { ...current, remotePath: target.remotePath }
}

function bridgeConfig(): BridgeConfig {
  const rawUrl = process.env[REMOTE_BRIDGE_URL_ENV]
  const token = process.env[REMOTE_BRIDGE_TOKEN_ENV]
  if (rawUrl === undefined || token === undefined || token.length < 16) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_UNAVAILABLE', 'remote workspace bridge is unavailable')
  }
  let baseUrl: URL
  try {
    baseUrl = new URL(rawUrl)
  } catch {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_UNAVAILABLE', 'remote workspace bridge is unavailable')
  }
  if (baseUrl.protocol !== 'http:' || baseUrl.hostname !== '127.0.0.1' || baseUrl.username !== '' || baseUrl.password !== ''
    || baseUrl.search !== '' || baseUrl.hash !== '' || (baseUrl.pathname !== '' && baseUrl.pathname !== '/')) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_UNAVAILABLE', 'remote workspace bridge is unavailable')
  }
  return { baseUrl, token }
}

async function readBridgePayload(response: Response, signal?: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const size = Number(declaredLength)
    if (!Number.isSafeInteger(size) || size < 0 || size > BRIDGE_MAX_RESPONSE_BYTES) {
      throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
    }
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      abortIfNeeded(signal)
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > BRIDGE_MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an oversized response')
      }
      chunks.push(next.value)
    }
  } catch (error: unknown) {
    if (error instanceof RemoteWorkspaceError) throw error
    if (signal?.aborted) throw new RemoteWorkspaceError('REMOTE_BRIDGE_ABORTED', 'remote workspace request was aborted')
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge response could not be read')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned non-UTF-8 JSON')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned invalid JSON')
  }
}

function bridgeErrorCode(payload: unknown): string | undefined {
  const root = asRecord(payload)
  const error = root === undefined ? undefined : asRecord(root.error)
  return error !== undefined && typeof error.code === 'string' && /^[a-z0-9-]{1,80}$/u.test(error.code)
    ? error.code
    : undefined
}

/**
 * 调用桌面本地 bridge。请求和成功响应都由调用者在边界两端构造/验证；本函数
 * 只允许回环地址，并从环境中读取 bearer token，不让 token 落入 URL 或异常文本。
 * @param workspace - 当前连接 id 和可选远端根限制。
 * @param path - bridge 允许的版本化路由。
 * @param method - 允许的 HTTP 方法。
 * @param body - 待编码的请求载荷。
 * @param parseResponse - 成功响应的调用方校验器。
 * @param signal - 取消当前 bridge 请求。
 * @param awaitDefinitiveResponse - mutation 派发后不再用 caller signal 中断传输，
 * 以取得已提交或拒绝的最终响应。
 * @param definitiveResponseSignal - `awaitDefinitiveResponse` 时仍可用于传输的独立
 * deadline；当 `signal` 是 caller 取消信号时，调用方传入另建的有界 signal。
 * @param retiredCleanup - 仅已发布句柄的旧 owner 终止/取消路径可设为 true；bridge
 * 仍只放行固定的清理 route，普通读写、创建和会话操作绝不能借此回退。
 * @returns 已通过调用方校验的成功响应。
 */
export async function callRemoteWorkspaceBridge<T>(
  workspace: RemoteWorkspaceBridgeTarget,
  path: `/v1/${string}`,
  method: 'GET' | 'POST',
  body: unknown,
  parseResponse: (value: unknown) => T,
  signal?: AbortSignal,
  awaitDefinitiveResponse = false,
  definitiveResponseSignal?: AbortSignal,
  retiredCleanup = false,
): Promise<T> {
  abortIfNeeded(signal)
  if (!isAbsolute(workspace.markerRoot) || !Number.isSafeInteger(workspace.markerGeneration) || workspace.markerGeneration <= 0
    || !CONNECTION_ID.test(workspace.connectionId) || !isRemoteAbsolutePath(workspace.remoteRoot)) {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace target is invalid')
  }
  const config = bridgeConfig()
  const requestUrl = new URL(path, config.baseUrl)
  const requestPayload = bridgePayload(workspace, body)
  // 写入类请求一旦开始 fetch 就可能已在远端提交。此后必须等待确定响应，不能因
  // caller 取消而把已提交的 mutation 误报为 abort。
  const responseSignal = awaitDefinitiveResponse ? definitiveResponseSignal : signal
  let response: Response
  try {
    response = await fetch(requestUrl, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'X-Coding-Remote-Connection': workspace.connectionId,
        'X-Coding-Remote-Marker-Root': workspace.markerRoot,
        'X-Coding-Remote-Marker-Generation': String(workspace.markerGeneration),
        'X-Coding-Remote-Root': workspace.remoteRoot,
        ...retiredCleanup ? { 'X-Coding-Remote-Cleanup': '1' } : {},
        ...requestPayload === undefined ? {} : { 'Content-Type': 'application/json' },
      },
      ...requestPayload === undefined ? {} : { body: JSON.stringify(requestPayload) },
      ...responseSignal === undefined ? {} : { signal: responseSignal },
    })
  } catch {
    if (responseSignal?.aborted) throw new RemoteWorkspaceError('REMOTE_BRIDGE_ABORTED', 'remote workspace request was aborted')
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_UNAVAILABLE', 'remote workspace bridge is unavailable')
  }
  const responsePayload = await readBridgePayload(response, responseSignal)
  if (!response.ok) {
    const code = bridgeErrorCode(responsePayload)
    throw new RemoteWorkspaceError(
      'REMOTE_BRIDGE_REJECTED',
      code === undefined ? 'remote workspace request was rejected' : `remote workspace request was rejected (${code})`,
      code,
    )
  }
  try {
    return parseResponse(responsePayload)
  } catch (error: unknown) {
    if (error instanceof RemoteWorkspaceError) throw error
    throw new RemoteWorkspaceError('REMOTE_BRIDGE_RESPONSE_INVALID', 'remote workspace bridge returned an invalid response')
  }
}

/**
 * 将 marker 的远端根随每个 JSON 请求带给 agent。调用方不能覆盖该字段，因此
 * 远端服务可在解析符号链接后拒绝越出工作区的文件操作；目录选择等无 marker
 * 上下文的调用仍可省略根限制。
 */
function bridgePayload(
  workspace: RemoteWorkspaceBridgeTarget,
  body: unknown,
): unknown {
  if (body === undefined) return body
  const record = asRecord(body)
  if (record === undefined) {
    throw new RemoteWorkspaceError('REMOTE_WORKSPACE_TARGET_INVALID', 'remote workspace request is invalid')
  }
  return { ...record, root: workspace.remoteRoot }
}
