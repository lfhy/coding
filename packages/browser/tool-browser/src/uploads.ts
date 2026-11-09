/** 浏览器上传文件的模型输入边界：路径形状、会话工作区或文件库归属与常规文件检查。 @module coding-tool-browser/uploads */

import type { Stats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** 单次上传的文件数上限；一次 `browser_upload` 对应一个文件输入控件的一次选择。 */
export const MAX_UPLOAD_FILES = 8
/** 单个路径的字符上限；与导航 URL 同级，避免模型输入撑大工具参数。 */
export const MAX_UPLOAD_PATH_CHARS = 1024

/**
 * 校验模型给出的 `files` 形状，返回去掉重复引用的原样路径列表。
 * 这里只判断是否像一组路径；解析、归属与文件类型留给 {@link resolveUploadFiles}，
 * 因为它们是异步 I/O，且必须在审批前完成。
 * @param raw - 工具参数中的原始 `files`。
 * @returns 通过形状检查的路径数组。
 */
export function validateUploadPaths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_UPLOAD_FILES) {
    throw new Error(`browser_upload: files must be a non-empty array of at most ${MAX_UPLOAD_FILES} paths`)
  }
  return raw.map((entry: unknown, index: number) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_UPLOAD_PATH_CHARS) {
      throw new Error(`browser_upload: files[${index}] must be a non-empty path of at most ${MAX_UPLOAD_PATH_CHARS} characters`)
    }
    if (/[\u0000-\u001f]/.test(entry)) {
      throw new Error(`browser_upload: files[${index}] must not contain control characters`)
    }
    return entry
  })
}

/**
 * 把模型给出的路径解析成提供方可直接打开的本机绝对路径。
 * 工作区归属按真实路径判断；工作区外仅接受文件库确认登记的绝对上传路径。
 * 工作区符号链接不能借目标为受管理文件取得权限；目录、设备文件与不存在的路径都在审批前拒绝。
 * @param cwd - 调用会话不可变的工作区根；会话没有工作区时拒绝。
 * @param files - 已通过形状检查的路径，可以是工作区相对路径或绝对路径。
 * @param signal - 调用方取消信号；每次 I/O 前检查。
 * @param isManagedUploadPath - 可选的 Host 文件库归属检查；缺席时只接受工作区文件。
 * @returns 与输入顺序一致的绝对路径，供提供方交给文件输入控件。
 */
export async function resolveUploadFiles(cwd: string | undefined, files: readonly string[],
  signal: AbortSignal, isManagedUploadPath?: (path: string) => Promise<boolean>): Promise<string[]> {
  if (cwd === undefined) {
    throw new Error('browser_upload: this session has no workspace directory; uploads must come from the session workspace')
  }
  signal.throwIfAborted()
  let root: string
  try { root = await realpath(cwd) } catch {
    throw new Error('browser_upload: the session workspace directory is unavailable')
  }
  const resolvedFiles: string[] = []
  for (const file of files) {
    signal.throwIfAborted()
    let target: string
    try { target = await realpath(resolve(root, file)) } catch {
      throw new Error(`browser_upload: no such file: ${file}`)
    }
    const within = relative(root, target)
    if (within === '') throw new Error(`browser_upload: only files inside the session workspace can be uploaded: ${file}`)
    if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) {
      signal.throwIfAborted()
      if (!isAbsolute(file) || !isManagedUploadPath || !await isManagedUploadPath(file)) {
        throw new Error(`browser_upload: only files inside the session workspace or registered uploads can be uploaded: ${file}`)
      }
      signal.throwIfAborted()
    }
    let info: Stats
    try { info = await stat(target) } catch {
      throw new Error(`browser_upload: cannot read file: ${file}`)
    }
    if (!info.isFile()) throw new Error(`browser_upload: not a regular file: ${file}`)
    resolvedFiles.push(target)
  }
  signal.throwIfAborted()
  return resolvedFiles
}
