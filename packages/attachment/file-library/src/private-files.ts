/** 笔记与文件库共用的安全文件名和磁盘同步工具。 */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 净化单个文件名，保留可识别后缀，并按 UTF-8 字节限制长度。
 * @param name - 可带来源目录的用户文件名。
 * @returns 独立于来源路径的安全文件名。
 */
export function safeName(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 1024 || name.includes('\0')) {
    throw new TypeError('文件名无效')
  }
  const leaf = name.split(/[/\\]/u).at(-1)?.replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  const safe = leaf?.replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^\.+/u, '').trim()
  if (!safe) throw new TypeError('文件名无效')
  const dot = safe.lastIndexOf('.')
  const extension = dot > 0 && Buffer.byteLength(safe.slice(dot), 'utf8') <= 32 ? safe.slice(dot) : ''
  const stem = extension ? safe.slice(0, -extension.length) : safe
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(safe) ? '_' : ''
  let result = reserved
  for (const character of stem) {
    if (Buffer.byteLength(result + character + extension, 'utf8') > 120) break
    result += character
  }
  result = result.replace(/[ .]+$/u, '') + extension
  if (!result || result === extension) throw new TypeError('文件名无效')
  return result
}

/**
 * 同步目录条目；Windows 不提供可移植的目录同步。
 * @param path - 需要同步的真实目录。
 * @returns 目录同步完成。
 */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

interface EntryIdentity { dev: number; ino: number }

/**
 * 比较已经检查过类型的磁盘条目是否为同一个文件系统对象。
 * @param first - 初次取得的身份。
 * @param second - 再次检查的身份。
 * @returns 设备号和索引节点均相同时为真。
 */
export function sameEntry(first: EntryIdentity, second: EntryIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

/**
 * 先同步私有临时文件，再原子发布并同步父目录；独占发布不会覆盖同名条目。
 * @param target - 已通过调用方路径校验的目标。
 * @param bytes - 要完整发布的文件字节。
 * @param options - 指定独占创建和原子发布前的再次校验。
 * @returns 发布并同步完成；失败只清理仍拥有的临时条目。
 */
export async function writeNoteBytes(
  target: string, bytes: Uint8Array, options: { exclusive?: boolean; beforeCommit?: () => Promise<void> } = {},
): Promise<void> {
  const directory = dirname(target)
  const temporary = join(directory, `.note-${randomUUID()}.tmp`)
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
  const handle = await open(temporary, flags, 0o600)
  let owned: EntryIdentity | undefined
  try {
    try {
      owned = await handle.stat()
      await handle.writeFile(bytes)
      await handle.sync()
    } finally { await handle.close() }
    const staged = await lstat(temporary)
    if (!staged.isFile() || !sameEntry(staged, owned)) throw new Error('笔记临时文件已更换')
    await options.beforeCommit?.()
    if (options.exclusive) await link(temporary, target)
    else await rename(temporary, target)
  } finally {
    if (owned !== undefined) {
      try {
        const staged = await lstat(temporary)
        if (staged.isFile() && sameEntry(staged, owned)) await unlink(temporary)
      } catch { /* 清理不得覆盖提交错误或涉及后来替换的条目。 */ }
    }
  }
  await syncDirectory(directory)
}
