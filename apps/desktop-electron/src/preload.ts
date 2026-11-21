/**
 * Sandbox preload 只公开受限 Remote-SSH 方法与 Agent 浏览器呈现请求，不转交 ipcRenderer。
 *
 * 呈现请求只携带页面标识与矩形；页面内容、输入与命令都由 Host 侧通道处理。
 */
import { contextBridge, ipcRenderer } from 'electron'

const invoke = (method: string, payload: unknown): Promise<unknown> => ipcRenderer.invoke('coding:remote-ssh', method, payload)

const remoteSSH = Object.freeze({
  connect: (input: unknown) => invoke('connect', input),
  cancelConnect: (attemptId: string) => invoke('cancelConnect', { attemptId }),
  listDirectories: (connectionId: string, path: string) => invoke('listDirectories', { connectionId, path }),
  selectDirectory: (connectionId: string, path: string) => invoke('selectDirectory', { connectionId, path }),
  close: (connectionId: string) => invoke('close', { connectionId }),
  rejectHostKey: (confirmationId: string) => invoke('rejectHostKey', { confirmationId }),
  profiles: () => invoke('profiles', {}),
  forgetProfile: (profileId: string) => invoke('forgetProfile', { profileId }),
  reconnectWorkspace: (markerPath: string) => invoke('reconnectWorkspace', { markerPath }),
  subscribeProgress: (listener: (progress: unknown) => void): (() => void) => {
    if (typeof listener !== 'function') throw new TypeError('Invalid Remote-SSH progress listener')
    const forward = (_event: Electron.IpcRendererEvent, progress: unknown): void => { listener(progress) }
    ipcRenderer.on('coding:remote-ssh-progress', forward)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      ipcRenderer.removeListener('coding:remote-ssh-progress', forward)
    }
  },
})

const egoDownloads = Object.freeze({
  list: (): Promise<unknown> => ipcRenderer.invoke('coding:ego-downloads', { action: 'list' }),
  cancel: (id: string): Promise<unknown> => ipcRenderer.invoke('coding:ego-downloads', { action: 'cancel', id }),
  save: (id: string): Promise<unknown> => ipcRenderer.invoke('coding:ego-downloads', { action: 'save', id }),
  reveal: (id: string): Promise<unknown> => ipcRenderer.invoke('coding:ego-downloads', { action: 'reveal', id }),
  open: (id: string): Promise<unknown> => ipcRenderer.invoke('coding:ego-downloads', { action: 'open', id }),
  subscribe: (listener: (payload: unknown) => void): (() => void) => {
    if (typeof listener !== 'function') throw new TypeError('Invalid download listener')
    const forward = (_event: Electron.IpcRendererEvent, payload: unknown): void => { listener(payload) }
    ipcRenderer.on('coding:ego-downloads-event', forward)
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      ipcRenderer.removeListener('coding:ego-downloads-event', forward)
    }
  },
})

const egoBrowser = Object.freeze({
  present: (input: unknown): Promise<unknown> => ipcRenderer.invoke('coding:ego-present', input),
  downloads: egoDownloads,
})

contextBridge.exposeInMainWorld('codingDesktop', Object.freeze({ remoteSSH, egoBrowser }))
