/**
 * Remote-SSH 的桌面桥接边界。浏览器 Host 不具备 SSH 权限；只有桌面壳注入
 * 一次性的 bridge token 后，才会暴露这些调用。这里在进入 React 前校验每个
 * Wails 返回值，避免把跨进程的未知数据当成客户端状态。
 */

/** SSH 认证输入的种类；密钥材料只随当前调用传给桌面壳。 */
export type RemoteSshAuthKind = 'password' | 'privateKey'

/** 连接远程 SSH 主机所需的瞬时输入。 */
export interface RemoteSshConnectInput {
  /** 当前 UI 连接尝试的关联标识；取消与 progress 必须精确回显它。 */
  attemptId: string
  host: string
  port: number
  username: string
  auth: {
    kind: RemoteSshAuthKind
    secret: string
  }
  /** 桌面端签发的未知主机密钥确认标识；只可用于完成原始握手。 */
  confirmationId?: string | undefined
  /** 用户确认过的未知主机指纹；桌面端仍会重新精确比对后才写入 known_hosts。 */
  acceptHostKeyFingerprint?: string | undefined
}

/** Desktop bridge 在连接结束时给出的三个确定分支。 */
export type RemoteSshConnectResult =
  | { kind: 'ready'; connectionId: string; homePath?: string | undefined }
  | { kind: 'host-key-confirmation'; confirmationId: string; fingerprint: string; algorithm: string }
  | { kind: 'error'; message: string }

/** 远程目录列举项。只允许目录进入工作区选择器。 */
export interface RemoteSshDirectoryEntry {
  name: string
  path: string
  directory: boolean
}

/** 远程目录列举的已验证结果。 */
export interface RemoteSshDirectoryListing {
  path: string
  entries: readonly RemoteSshDirectoryEntry[]
}

/** 选定远程目录后，桌面端创建的无凭据本地 marker。 */
export interface RemoteSshDirectorySelection {
  markerPath: string
  remotePath: string
}

/** 桌面端连接生命周期事件的公开、安全进度描述。 */
export interface RemoteSshProgress {
  attemptId: string
  phase: 'authenticating' | 'probing' | 'uploading' | 'starting' | 'ready' | 'failed'
  message: string
}

/** 前端向导可消费的最小桌面 bridge；不暴露 token 或底层 agent。 */
export interface RemoteSshBridge {
  connect: (input: RemoteSshConnectInput) => Promise<RemoteSshConnectResult>
  cancelConnect: (attemptId: string) => Promise<void>
  listDirectories: (connectionId: string, path: string) => Promise<RemoteSshDirectoryListing>
  selectDirectory: (connectionId: string, path: string) => Promise<RemoteSshDirectorySelection>
  close: (connectionId: string) => Promise<void>
  rejectHostKey: (confirmationId: string) => Promise<void>
  subscribeProgress: (listener: (progress: RemoteSshProgress) => void) => () => void
}

/** SSH 表单错误；组件据此映射到本地化、且不回显敏感输入的文案。 */
export class RemoteSshConfigError extends Error {
  /** @param code - 被拒绝字段的稳定分类。 */
  constructor(readonly code: 'host' | 'port' | 'username' | 'secret') {
    super(code)
    this.name = 'RemoteSshConfigError'
  }
}

/** 桌面 bridge 不存在或返回了不符合协议的值。 */
export class RemoteSshBridgeError extends Error {
  /** @param message - 可向操作者显示的非敏感诊断。 */
  constructor(message: string) {
    super(message)
    this.name = 'RemoteSshBridgeError'
  }
}

/**
 * 在把 SSH 配置交给桌面进程前先拒绝 URL、空凭据和无效端口。主机名保留
 * IPv6 字面量的合法冒号，而用户与认证材料不会写入地址、日志或持久化状态。
 * @param input - 表单已解析出的连接输入。
 * @returns 通过原样校验的输入。
 * @throws {RemoteSshConfigError} 任一字段不满足 SSH 配置约束。
 */
