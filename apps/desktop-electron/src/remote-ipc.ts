/** Electron Remote-SSH IPC 仅接受当前 Host 主 frame 的六个固定操作。 */
import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

const CHANNEL = 'coding:remote-ssh'
const PROGRESS_CHANNEL = 'coding:remote-ssh-progress'
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const PHASES = new Set(['authenticating', 'probing', 'uploading', 'starting', 'ready', 'failed'])

type Method = 'connect' | 'cancelConnect' | 'listDirectories' | 'selectDirectory' | 'close' | 'rejectHostKey'
type Progress = { attemptId: string; phase: string; message: string }
type PendingRequest = { invalidate(): void }

/** 主进程持有的 helper，不得传递给 renderer。 */
export interface RemoteIpcHelper {
  request(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  onProgress(listener: (progress: Progress) => void): () => void
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}

function id(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value)
}

function nonempty(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value !== '' && Buffer.byteLength(value) <= maxBytes && !value.includes('\0')
}

function connectPayload(value: unknown): boolean {
  if (!record(value) || !fields(value, ['attemptId', 'host', 'port', 'username', 'auth'], [
    'confirmationId', 'acceptHostKeyFingerprint',
  ])) return false
  if (!id(value.attemptId) || !nonempty(value.host, 255) || !nonempty(value.username, 255)
    || !Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535
    || !record(value.auth) || !fields(value.auth, ['kind', 'secret'])) return false
  if (value.host.trim() !== value.host || value.host.includes('://') || /[\/@?#\s]/u.test(value.host)) return false
  if (value.username.trim() !== value.username || /\s/u.test(value.username)) return false
  if (value.auth.kind !== 'password' && value.auth.kind !== 'privateKey') return false
  if (!nonempty(value.auth.secret, 1 << 20)) return false
  if (value.confirmationId !== undefined && !id(value.confirmationId)) return false
  if (value.acceptHostKeyFingerprint !== undefined && !nonempty(value.acceptHostKeyFingerprint, 256)) return false
  return (value.confirmationId === undefined) === (value.acceptHostKeyFingerprint === undefined)
}

function payloadFor(method: unknown, payload: unknown): { method: string; payload: unknown } | undefined {
  if (typeof method !== 'string' || !record(payload)) return undefined
  switch (method as Method) {
    case 'connect':
      return connectPayload(payload) ? { method: 'RemoteSSHConnect', payload } : undefined
    case 'cancelConnect':
      return fields(payload, ['attemptId']) && id(payload.attemptId)
        ? { method: 'RemoteSSHCancelConnect', payload } : undefined
    case 'listDirectories':
    case 'selectDirectory':
      return fields(payload, ['connectionId', 'path']) && id(payload.connectionId) && nonempty(payload.path, 4096)
        ? {
          method: method === 'listDirectories' ? 'RemoteSSHListDirectories' : 'RemoteSSHSelectDirectory',
          payload: { connectionId: payload.connectionId, remotePath: payload.path },
        }
        : undefined
    case 'close':
      return fields(payload, ['connectionId']) && id(payload.connectionId)
        ? { method: 'RemoteSSHClose', payload } : undefined
    case 'rejectHostKey':
      return fields(payload, ['confirmationId']) && id(payload.confirmationId)
        ? { method: 'RemoteSSHRejectHostKey', payload } : undefined
    default:
      return undefined
  }
}

function validOrigin(origin: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(origin)
  return match !== null && Number(match[1]) <= 65535
}

function hostURL(target: string, origin: string): boolean {
  try {
    if (!target.startsWith(origin) || !['/', '?', '#'].includes(target.charAt(origin.length))) return false
    const url = new URL(target)
    return url.origin === origin && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

function currentFrame(window: BrowserWindow, origin: string): boolean {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return false
  const frame = window.webContents.mainFrame
  return !frame.isDestroyed() && hostURL(frame.url, origin)
}

let activeInstallation: (() => void) | undefined
let epoch = 0

function unknownConnection(): void {
  console.warn('Remote-SSH connection state unknown after cleanup failure.')
}

function unknownSelection(): void {
  console.warn('Remote-SSH selection state unknown after cleanup failure.')
}

function staleConnectResult(value: unknown): { method: string; payload: unknown } | undefined {
  if (!record(value)) return undefined
  if (value.kind === 'ready' && id(value.connectionId)) {
    return { method: 'RemoteSSHClose', payload: { connectionId: value.connectionId } }
  }
  if (value.kind === 'host-key-confirmation' && id(value.confirmationId)) {
    return { method: 'RemoteSSHRejectHostKey', payload: { confirmationId: value.confirmationId } }
  }
  return undefined
}

function selectedDirectory(value: unknown): { markerPath: string; remotePath: string } | undefined {
  if (!record(value) || value.kind !== 'selected' || !fields(value, ['kind', 'markerPath', 'remotePath'])
    || !nonempty(value.markerPath, 4096) || !nonempty(value.remotePath, 4096)) return undefined
  return { markerPath: value.markerPath, remotePath: value.remotePath }
}

/**
 * 仅给一个已验证 Host 窗口安装 Remote-SSH 调用；同源重载期间暂停，替换或销毁即撤权。
 * @param options 当前窗口、精确 Host origin 与主进程独占的 helper。
 * @returns 幂等撤销函数；调用后取消连接或撤销未认领选择，并撤掉进度监听。
 */
export function installRemoteIpc(options: {
  window: BrowserWindow
  origin: string
  helper: RemoteIpcHelper
}): () => void {
  const { window, origin, helper } = options
  if (!validOrigin(origin)) throw new Error('Invalid Remote-SSH Host origin')
  activeInstallation?.()
  const installationEpoch = ++epoch
  let disposed = false
  let ready = true
  let navigationGeneration = 0
  const pending = new Set<PendingRequest>()
  const authorized = (event: IpcMainInvokeEvent): boolean => !disposed && ready && epoch === installationEpoch
    && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
    && currentFrame(window, origin)

  const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean; url: string }): void => {
    if (!details.isMainFrame || details.isSameDocument) return
    ++navigationGeneration
    ready = false
    for (const entry of pending) entry.invalidate()
    if (!hostURL(details.url, origin)) dispose()
  }
  const onLoaded = (): void => { if (!disposed && currentFrame(window, origin)) ready = true }
  const onDestroyed = (): void => { dispose() }
  const onProgress = (value: Progress): void => {
    if (disposed || !ready || epoch !== installationEpoch || !currentFrame(window, origin)) return
    if (!record(value) || !fields(value, ['attemptId', 'phase', 'message'])
      || !id(value.attemptId) || !PHASES.has(value.phase) || value.message !== '') return
    window.webContents.send(PROGRESS_CHANNEL, value)
  }
  window.webContents.on('did-start-navigation', onNavigation)
  window.webContents.on('did-finish-load', onLoaded)
  window.webContents.on('destroyed', onDestroyed)
  window.on('closed', onDestroyed)
  const stopProgress = helper.onProgress(onProgress)

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (epoch === installationEpoch) {
      ++epoch
      ipcMain.removeHandler(CHANNEL)
      activeInstallation = undefined
    }
    stopProgress()
    for (const entry of pending) entry.invalidate()
    window.webContents.removeListener('did-start-navigation', onNavigation)
    window.webContents.removeListener('did-finish-load', onLoaded)
    window.webContents.removeListener('destroyed', onDestroyed)
    window.removeListener('closed', onDestroyed)
  }

  ipcMain.handle(CHANNEL, async (event, method: unknown, payload: unknown) => {
    if (!authorized(event)) throw new Error('Remote-SSH IPC unauthorized')
    const request = payloadFor(method, payload)
    if (!request) throw new Error('Invalid Remote-SSH IPC request')
    const controller = new AbortController()
    const requestGeneration = navigationGeneration
    const operationId = method === 'selectDirectory' ? randomUUID() : undefined
    const attemptId = method === 'connect' ? (payload as { attemptId: string }).attemptId : undefined
    const connectionId = method === 'selectDirectory' ? (payload as { connectionId: string }).connectionId : undefined
    let stale = false
    let claimStarted = false
    const revokeSelection = (): Promise<void> => helper.request('RemoteSSHRevokeUnclaimed', { operationId, connectionId })
      .then((value) => {
        if (!record(value) || !fields(value, ['kind']) || value.kind !== 'revoked') unknownSelection()
      }, () => { unknownSelection() })
    const entry: PendingRequest = {
      invalidate() {
        if (stale) return
        stale = true
        if (method === 'connect') {
          // 不能取消原始 request 的观察；Go 可能已完成连接，迟到结果仍须关闭。
          void helper.request('RemoteSSHCancelConnect', { attemptId }).catch(() => { unknownConnection() })
        } else if (method === 'selectDirectory') {
          void revokeSelection()
          if (claimStarted) unknownSelection()
        } else controller.abort()
      },
    }
    const expired = (): boolean => stale || requestGeneration !== navigationGeneration || !authorized(event)
    pending.add(entry)
    try {
      const wireMethod = method === 'selectDirectory' ? 'RemoteSSHSelectUnclaimed' : request.method
      const wirePayload = method === 'selectDirectory'
        ? { operationId, ...(request.payload as { connectionId: string; remotePath: string }) }
        : request.payload
      let result: unknown
      try {
        result = await helper.request(wireMethod, wirePayload, method === 'connect' || method === 'selectDirectory' ? undefined : controller.signal)
      } catch (error) {
        if (expired()) throw new Error('Remote-SSH IPC expired')
        throw error
      }
      if (expired()) {
        if (method === 'connect') {
          const cleanup = staleConnectResult(result)
          if (cleanup) {
            try { await helper.request(cleanup.method, cleanup.payload) } catch { unknownConnection() }
          } else if (record(result) && (result.kind === 'ready' || result.kind === 'host-key-confirmation')) {
            unknownConnection()
          }
        } else if (method === 'selectDirectory') {
          // 撤销可能先于未认领选择完成；再次撤销由 Go 按 operationId 幂等处理。
          await revokeSelection()
        }
        throw new Error('Remote-SSH IPC expired')
      }
      if (method === 'selectDirectory') {
        const selected = selectedDirectory(result)
        if (!selected) {
          await revokeSelection()
          throw new Error('Remote-SSH selection state unknown')
        }
        claimStarted = true
        let claimed: unknown
        try {
          claimed = await helper.request('RemoteSSHClaimSelection', { operationId })
        } catch {
          await revokeSelection()
          throw new Error('Remote-SSH selection state unknown')
        }
        if (expired()) throw new Error('Remote-SSH IPC expired')
        if (!record(claimed) || !fields(claimed, ['kind']) || claimed.kind !== 'claimed') {
          await revokeSelection()
          throw new Error('Remote-SSH selection state unknown')
        }
        return selected
      }
      return result
    } finally {
      pending.delete(entry)
    }
  })
  activeInstallation = dispose
  return dispose
}
