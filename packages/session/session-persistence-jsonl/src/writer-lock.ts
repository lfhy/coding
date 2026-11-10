/**
 * 以不会删除的旁路文件持有内核排他锁；进程退出自动释放，不依赖超时或 PID。
 * @module coding-session-persistence-jsonl/writer-lock
 */

import { open } from 'node:fs/promises'
import { toNamespacedPath } from 'node:path'
import koffi from 'koffi'

type Release = () => Promise<void>

let flock: ((fd: number, operation: number) => number) | undefined
let windows: {
  createFile(path: string, access: number, share: number, security: null, disposition: number, flags: number, template: null): bigint | null
  closeHandle(handle: bigint): number
  getLastError(): number
} | undefined

function lockError(path: string, detail: string): Error {
  return new Error(`cannot acquire JSONL session writer ownership for "${path}" (${detail}); another backend or process may own this session; stop its writer before resuming or repairing it`)
}

/**
 * 非阻塞取得旁路文件的排他所有权；调用方不得删除或替换该文件。
 * @param path - 会话目录内固定的锁文件绝对路径。
 * @returns 完全停稳后调用的释放函数；任何加锁失败均拒绝写入。
 */
export async function acquireWriterLock(path: string): Promise<Release> {
  if (process.platform === 'win32') {
    if (windows === undefined) {
      const kernel = koffi.load('kernel32.dll')
      windows = {
        createFile: kernel.func('__stdcall', 'CreateFileW', 'void *', ['str16', 'uint', 'uint', 'void *', 'uint', 'uint', 'void *']),
        closeHandle: kernel.func('__stdcall', 'CloseHandle', 'int', ['void *']),
        getLastError: kernel.func('__stdcall', 'GetLastError', 'uint', []),
      }
    }
    // 不共享删除权限，避免其他进程替换锁文件后绕过现有所有者。
    const api = windows
    const handle = api.createFile(toNamespacedPath(path), 0xC0000000, 0, null, 4, 0, null)
    if (handle === null || handle === -1n || handle === 0xFFFFFFFFFFFFFFFFn) {
      throw lockError(path, `Win32 ${api.getLastError()}`)
    }
    return () => {
      if (api.closeHandle(handle) === 0) throw lockError(path, `CloseHandle Win32 ${api.getLastError()}`)
      return Promise.resolve()
    }
  }

  flock ??= koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6')
    .func('flock', 'int', ['int', 'int'])
  const handle = await open(path, 'a+', 0o600)
  // LOCK_EX | LOCK_NB；独立 open 的描述符也会与同进程其他后端互斥。
  if (flock(handle.fd, 2 | 4) !== 0) {
    const errno = koffi.errno()
    await handle.close()
    throw lockError(path, `flock errno ${errno}`)
  }
  return () => handle.close()
}
