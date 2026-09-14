/**
 * Win32 文件夹对话框的子进程入口：该进程阻塞在模态 `Show` 中并通过 IPC
 * 上报结果，宿主事件循环仍保持可用。子进程隔离原生故障；后台宿主启动时
 * 该进程不具备前台权限，因此 `runFolderDialog` 在 `Show` 紧前方合成 Alt
 * 按键。协议在阻塞调用前发送 `{kind:'showing',threadId}`（驱动需要原生
 * 线程 id 才能响应中止），随后恰好发送 `{kind:'done',path}` 或
 * `{kind:'error',message}` 之一。
 */

import { loadWin32DialogBindings } from './win32-dialog-bindings.ts'
import { runFolderDialog } from './win32-dialog-logic.ts'

/** The driver-to-child payload: the dialog title (passed via env). */
export interface Win32DialogWorkerData { title: string }

/** One notice or outcome posted back to the driver. */
export type Win32DialogWorkerMessage =
  | { kind: 'showing'; threadId: number }
  | { kind: 'done'; path: string | null }
  | { kind: 'error'; message: string }

const title = process.env.DSH_DIALOG_TITLE ?? ''
if (title === '') throw new Error('win32-dialog-worker: DSH_DIALOG_TITLE is required')
if (process.send === undefined) throw new Error('win32-dialog-worker must run as a child process with an IPC channel')
// node's internal `send` reads `this.connected`, so bind the receiver.
const send = process.send.bind(process)

const post = (message: Win32DialogWorkerMessage): void => {
  // Flush before closing the channel; the process exits when the loop drains.
  /* v8 ignore next 3 -- disconnect needs a live IPC channel the unit lane must not sever (built-worker.e2e.ts owns the real close path). */
  send(message, () => { if (process.connected) process.disconnect() })
}

// A settled driver (or a dead parent) must not orphan a dialog still on screen.
/* v8 ignore next 3 -- the handler exits(0), which would kill the unit lane; built-worker.e2e.ts owns the real disconnect lifecycle. */
process.on('disconnect', () => process.exit(0))

// No top-level await: the built worker ships as CJS, which cannot carry TLA.
void (async () => {
  try {
    const bindings = await loadWin32DialogBindings()
    const path = runFolderDialog(bindings, title, (threadId) => {
      post({ kind: 'showing', threadId } satisfies Win32DialogWorkerMessage)
    })
    post({ kind: 'done', path } satisfies Win32DialogWorkerMessage)
  } catch (error: unknown) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    post({ kind: 'error', message } satisfies Win32DialogWorkerMessage)
  }
})()
