/** 用户 PPT 模板的持久仓库；目录发布前先完整写入临时目录。 */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { withFileLock } from 'coding-atomic-write'
import type { Branded } from 'coding-brand'
import { isRecord, mediaPath, parseDeck, type PptDeck } from 'coding-ppt-model'
import { PptStoreError, withLock } from './store.ts'

/** 用户模板的跨工具调用身份，由仓库生成并在读取时校验。 */
export type PptTemplateId = Branded<'PptTemplateId'>

/** 模板列表与详情共用的元数据。 */
export interface PptTemplateSummary {
  readonly id: PptTemplateId
  readonly name: string
  readonly pages: number
  readonly createdAt: number
  readonly sourceName: string | null
  readonly dropped: readonly string[]
}

/** 模板详情包含可编辑的完整演示文稿。 */
export interface PptTemplateDetail extends PptTemplateSummary {
  readonly deck: PptDeck
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_TEMPLATES = 100
const MAX_BYTES = 100 * 1024 * 1024
const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_DROPPED = 100

function invalid(message: string): never {
  throw new PptStoreError('bad-request', message)
}

function safeId(id: string): PptTemplateId {
  if (typeof id !== 'string' || !ID.test(id)) invalid('模板 id 必须是 UUID')
  return id as PptTemplateId
}

function label(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    invalid(`${field} 必须是 1 到 200 字符的非空文本`)
  }
  return value.trim()
}

function metadata(value: unknown, id: PptTemplateId): Omit<PptTemplateDetail, 'deck'> {
  if (!isRecord(value) || value.id !== id || typeof value.createdAt !== 'number'
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !Number.isSafeInteger(value.pages) || (value.pages as number) < 1
    || (value.sourceName !== null && typeof value.sourceName !== 'string')
    || !Array.isArray(value.dropped) || value.dropped.length > MAX_DROPPED) {
    invalid(`模板 ${id} 的元数据不合法`)
  }
  const name = label(value.name, '模板名称')
  const sourceName = value.sourceName === null ? null : label(value.sourceName, '来源文件名')
  const dropped = (value.dropped as unknown[]).map(item => label(item, '丢失项'))
  return { id, name, pages: value.pages as number, createdAt: value.createdAt, sourceName, dropped }
}

function sources(deck: PptDeck): Set<string> {
  const result = new Set(deck.pages.flatMap(page => page.elements.flatMap(element => (
    element.kind === 'image' ? [element.source] : []
  ))))
  for (const source of result) if (source === 'media/.') invalid('媒体路径必须指向文件')
  return result
}

async function directory(path: string, missing = false): Promise<boolean> {
  const info = await lstat(path).catch((error: unknown) => {
    if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (info === null) return false
  if (info.isSymbolicLink()) throw new PptStoreError('forbidden', `${path} 不允许符号链接`)
  if (!info.isDirectory()) invalid(`${path} 不是安全目录`)
  return true
}

async function regular(path: string, max: number): Promise<number> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new PptStoreError('forbidden', `${path} 不允许符号链接`)
  if (!info.isFile() || info.size > max) invalid(`${path} 不是允许的普通文件或超出大小限制`)
  return info.size
}

function templateJson(summary: PptTemplateSummary, deck: PptDeck): string {
  return `${JSON.stringify({ version: 1, metadata: summary, deck }, null, 2)}\n`
}

function checkBudget(json: string, mediaBytes: number): void {
  const size = Buffer.byteLength(json)
  if (size > MAX_JSON_BYTES || mediaBytes + size > MAX_BYTES) invalid('模板超出大小限制')
}

async function safeRead(path: string, max: number): Promise<Uint8Array> {
  await regular(path, max)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > max) invalid(`${path} 不是允许的普通文件或超出大小限制`)
    const bytes = new Uint8Array(await handle.readFile())
    if (bytes.byteLength > max) invalid(`${path} 不是允许的普通文件或超出大小限制`)
    return bytes
  } finally {
    await handle.close()
  }
}

