/** 模型可传入的文件路径边界：上传只读取工作区常规文件，输出只写工作区内的新文件。 @module coding-tool-browser-ego/paths */

import { realpath, lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_PATH_CHARS = 1024

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function checkedPath(value: unknown, toolName: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_CHARS
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${toolName}: path must be a non-empty filename of at most ${MAX_PATH_CHARS} characters`)
  }
  return value
}

async function workspaceRoot(cwd: string | undefined, toolName: string, signal: AbortSignal): Promise<string> {
  if (cwd === undefined) throw new Error(`${toolName}: a session workspace is required for file access`)
  signal.throwIfAborted()
  try { return await realpath(cwd) } catch { throw new Error(`${toolName}: the session workspace is unavailable`) }
}

/**
 * 上传前以真实路径核对归属，防止工作区符号链接指向凭据和特殊设备。
 * @param cwd 会话工作区，不能退回进程当前目录。
 * @param input 模型指定的单文件路径。
 * @param signal 调用取消信号。
 * @returns 位于工作区内的常规文件真实绝对路径。
 */
export async function uploadPath(cwd: string | undefined, input: unknown, signal: AbortSignal): Promise<string> {
  const toolName = 'browser_upload'
  const raw = checkedPath(input, toolName)
  const root = await workspaceRoot(cwd, toolName, signal)
  signal.throwIfAborted()
  let target: string
  try { target = await realpath(resolve(root, raw)) } catch { throw new Error(`${toolName}: file is unavailable`) }
  if (target === root || !inside(root, target)) throw new Error(`${toolName}: file must remain inside the session workspace`)
  if (raw.endsWith(sep)) throw new Error(`${toolName}: path must refer to a regular file`)
  signal.throwIfAborted()
  try {
    if (!(await lstat(target)).isFile()) throw new Error('not a regular file')
  } catch { throw new Error(`${toolName}: path must refer to a regular file`) }
  signal.throwIfAborted()
  return target
}

/**
 * 截图和下载只接受已存在的工作区目录下尚不存在的文件名；不创建目录、不覆盖文件或符号链接。
 * @param cwd 会话工作区根。
 * @param input 模型指定的输出文件名。
 * @param toolName 报错所用的公开工具名。
 * @param signal 调用取消信号。
 * @returns 提供方可用的绝对路径。
 */
export async function newWorkspacePath(cwd: string | undefined, input: unknown, toolName: string,
  signal: AbortSignal): Promise<string> {
  const raw = checkedPath(input, toolName)
  const root = await workspaceRoot(cwd, toolName, signal)
  if (raw.endsWith(sep) || basename(raw) === '.' || basename(raw) === '..') {
    throw new Error(`${toolName}: output filename is invalid`)
  }
  signal.throwIfAborted()
  let parent: string
  try { parent = await realpath(dirname(resolve(root, raw))) } catch {
    throw new Error(`${toolName}: output directory is unavailable`)
  }
  if (!inside(root, parent)) throw new Error(`${toolName}: output must remain inside the session workspace`)
  const target = resolve(parent, basename(raw))
  if (target === root || !inside(root, target)) {
    throw new Error(`${toolName}: output must remain inside the session workspace`)
  }
  signal.throwIfAborted()
  try {
    await lstat(target)
    throw new Error(`${toolName}: output file already exists`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  signal.throwIfAborted()
  return target
}

/**
 * 截图读取前核对提供方报告的路径确属本次授权的文件，而非另一个本地文件。
 * @param expected 本次调用指定的路径。
 * @param reported 提供方返回的路径。
 * @param signal 调用取消信号。
 * @returns 可读取的常规文件真实路径。
 */
export async function screenshotPath(expected: string, reported: unknown, signal: AbortSignal): Promise<string> {
  if (typeof reported !== 'string' || reported !== expected) throw new Error('browser_screenshot: unexpected image path')
  signal.throwIfAborted()
  let actual: string
  try { actual = await realpath(reported) } catch { throw new Error('browser_screenshot: image is unavailable') }
  if (actual !== expected) throw new Error('browser_screenshot: image path changed')
  const info = await lstat(expected)
  if (!info.isFile()) throw new Error('browser_screenshot: image must be a regular file')
  signal.throwIfAborted()
  return actual
}