export function validateRemoteSshConfig(input: RemoteSshConnectInput): RemoteSshConnectInput {
  if (
    input.host.trim() === ''
    || input.host.includes('://')
    || /[\\/@?#\s\0]/u.test(input.host)
  ) {
    throw new RemoteSshConfigError('host')
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new RemoteSshConfigError('port')
  }
  if (input.username.trim() === '' || /[\s\0]/u.test(input.username)) {
    throw new RemoteSshConfigError('username')
  }
  if (input.auth.secret === '') throw new RemoteSshConfigError('secret')
  return input
}

type DesktopBinding = {
  RemoteSSHConnect?: unknown
  RemoteSSHCancelConnect?: unknown
  RemoteSSHListDirectories?: unknown
  RemoteSSHSelectDirectory?: unknown
  RemoteSSHClose?: unknown
  RemoteSSHRejectHostKey?: unknown
}

type DesktopRuntime = {
  EventsOn?: unknown
}

type DesktopWindow = Window & {
  __CODING_DESKTOP_BRIDGE_TOKEN?: unknown
  go?: { main?: { App?: DesktopBinding } }
  runtime?: DesktopRuntime
}

/** 将未知 Wails 返回值收窄为记录，失败时不给调用方泄漏实现细节。 */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteSshBridgeError('桌面端返回了无效的 Remote-SSH 响应。')
  }
  return value as Record<string, unknown>
}

/** 拒绝协议分支未声明的字段，避免桌面与 Client 在静默漂移后继续运行。 */
function exactFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed)
  if (Object.keys(value).some(key => !accepted.has(key))) {
    throw new RemoteSshBridgeError('桌面端返回了无效的 Remote-SSH 响应。')
  }
}

/** 读取必填字符串并拒绝空白值。 */
function stringField(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new RemoteSshBridgeError('桌面端返回了无效的 Remote-SSH 响应。')
  }
  return value
}

/** 读取可选字符串；空字符串仍视为协议错误。 */
function optionalStringField(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return stringField(value)
}

/** 验证 Connect 的封闭联合结果。 */
function parseConnectResult(value: unknown): RemoteSshConnectResult {
  const result = record(value)
  switch (result.kind) {
    case 'ready': {
      exactFields(result, ['kind', 'connectionId', 'homePath'])
      return {
        kind: 'ready',
        connectionId: stringField(result.connectionId),
        homePath: optionalStringField(result.homePath),
      }
    }
    case 'host-key-confirmation': {
      exactFields(result, ['kind', 'confirmationId', 'fingerprint', 'algorithm'])
      return {
        kind: 'host-key-confirmation',
        confirmationId: stringField(result.confirmationId),
        fingerprint: stringField(result.fingerprint),
        algorithm: stringField(result.algorithm),
      }
    }
    case 'error':
      exactFields(result, ['kind', 'message'])
      return { kind: 'error', message: stringField(result.message) }
    default: throw new RemoteSshBridgeError('桌面端返回了未知的 Remote-SSH 状态。')
  }
}

/** 验证远程目录列表，只接受 desktop binding 固定的 JSON 字段。 */
function parseDirectoryListing(value: unknown): RemoteSshDirectoryListing {
  const result = record(value)
  exactFields(result, ['path', 'entries'])
  if (!Array.isArray(result.entries)) {
    throw new RemoteSshBridgeError('桌面端返回了无效的远程目录列表。')
  }
  return {
    path: stringField(result.path),
    entries: result.entries.map((raw): RemoteSshDirectoryEntry => {
      const entry = record(raw)
      exactFields(entry, ['name', 'path', 'directory'])
      if (typeof entry.directory !== 'boolean') {
        throw new RemoteSshBridgeError('桌面端返回了无效的远程目录列表。')
      }
      return { name: stringField(entry.name), path: stringField(entry.path), directory: entry.directory }
    }),
  }
}

/** 验证 marker 创建结果；marker 的内部格式不属于 Web UI。 */
function parseDirectorySelection(value: unknown): RemoteSshDirectorySelection {
  const result = record(value)
  exactFields(result, ['markerPath', 'remotePath'])
  return { markerPath: stringField(result.markerPath), remotePath: stringField(result.remotePath) }
}

/** 忽略未知 event，避免另一个 Wails 事件污染 Remote-SSH 状态。 */
function parseProgress(value: unknown): RemoteSshProgress | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = value as Record<string, unknown>
  try {
    exactFields(result, ['attemptId', 'phase', 'message'])
  } catch {
    return undefined
  }
  if (
    result.phase !== 'authenticating'
    && result.phase !== 'probing'
    && result.phase !== 'uploading'
    && result.phase !== 'starting'
    && result.phase !== 'ready'
    && result.phase !== 'failed'
  ) return undefined
  if (typeof result.attemptId !== 'string' || result.attemptId === '' || typeof result.message !== 'string') return undefined
  return { attemptId: result.attemptId, phase: result.phase, message: result.message }
}