/** 用户整稿模板仓库；读写共享跨进程锁，损坏模板须先由操作者核查修复。 */
export class PptTemplateStore {
  private readonly root: string

  /**
   * @param root - 宿主提供的模板目录；仓库不读取环境变量或注册 Cordis 服务。
   */
  constructor(root: string) {
    this.root = resolve(root)
  }

  private locked<T>(run: () => Promise<T>): Promise<T> {
    return withLock(this.root, async () => {
      try {
        await this.checkRoot(true)
        // 所有读取与变更都参与同一把锁，配额检查与目录发布也跨 Host 串行。
        // 意外退出留下的 .catalog.lock 需操作者确认无持有者后手工恢复。
        return await withFileLock(join(this.root, '.catalog'), run)
      } catch (error) {
        if (error instanceof PptStoreError) throw error
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new PptStoreError('not-found', '找不到 PPT 模板或其媒体文件')
        }
        if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
          throw new PptStoreError('forbidden', '模板目录或媒体不允许符号链接')
        }
        if (error instanceof Error && error.message.startsWith('atomic-write: timed out waiting for the writer lock')) {
          throw new PptStoreError('conflict', 'PPT 模板仓库锁等待超时；请确认是否仍有 Host 持有锁')
        }
        throw new PptStoreError('bad-request', `PPT 模板数据无效：${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  private async checkRoot(create = false): Promise<boolean> {
    if (create) await mkdir(this.root, { recursive: true })
    return directory(this.root, true)
  }

  private async loadStructure(id: string): Promise<{
    detail: PptTemplateDetail
    media: readonly { part: string; path: string; size: number }[]
    totalBytes: number
  }> {
    const templateId = safeId(id)
    if (!await this.checkRoot()) throw new PptStoreError('not-found', `找不到模板 ${id}`)
    const path = join(this.root, id)
    if (!await directory(path, true)) throw new PptStoreError('not-found', `找不到模板 ${id}`)
    for (const entry of await readdir(path)) {
      if (entry !== 'template.json' && entry !== 'media') {
        invalid(`模板 ${id} 含未知条目 ${entry}，拒绝读取或删除`)
      }
    }
    const bytes = await safeRead(join(path, 'template.json'), MAX_JSON_BYTES).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') invalid(`模板 ${id} 缺少 template.json`)
      throw error
    })
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      invalid(`模板 ${id} 的 template.json 不是合法 JSON`)
    }
    if (!isRecord(raw) || raw.version !== 1) invalid(`模板 ${id} 的格式版本不受支持`)
    const deck = parseDeck(raw.deck)
    if (!isRecord(raw.metadata)) invalid(`模板 ${id} 的元数据不合法`)
    const summary = metadata(raw.metadata, templateId)
    if (summary.pages !== deck.pages.length || deck.title.trim().length === 0) {
      invalid(`模板 ${id} 的页数或标题不合法`)
    }
    const referenced = sources(deck)
    const mediaDir = join(path, 'media')
    const hasMedia = await directory(mediaDir, true)
    if (referenced.size > 0 && !hasMedia) invalid(`模板 ${id} 缺少媒体目录`)
    const entries = hasMedia ? await readdir(mediaDir) : []
    if (entries.length !== referenced.size) invalid(`模板 ${id} 的媒体清单与页面引用不一致`)
    let total = bytes.byteLength
    const media: { part: string; path: string; size: number }[] = []
    for (const file of entries.sort()) {
      const source = `media/${file}`
      if (!referenced.has(source)) invalid(`模板 ${id} 有未引用的媒体文件`)
      const imagePath = join(mediaDir, file)
      const size = await regular(imagePath, MAX_BYTES).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') invalid(`模板 ${id} 缺少媒体文件`)
        throw error
      })
      total += size
      if (total > MAX_BYTES) invalid(`模板 ${id} 超出大小限制`)
      media.push({ part: source, path: imagePath, size })
    }
    return { detail: { ...summary, deck }, media, totalBytes: total }
  }

  private async loadWithMedia(id: string): Promise<{
    detail: PptTemplateDetail
    media: readonly { part: string; bytes: Uint8Array }[]
  }> {
    const structure = await this.loadStructure(id)
    const media: { part: string; bytes: Uint8Array }[] = []
    let actualTotal = structure.totalBytes
    for (const item of structure.media) {
      const bytes = await safeRead(item.path, MAX_BYTES)
      actualTotal += bytes.byteLength - item.size
      if (actualTotal > MAX_BYTES) invalid(`模板 ${id} 超出大小限制`)
      media.push({ part: item.part, bytes })
    }
    return { detail: structure.detail, media }
  }

  private async load(id: string): Promise<PptTemplateDetail> {
    return (await this.loadStructure(id)).detail
  }

  /**
   * 列出模板；忽略无关文件，但不静默跳过损坏的 UUID 模板。
   * @returns 按创建时间倒序排列的模板摘要。
   * @throws PptStoreError - 模板损坏、超过数量上限或仓库锁超时时拒绝。
   */
  list(): Promise<readonly PptTemplateSummary[]> {
    return this.locked(async () => {
      if (!await this.checkRoot()) return []
      const ids = (await readdir(this.root)).filter(id => ID.test(id))
      if (ids.length > MAX_TEMPLATES) invalid('模板数量超出限制')
      const details: PptTemplateDetail[] = []
      for (const id of ids) details.push(await this.load(id))
      return details.map(({ deck: _deck, ...summary }) => summary)
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    })
  }

  /**
   * 读取完整模板，并校验磁盘元数据和媒体。
   * @param id - 模板 UUID。
   * @returns 可编辑的完整模板详情。
   * @throws PptStoreError - id 不合法、模板不存在或内容损坏时拒绝。
   */
  read(id: string): Promise<PptTemplateDetail> {
    return this.locked(() => this.load(id))
  }

  /**
   * 在一次锁内读取完整模板和全部媒体，供创建新工程时使用。
   * @param id - 模板 UUID。
   * @returns 同一模板快照中的详情与原始媒体字节。
   * @throws PptStoreError - 模板不存在、损坏或仓库锁超时时拒绝。
   */
  readWithMedia(id: string): Promise<{
    detail: PptTemplateDetail
    media: readonly { part: string; bytes: Uint8Array }[]
  }> {
    return this.locked(() => this.loadWithMedia(id))
  }

  /**
   * 将模板与全部原始媒体字节写入临时目录后一次发布。
   * @param options - 名称、演示文稿、与图片引用精确对应的媒体及可选来源信息。
   * @returns 发布后的模板详情。
   * @throws PptStoreError - 输入不合法、媒体不匹配、超过预算或仓库锁超时时拒绝。
   */
  create(options: {
    name: string
    deck: PptDeck
    media: readonly { part: string; bytes: Uint8Array }[]
    sourceName?: string
    dropped?: readonly string[]
  }): Promise<PptTemplateDetail> {
    return this.locked(async () => {
      const name = label(options.name, '模板名称')
      const deck = parseDeck(options.deck)
      if (deck.title.trim().length === 0) invalid('演示文稿标题不能为空')
      const sourceName = options.sourceName === undefined ? null : label(options.sourceName, '来源文件名')
      const dropped = options.dropped ?? []
      if (!Array.isArray(dropped) || dropped.length > MAX_DROPPED) invalid('丢失项数量超出限制')
      const cleanDropped = dropped.map(item => label(item, '丢失项'))
      const expected = sources(deck)
      if (!Array.isArray(options.media) || options.media.length !== expected.size) invalid('媒体与页面引用不一致')
      const files = new Map<string, Uint8Array>()
      let total = 0
      for (const { part, bytes } of options.media) {
        const source = mediaPath(part, '媒体路径')
        if (source === 'media/.') invalid('媒体路径必须指向文件')
        if (!expected.has(source) || files.has(source) || !(bytes instanceof Uint8Array)) {
          invalid('媒体与页面引用不一致或媒体字节不合法')
        }
        files.set(source, new Uint8Array(bytes))
        total += bytes.byteLength
        if (total > MAX_BYTES) invalid('模板媒体超出大小限制')
      }
      await this.checkRoot(true)
      const ids = (await readdir(this.root)).filter(id => ID.test(id))
      if (ids.length >= MAX_TEMPLATES) throw new PptStoreError('conflict', '模板数量已达上限')
      const id = safeId(randomUUID())
      const detail: PptTemplateDetail = {
        id, name, pages: deck.pages.length, createdAt: Date.now(), sourceName, dropped: cleanDropped, deck,
      }
      const { deck: storedDeck, ...summary } = detail
      const json = templateJson(summary, storedDeck)
      checkBudget(json, total)
      const temp = await mkdtemp(join(this.root, '.template-'))
      try {
        if (files.size > 0) await mkdir(join(temp, 'media'))
        for (const [source, bytes] of files) await writeFile(join(temp, source), bytes, { flag: 'wx' })
        await writeFile(join(temp, 'template.json'), json, { flag: 'wx' })
        if (await directory(join(this.root, id), true)) throw new PptStoreError('conflict', '模板 id 已存在')
        await rename(temp, join(this.root, id))
      } finally {
        await rm(temp, { recursive: true, force: true })
      }
      return detail
    })
  }

  /**
   * 原子更新模板名称，不修改 deck 与媒体。
   * @param id - 模板 UUID。
   * @param name - 新名称，去除首尾空白后必须非空。
   * @returns 更新后的模板摘要。
   * @throws PptStoreError - 模板损坏或新文件超过大小预算时保留旧文件并拒绝。
   */
  rename(id: string, name: string): Promise<PptTemplateSummary> {
    return this.locked(async () => {
      const detail = await this.load(id)
      const path = join(this.root, id, 'template.json')
      const summary = { ...detail, name: label(name, '模板名称') }
      const { deck: storedDeck, ...metadata } = summary
      const json = templateJson(metadata, storedDeck)
      let mediaBytes = 0
      for (const source of sources(storedDeck)) {
        mediaBytes += await regular(join(this.root, id, source), MAX_BYTES)
      }
      checkBudget(json, mediaBytes)
      const temp = join(this.root, id, `.template-${randomUUID()}.tmp`)
      try {
        await writeFile(temp, json, { flag: 'wx' })
        await rename(temp, path)
      } finally {
        await rm(temp, { force: true })
      }
      const { deck: _deck, ...result } = summary
      return result
    })
  }

  /**
   * 仅删除已完整校验的模板；损坏内容不能绕过校验递归删除。
   * @param id - 模板 UUID。
   * @param expectedName - 可选的确认名称；与当前名称不同则拒绝删除。
   * @returns 删除完成时的 Promise。
   * @throws PptStoreError - 模板不存在、损坏、确认名称不符或仓库锁超时时拒绝。
   */
  delete(id: string, expectedName?: string): Promise<void> {
    return this.locked(async () => {
      const detail = await this.load(id)
      if (expectedName !== undefined && expectedName !== detail.name) {
        throw new PptStoreError('conflict', '模板名称已变化，未删除；请重新确认当前名称')
      }
      await rm(join(this.root, id), { recursive: true })
    })
  }

  /**
   * 读取 deck 正在引用的单层媒体文件，保持原始字节。
   * @param id - 模板 UUID。
   * @param source - `media/<文件名>` 相对路径。
   * @returns 媒体原始字节。
   * @throws PptStoreError - 路径越界、模板损坏或媒体未被引用时拒绝。
   */
  readMedia(id: string, source: string): Promise<Uint8Array> {
    return this.locked(async () => {
      safeId(id)
      const path = mediaPath(source, '媒体路径')
      if (path === 'media/.') invalid('媒体路径必须指向文件')
      const structure = await this.loadStructure(id)
      const media = structure.media.find(item => item.part === path)
      if (media === undefined) throw new PptStoreError('not-found', '模板没有引用该媒体')
      const bytes = await safeRead(media.path, MAX_BYTES)
      if (structure.totalBytes - media.size + bytes.byteLength > MAX_BYTES) invalid(`模板 ${id} 超出大小限制`)
      return bytes
    })
  }
}
