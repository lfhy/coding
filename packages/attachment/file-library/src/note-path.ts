/** 笔记路径的词法校验、实际父目录身份和共用错误。 */
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { sameEntry } from './private-files.ts'

/** 幻灯片工程目录的后缀；真实工程目录是笔记树的叶子。 */
export const NOTE_DECK_SUFFIX = '.codingppt'

/** 笔记目录树的最大深度；根目录为零层。 */
export const NOTE_MAX_DEPTH = 8

/** 笔记或目录已不存在，调用方可以刷新目录。 */
export class NoteNotFoundError extends Error {
  constructor() { super('笔记不存在') }
}

/** 笔记操作与当前磁盘状态冲突；调用方应刷新后重试。 */
export class NoteConflictError extends Error {}

/** 保存时检测到笔记在读后被修改；编辑端应重新加载。 */
export class StaleNoteError extends NoteConflictError {
  constructor() { super('笔记已被外部修改') }
}

/**
 * 判断目录是否按名称表示幻灯片工程。
 * @param name - 单段目录名。
 * @returns 具有非空名称和 `.codingppt` 后缀时为真。
 */
export function isDeckDirectoryName(name: string): boolean {
  return name.length > NOTE_DECK_SUFFIX.length && name.toLowerCase().endsWith(NOTE_DECK_SUFFIX)
}

/**
 * 解析相对笔记路径；拒绝绝对路径、空段、`.`、`..` 和 Windows 设备路径别名。
 * @param root - 笔记根目录的绝对路径。
 * @param relativePath - 客户端提交的路径。
 * @returns 斜杠分隔的相对路径、路径段和词法绝对路径；调用方仍需检查磁盘条目。
 */
export function noteTarget(root: string, relativePath: string): { rel: string; segments: string[]; target: string } {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(relativePath) || /^[a-zA-Z]:/u.test(relativePath)) {
    throw new TypeError('笔记路径无效')
  }
  const segments = relativePath.split(/[\\/]/u)
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..'
    || process.platform === 'win32' && /[:<>|"?*]|[ .]$/u.test(segment))) {
    throw new TypeError('笔记路径无效')
  }
  return { rel: segments.join('/'), segments, target: join(root, ...segments) }
}

/** 实际父目录以及供提交检查使用的根和目录身份。 */
export interface NoteParent {
  root: string
  target: string
  rootInfo: Stats
  info: Stats
}

async function actualDirectory(path: string): Promise<Stats> {
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NoteNotFoundError()
    throw error
  })
  const uid = process.getuid?.()
  if (!info.isDirectory() || info.isSymbolicLink() || uid !== undefined && info.uid !== uid) {
    throw new TypeError('笔记目录无效')
  }
  return info
}

/**
 * 逐段检查真实父链；禁止内部符号链接和不透明的幻灯片目录。
 * @param notesDirectory - 已由文件库核对身份的笔记根目录。
 * @param segments - 通过词法校验的父目录段。
 * @param repair - 是否将中间目录收紧为私有目录。
 * @returns 实际目录及其身份；缺失时抛出 `NoteNotFoundError`。
 */
export async function strictNoteParent(notesDirectory: string, segments: readonly string[], repair = false): Promise<NoteParent> {
  if (segments.length > NOTE_MAX_DEPTH) throw new TypeError('笔记目录层级过深')
  if (segments.some(isDeckDirectoryName)) throw new TypeError('不能将幻灯片工程用作笔记目录')
  const rootInfo = await actualDirectory(notesDirectory)
  const root = await realpath(notesDirectory)
  if (!sameEntry(rootInfo, await actualDirectory(root))) throw new NoteConflictError('笔记根目录已更换')
  let target = root
  let info = rootInfo
  for (const segment of segments) {
    target = join(target, segment)
    info = await actualDirectory(target)
    if (await realpath(target) !== target) throw new TypeError('笔记目录无效')
    if (repair && process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        if (!sameEntry(info, await handle.stat())) throw new NoteConflictError('笔记目录已更换')
        await handle.chmod(0o700)
        await handle.sync()
      } finally { await handle.close() }
    }
  }
  return { root, target, rootInfo, info }
}
