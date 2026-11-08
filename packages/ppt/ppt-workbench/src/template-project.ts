/** 模板套用和 PPTX 导入共用的本机工程准入与原子发布。 */
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { mediaPath, parseDeck, type PptDeck } from 'coding-ppt-model'
import { PptStoreError, createProjectFromDeck, resolveProjectDir, type PptSnapshot } from './store.ts'

const MAX_MEDIA_BYTES = 100 * 1024 * 1024

function failure(error: unknown, path: string): never {
  if (error instanceof PptStoreError) throw error
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT') throw new PptStoreError('not-found', `找不到文件或目录：${path}`)
  if (code === 'EEXIST' || code === 'ENOTEMPTY') throw new PptStoreError('conflict', `目标目录已经存在：${path}`)
  if (code === 'ELOOP') throw new PptStoreError('forbidden', `路径不允许符号链接：${path}`)
  throw new PptStoreError('bad-request', `无法访问 PPT 文件或目录 ${path}：${error instanceof Error ? error.message : String(error)}`)
}

/** 检查路径的每级现存目录，不允许 symlink；缺少的尾部只在新建目标时允许。 */
async function localPath(root: string, target: string, createParent: boolean): Promise<string> {
  const base = resolve(root)
  const absolute = resolveProjectDir(base, target)
  let canonical: string
  try { canonical = await realpath(base) } catch (error) { failure(error, base) }
  const segments = relative(base, absolute).split(sep).filter(Boolean)
  let current = canonical
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    const last = index === segments.length - 1
    let info
    try { info = await lstat(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !createParent) failure(error, current)
      if (last) break
      try { await mkdir(current) } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') failure(mkdirError, current)
      }
      try { info = await lstat(current) } catch (readError) { failure(readError, current) }
    }
    if (info.isSymbolicLink()) throw new PptStoreError('forbidden', `路径不允许符号链接：${current}`)
    if (!last && !info.isDirectory()) throw new PptStoreError('bad-request', `工程路径的上级不是目录：${current}`)
  }
  return join(base, ...segments)
}

/** 严格读取本机普通文件；文件必须位于真实工作区，且读取过程中不能换成符号链接。
 * @param root - 工作区目录。
 * @param path - 工作区内的文件路径。
 * @param max - 最大读取字节数，增长中的文件也受此上限约束。
 * @returns 原始文件字节。
 * @throws PptStoreError 缺失、越界、链接、非普通文件或超出大小限制时。
 */
export async function readWorkspaceFile(root: string, path: string, max: number): Promise<Uint8Array> {
  const target = await localPath(root, path, false)
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink()) throw new PptStoreError('forbidden', `文件不允许符号链接：${target}`)
    if (!info.isFile() || info.size > max) throw new PptStoreError('bad-request', `文件不是普通文件或超出大小限制：${target}`)
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size > max) throw new PptStoreError('bad-request', `文件不是普通文件或超出大小限制：${target}`)
      const chunks: Uint8Array[] = []
      let total = 0
      const buffer = Buffer.allocUnsafe(64 * 1024)
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > max) throw new PptStoreError('bad-request', `文件超出大小限制：${target}`)
        chunks.push(new Uint8Array(buffer.subarray(0, bytesRead)))
      }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      return bytes
    } finally { await handle.close() }
  } catch (error) { failure(error, target) }
}

/** 完整读取 deck 引用的媒体；缺图、越界和符号链接均失败，不生成不完整模板。
 * @param root - 工作区目录。
 * @param dir - 原工程目录。
 * @param deck - 已校验的演示文稿。
 * @returns 去重后的媒体原字节与路径。
 * @throws PptStoreError 文件缺失、不安全或媒体总量超限时。
 */
export async function readWorkspaceMedia(root: string, dir: string, deck: PptDeck): Promise<readonly {
  part: string
  bytes: Uint8Array
}[]> {
  const sources = new Set(deck.pages.flatMap(page => page.elements.flatMap(element => (
    element.kind === 'image' ? [element.source] : []
  ))))
  const result: { part: string; bytes: Uint8Array }[] = []
  let total = 0
  for (const source of sources) {
    const part = mediaPath(source, '媒体路径')
    if (part === 'media/.') throw new PptStoreError('bad-request', '媒体路径必须指向文件')
    const bytes = await readWorkspaceFile(root, join(dir, part), MAX_MEDIA_BYTES)
    total += bytes.byteLength
    if (total > MAX_MEDIA_BYTES) throw new PptStoreError('bad-request', '模板媒体超出大小限制')
    result.push({ part, bytes })
  }
  return result
}

/** 新工程先写入同父临时目录，独占预留空目标后原子发布；失败只清理本次创建的内容。
 * @param root - 工作区目录。
 * @param target - 目标工程目录；必须尚不存在。
 * @param deck - 新工程的初始演示文稿。
 * @param media - deck 引用的全部图片原字节。
 * @returns 修订号为 1 的工程快照。
 * @throws PptStoreError 目录已存在、路径不安全、媒体缺失或发布失败时。
 */
export async function publishProject(root: string, target: string, deck: PptDeck, media: readonly {
  part: string
  bytes: Uint8Array
}[]): Promise<PptSnapshot> {
  const path = await localPath(root, target, true)
  const parent = dirname(path)
  if (path === resolve(root) || basename(path) === '.') {
    throw new PptStoreError('forbidden', '不能把工作区根目录用作 PPT 工程')
  }
  const parsed = parseDeck(deck)
  const referenced = new Set(parsed.pages.flatMap(page => page.elements.flatMap(element => (
    element.kind === 'image' ? [element.source] : []
  ))))
  const files = new Map<string, Uint8Array>()
  for (const entry of media) {
    const part = mediaPath(entry.part, '媒体路径')
    if (part === 'media/.' || !referenced.has(part) || files.has(part) || !(entry.bytes instanceof Uint8Array)) {
      throw new PptStoreError('bad-request', '工程媒体与页面引用不一致')
    }
    files.set(part, entry.bytes)
  }
  if (files.size !== referenced.size) throw new PptStoreError('bad-request', '工程缺少页面引用的媒体')
  let temp: string
  try { temp = await mkdtemp(join(parent, '.ppt-project-')) } catch (error) { failure(error, parent) }
  let reserved = false
  let reservation: { dev: number; ino: number } | undefined
  try {
    const snapshot = await createProjectFromDeck(temp, parsed)
    if (files.size > 0) await mkdir(join(temp, 'media'))
    for (const [part, bytes] of files) await writeFile(join(temp, part), bytes, { flag: 'wx' })
    try { await mkdir(path) } catch (error) { failure(error, path) }
    reserved = true
    reservation = await stat(path)
    await rename(temp, path)
    reserved = false
    return { ...snapshot, dir: path }
  } catch (error) {
    if (reserved && reservation !== undefined) {
      const actual = await lstat(path).catch(() => undefined)
      if (actual?.ino === reservation.ino && actual.dev === reservation.dev) await rmdir(path).catch(() => undefined)
    }
    failure(error, path)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
