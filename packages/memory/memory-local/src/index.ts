/**
 * 宿主文件系统上的 `ctx.memory` Provider：每个项目一个目录，记忆写成本地 Markdown，
 * 项目真实路径记在同目录的 `project.json` 里。
 *
 * @module coding-memory-local
 */

import { open, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from 'coding-atomic-write'
import {
  Memory,
  MemoryConfig,
  PROJECT_META_FILE,
  memoryTitle,
  type MemoryConfig as MemoryConfigShape,
  type MemoryFileSummary,
  type MemoryProject,
} from 'coding-memory'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const TITLE_BYTES = 4096

/** 本地记忆 Provider 的配置：与记忆策略相同，`root` 省略时为 `<数据主目录>/memory`。 */
export type Config = MemoryConfigShape

/**
 * 把记忆写进 `<root>/<项目键>/` 的 Provider。目录权限为 0700、文件为 0600，写入走
 * 原子替换，因此中断不会留下半个文件；`project.json` 记录项目真实路径，方便人确认
 * 这份记忆属于哪个项目，也不参与模型可见的文件列表。
 */
export class LocalMemory extends Memory {
  static Config: z<Config> = MemoryConfig

  protected async listFiles(project: MemoryProject): Promise<MemoryFileSummary[]> {
    let entries
    try {
      entries = await readdir(project.directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const files: MemoryFileSummary[] = []
    for (const entry of entries) {
      // 只把 .md 当记忆条目：project.json 是本 Provider 的元数据，不是模型可见内容。
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const path = join(project.directory, entry.name)
      const info = await stat(path)
      const head = await readHead(path, TITLE_BYTES)
      files.push({
        name: entry.name,
        title: headingOf(head) ?? memoryTitle(entry.name),
        bytes: info.size,
        updatedAt: new Date(info.mtimeMs).toISOString(),
      })
    }
    return files
  }

  protected async readFile(project: MemoryProject, name: string): Promise<string | undefined> {
    const path = await memoryFilePath(project, name)
    try {
      const handle = await open(path, 'r')
      try {
        return await handle.readFile({ encoding: 'utf8' })
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  protected async writeFile(project: MemoryProject, name: string, content: string): Promise<void> {
    await mkdir(project.directory, { recursive: true, mode: DIRECTORY_MODE })
    await ensureProjectDirectory(project)
    const path = join(project.directory, name)
    await writeFileAtomic(path, content, { mode: FILE_MODE })
    await writeFileAtomic(
      join(project.directory, PROJECT_META_FILE),
      `${JSON.stringify({ path: project.path, key: project.key, lastUsedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: FILE_MODE },
    )
  }

  protected async removeFile(project: MemoryProject, name: string): Promise<boolean> {
    const path = await memoryFilePath(project, name)
    try {
      await stat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    await rm(path, { force: true })
    return true
  }
}

export default LocalMemory

/**
 * 确认项目目录真的落在记忆根之下：目录一旦被换成 symlink，读写就会跑到根外。
 *
 * 比较用的是「记忆根真实路径 + 项目键」，而不是 `realpath(目录) === resolve(目录)`：
 * macOS 的 `/var` 自身就是指向 `/private/var` 的链接，后者会对任何临时目录误报。
 * @param project - 项目身份。
 * @returns 该目录应当解析成的真实路径。
 */
async function ensureProjectDirectory(project: MemoryProject): Promise<string> {
  const expected = join(await realpath(dirname(project.directory)), basename(project.directory))
  const canonical = await realpath(project.directory)
  if (canonical !== expected) {
    throw new Error(`memory: refusing to write through a redirected project directory ${project.directory}`)
  }
  return canonical
}

/**
 * 解析一个记忆文件路径，并确认它的目录就是项目目录（防住目录被换成 symlink）；
 * 目录还不存在时按首次写入处理，由 {@link LocalMemory.writeFile} 创建。
 * @param project - 项目身份。
 * @param name - 已经过策略校验的记忆文件名。
 * @returns 记忆文件的绝对路径。
 */
async function memoryFilePath(project: MemoryProject, name: string): Promise<string> {
  const path = join(project.directory, name)
  try {
    await ensureProjectDirectory(project)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return path
}

async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

function headingOf(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const match = /^#{1,6}\s+(.*\S)\s*$/.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}