/** 将 binding reject 收窄成统一错误，避免原生诊断、路径或内部状态进入 UI。 */
async function invokeBinding<T>(invoke: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  try {
    return parse(await invoke())
  } catch (reason) {
    if (reason instanceof RemoteSshBridgeError) throw reason
    throw new RemoteSshBridgeError('Remote-SSH 桌面桥接调用失败。')
  }
}

/** 调用无返回值 binding，并隐藏其原生 reject 诊断。 */
async function invokeBindingEffect(invoke: () => Promise<unknown>): Promise<void> {
  try {
    await invoke()
  } catch {
    throw new RemoteSshBridgeError('Remote-SSH 桌面桥接调用失败。')
  }
}

/** 返回当前窗口注入的一次性 token；没有 token 的 Web Host 永远不可调用敏感绑定。 */
function bridgeToken(target: DesktopWindow): string | undefined {
  const token = target.__CODING_DESKTOP_BRIDGE_TOKEN
  return typeof token === 'string' && token !== '' ? token : undefined
}

/**
 * 取得桌面壳的受限 Remote-SSH 调用面。普通 Web Host、过期的 Wails 注入或
 * 缺少 token 都返回 undefined，调用者显示桌面端可用提示而不是降级为 HTTP URL。
 * @returns 仅在本窗口被桌面壳授权时存在的 bridge。
 */
export function getRemoteSshBridge(): RemoteSshBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const target = window as DesktopWindow
  const token = bridgeToken(target)
  const app = target.go?.main?.App
  if (
    token === undefined
    || app === undefined
    || typeof app.RemoteSSHConnect !== 'function'
    || typeof app.RemoteSSHCancelConnect !== 'function'
    || typeof app.RemoteSSHListDirectories !== 'function'
    || typeof app.RemoteSSHSelectDirectory !== 'function'
    || typeof app.RemoteSSHClose !== 'function'
    || typeof app.RemoteSSHRejectHostKey !== 'function'
  ) return undefined

  const connect = app.RemoteSSHConnect as (bridgeToken: string, input: RemoteSshConnectInput) => Promise<unknown>
  const cancelConnect = app.RemoteSSHCancelConnect as (bridgeToken: string, attemptId: string) => Promise<unknown>
  const listDirectories = app.RemoteSSHListDirectories as (
    bridgeToken: string, connectionId: string, path: string,
  ) => Promise<unknown>
  const selectDirectory = app.RemoteSSHSelectDirectory as (
    bridgeToken: string, connectionId: string, path: string,
  ) => Promise<unknown>
  const close = app.RemoteSSHClose as (bridgeToken: string, connectionId: string) => Promise<unknown>
  const rejectHostKey = app.RemoteSSHRejectHostKey as (
    bridgeToken: string, confirmationId: string,
  ) => Promise<unknown>

  return {
    connect: input => invokeBinding(() => connect(token, input), parseConnectResult),
    cancelConnect: attemptId => invokeBindingEffect(() => cancelConnect(token, attemptId)),
    listDirectories: (connectionId, path) => invokeBinding(
      () => listDirectories(token, connectionId, path), parseDirectoryListing,
    ),
    selectDirectory: (connectionId, path) => invokeBinding(
      () => selectDirectory(token, connectionId, path), parseDirectorySelection,
    ),
    close: connectionId => invokeBindingEffect(() => close(token, connectionId)),
    rejectHostKey: confirmationId => invokeBindingEffect(() => rejectHostKey(token, confirmationId)),
    subscribeProgress: (listener) => {
      const eventsOn = target.runtime?.EventsOn
      if (typeof eventsOn !== 'function') return () => {}
      const unsubscribe = (eventsOn as (
        eventName: string, listener: (payload: unknown) => void,
      ) => unknown)('coding:remote-ssh-progress', (payload) => {
        const progress = parseProgress(payload)
        if (progress !== undefined) listener(progress)
      })
      return typeof unsubscribe === 'function' ? unsubscribe as () => void : () => {}
    },
  }
}
