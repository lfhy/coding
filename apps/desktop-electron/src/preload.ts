/** Sandbox preload 只公开受限 Remote-SSH 方法，不向页面转交 ipcRenderer。 */
import { contextBridge, ipcRenderer } from 'electron'

const invoke = (method: string, payload: unknown): Promise<unknown> => ipcRenderer.invoke('coding:remote-ssh', method, payload)

const remoteSSH = Object.freeze({
  connect: (input: unknown) => invoke('connect', input),
  cancelConnect: (attemptId: string) => invoke('cancelConnect', { attemptId }),
  listDirectories: (connectionId: string, path: string) => invoke('listDirectories', { connectionId, path }),
  selectDirectory: (connectionId: string, path: string) => invoke('selectDirectory', { connectionId, path }),
  close: (connectionId: string) => invoke('close', { connectionId }),
  rejectHostKey: (confirmationId: string) => invoke('rejectHostKey', { confirmationId }),
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

contextBridge.exposeInMainWorld('codingDesktop', Object.freeze({ remoteSSH }))
