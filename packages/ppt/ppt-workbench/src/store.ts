/**
 * 工程存储：每个演示文稿是一个目录，`deck.json` 是唯一事实源，`history.json` 保存
 * 撤销／重做用的快照。写入先落临时文件再 rename，进程中断不会留下半个 JSON。
 *
 * 并发由进程内按目录串行化：同一工程的两次写入不会交错；跨进程（模型在另一个会话里
 * 改同一工程）由 `baseRevision` 乐观锁兜底，版本不符即拒绝。
 * @module coding-ppt-workbench/store
 */

import { mkdir, lstat, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { applyOps, parseOps, type PptOp } from './ops.ts'
import { isRecord, parseDeck, PPT_FORMAT, PPT_THEMES, type PptDeck, type SlideSizeId, type ThemeId } from 'coding-ppt-model'

/** 一次编辑的快照条目；`revision` 单调递增，撤销后仍然保留。 */
export interface PptHistoryEntry {
  readonly revision: number
  readonly deck: PptDeck
}

/** `history.json` 的磁盘结构。 */
export interface PptHistory {
  /** `entries` 中当前版本的下标。 */
  readonly cursor: number
  /** 下一次写入分配的版本号。 */
  readonly nextRevision: number
  readonly entries: readonly PptHistoryEntry[]
}

/** 一次读取返回的完整工程视图。 */
export interface PptSnapshot {
  /** 归一化后的绝对目录。 */
  readonly dir: string
  readonly title: string
  readonly revision: number
  readonly deck: PptDeck
  readonly pages: number
  readonly updatedAt: number
  readonly canUndo: boolean
  readonly canRedo: boolean
}

/** 工程列表条目。 */
export interface PptProjectSummary {
  readonly dir: string
  readonly title: string
  readonly pages: number
  readonly revision: number
  readonly updatedAt: number
}

/** 工程操作失败时抛出；`code` 供路由映射成 HTTP 状态码。 */
export class PptStoreError extends Error {
  constructor(readonly code: 'not-found' | 'conflict' | 'forbidden' | 'bad-request', message: string) {
    super(message)
    this.name = 'PptStoreError'
  }
}

const DECK_FILE = 'deck.json'
const HISTORY_FILE = 'history.json'
const MAX_ENTRIES = 60
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u

/** 每个目录一条写入链；键是解析后的绝对路径。 */
const queues = new Map<string, Promise<unknown>>()

/**
 * 把一个目录下的异步操作排进串行链。
 * @param dir - 归一化后的工程目录。
 * @param run - 需要独占该目录的操作。
 * @returns `run` 的结果。
 */
export async function withLock<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(dir) ?? Promise.resolve()
  const next = previous.then(run, run)
  queues.set(dir, next.catch(() => undefined))
  try {
    return await next
  } finally {
    if (queues.get(dir) === next) queues.delete(dir)
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8')
  try {
    return JSON.parse(raw)
  } catch {
    throw new PptStoreError('bad-request', `${path} 不是合法 JSON`)
  }
}

function historyOf(value: unknown): PptHistory {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new PptStoreError('bad-request', `${HISTORY_FILE} 结构不合法`)
  }
  const entries = value.entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.revision !== 'number' || !Number.isSafeInteger(entry.revision)) {
      throw new PptStoreError('bad-request', `${HISTORY_FILE} 里的版本号不合法`)
    }
    return { revision: entry.revision, deck: parseDeck(entry.deck) }
  })
  const cursor = typeof value.cursor === 'number' ? value.cursor : entries.length - 1
  const nextRevision = typeof value.nextRevision === 'number'
    ? value.nextRevision
    : (entries.at(-1)?.revision ?? 0) + 1
  if (entries.length === 0 || cursor < 0 || cursor >= entries.length) {
    throw new PptStoreError('bad-request', `${HISTORY_FILE} 的游标越界`)
  }
  return { cursor, nextRevision, entries }
}

/**
 * 把工程目录限制在会话工作区内。
 * @param root - 会话工作目录的绝对路径。
 * @param dir - 用户或模型给出的目录（绝对或相对）。
 * @returns 归一化后的绝对目录。
 * @throws PptStoreError - 目录落在工作区外时拒绝。
 */
export function resolveProjectDir(root: string, dir: string): string {
  const base = resolve(root)
  const absolute = resolve(base, dir)
  const inside = relative(base, absolute)
  if (inside.startsWith('..') || inside.split(sep).includes('..')) {
    throw new PptStoreError('forbidden', 'PPT 工程目录必须位于当前工作区之内')
  }
  return absolute
}

/**
 * 生成一个新的工程目录名；重名时追加序号。
 * @param root - 会话工作目录。
 * @param title - 演示文稿标题，用于构造目录名。
 * @returns 可用的绝对目录。
 */
export async function suggestProjectDir(root: string, title: string): Promise<string> {
  const base = join(resolve(root), 'ppt')
  const slug = title.trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40) || 'deck'
  const safe = ID_PATTERN.test(slug) ? slug : `deck-${Date.now().toString(36)}`
  for (let index = 0; index < 100; index += 1) {
    const candidate = join(base, index === 0 ? safe : `${safe}-${index + 1}`)
    const exists = await stat(candidate).then(() => true, () => false)
    if (!exists) return candidate
  }
  return join(base, `${safe}-${Date.now().toString(36)}`)
}

/**
 * 新建一个只有标题页的工程。
 * @param dir - 绝对工程目录。
 * @param options - 标题、画布尺寸与主题。
 * @returns 新建后的工程视图。
 * @throws PptStoreError - 目录里已经有工程时拒绝覆盖。
 */
export async function createProject(
  dir: string,
  options: { title: string; size?: SlideSizeId; theme?: ThemeId },
): Promise<PptSnapshot> {
  return withLock(dir, async () => {
    const existing = await stat(join(dir, DECK_FILE)).then(() => true, () => false)
    if (existing) throw new PptStoreError('conflict', `${dir} 里已经有演示文稿`)
    const theme = options.theme ?? 'ink'
    const palette = PPT_THEMES[theme]
    const deck: PptDeck = {
      format: PPT_FORMAT,
      title: options.title,
      size: options.size ?? '16:9',
      theme,
      pages: [{
        id: `p${Date.now().toString(36)}`,
        name: '封面',
        background: null,
        transition: 'none',
        elements: [
          {
            id: `t${Date.now().toString(36)}a`,
            kind: 'text',
            x: 96, y: 260, w: 1088, h: 120,
            text: {
              content: options.title, size: 64, color: palette.text, bold: true,
              align: 'left', valign: 'middle', font: '',
            },
          },
          {
            id: `r${Date.now().toString(36)}`,
            kind: 'rect',
            x: 96, y: 400, w: 160, h: 8,
            fill: palette.accent,
          },
        ],
      }],
    }
    const history: PptHistory = {
      cursor: 0,
      nextRevision: 2,
      entries: [{ revision: 1, deck }],
    }
    await mkdir(dir, { recursive: true })
    await writeJson(join(dir, DECK_FILE), { revision: 1, deck })
    await writeFile(join(dir, HISTORY_FILE), `${JSON.stringify(history, null, 2)}\n`, 'utf8')
    return snapshotOf(dir, 1, deck, history, Date.now())
  })
}

/**
 * 用一份现成的工程内容新建目录（导入走这条路径）。
 * @param dir - 绝对工程目录。
 * @param deck - 已校验的工程。
 * @returns 新建后的工程视图。
 * @throws PptStoreError - 目录里已有工程时拒绝覆盖。
 */
export async function createProjectFromDeck(dir: string, deck: PptDeck): Promise<PptSnapshot> {
  return withLock(dir, async () => {
    const existing = await stat(join(dir, DECK_FILE)).then(() => true, () => false)
    if (existing) throw new PptStoreError('conflict', `${dir} 里已经有演示文稿`)
    const history: PptHistory = { cursor: 0, nextRevision: 2, entries: [{ revision: 1, deck }] }
    await mkdir(dir, { recursive: true })
    await writeJson(join(dir, DECK_FILE), { revision: 1, deck })
    await writeFile(join(dir, HISTORY_FILE), `${JSON.stringify(history, null, 2)}\n`, 'utf8')
    return snapshotOf(dir, 1, deck, history, Date.now())
  })
}

function snapshotOf(
  dir: string,
  revision: number,
  deck: PptDeck,
  history: PptHistory,
  updatedAt: number,
): PptSnapshot {
  return {
    dir,
    title: deck.title,
    revision,
    deck,
    pages: deck.pages.length,
    updatedAt,
    canUndo: history.cursor > 0,
    canRedo: history.cursor < history.entries.length - 1,
  }
}

/**
 * 读取工程当前版本。
 * @param dir - 绝对工程目录。
 * @returns 当前快照。
 * @throws PptStoreError - 没有 `deck.json` 时是 `not-found`。
 */
export async function loadProject(dir: string): Promise<PptSnapshot> {
  const deckPath = join(dir, DECK_FILE)
  const raw = await readJson(deckPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PptStoreError('not-found', `${dir} 里没有演示文稿`)
    }
    throw error
  })
  if (!isRecord(raw)) throw new PptStoreError('bad-request', `${DECK_FILE} 结构不合法`)
  const revision = typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) ? raw.revision : 1
  const deck = parseDeck(raw.deck)
  const history = await readJson(join(dir, HISTORY_FILE))
    .then(historyOf)
    .catch(() => ({ cursor: 0, nextRevision: revision + 1, entries: [{ revision, deck }] }))
  const info = await stat(deckPath)
  return snapshotOf(dir, revision, deck, history, info.mtimeMs)
}

/**
 * 列出工作区里已有的工程。
 * @param root - 会话工作目录。
 * @returns 按更新时间倒序的工程摘要；没有 `ppt/` 目录时返回空数组。
 */
export async function listProjects(root: string): Promise<PptProjectSummary[]> {
  const base = join(resolve(root), 'ppt')
  const names = await readdir(base, { withFileTypes: true }).then(
    entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name),
    () => [],
  )
  const summaries: PptProjectSummary[] = []
  for (const name of names) {
    try {
      const snapshot = await loadProject(join(base, name))
      summaries.push({
        dir: relative(resolve(root), snapshot.dir),
        title: snapshot.title,
        pages: snapshot.pages,
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
      })
    } catch {
      // 目录不是合法工程时跳过：列表只展示可打开的工程，坏目录留给 loadProject 报错。
    }
  }
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt)
}

/**
 * 应用一次编辑。
 * @param dir - 绝对工程目录。
 * @param rawOps - 未校验的 ops。
 * @param baseRevision - 调用方读到的版本；给出时不一致即冲突。
 * @returns 写入后的快照。
 */
export async function editProject(
  dir: string,
  rawOps: unknown,
  baseRevision?: number,
): Promise<PptSnapshot> {
  const ops: PptOp[] = parseOps(rawOps)
  return withLock(dir, async () => {
    const current = await loadProject(dir)
    if (baseRevision !== undefined && baseRevision !== current.revision) {
      throw new PptStoreError(
        'conflict',
        `工程已被修改：当前版本 ${current.revision}，请求基于 ${baseRevision}`,
      )
    }
    const history = await readJson(join(dir, HISTORY_FILE)).then(historyOf).catch(() => ({
      cursor: 0,
      nextRevision: current.revision + 1,
      entries: [{ revision: current.revision, deck: current.deck }],
    }))
    const { deck } = applyOps(current.deck, ops)
    const revision = history.nextRevision
    const entries = [...history.entries.slice(0, history.cursor + 1), { revision, deck }]
    const pruned = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries
    const next: PptHistory = { cursor: pruned.length - 1, nextRevision: revision + 1, entries: pruned }
    await writeJson(join(dir, DECK_FILE), { revision, deck })
    await writeJson(join(dir, HISTORY_FILE), next)
    return snapshotOf(dir, revision, deck, next, Date.now())
  })
}

async function moveCursor(dir: string, steps: number, delta: -1 | 1): Promise<PptSnapshot> {
  return withLock(dir, async () => {
    const current = await loadProject(dir)
    const history = await readJson(join(dir, HISTORY_FILE)).then(historyOf).catch(() => ({
      cursor: 0,
      nextRevision: current.revision + 1,
      entries: [{ revision: current.revision, deck: current.deck }],
    }))
    const cursor = Math.min(Math.max(history.cursor + delta * steps, 0), history.entries.length - 1)
    if (cursor === history.cursor) {
      throw new PptStoreError('conflict', delta < 0 ? '已经回到最早一版' : '已经是最新一版')
    }
    const entry = history.entries[cursor]
    if (entry === undefined) throw new PptStoreError('bad-request', '历史游标越界')
    const next: PptHistory = { ...history, cursor }
    await writeJson(join(dir, DECK_FILE), { revision: entry.revision, deck: entry.deck })
    await writeJson(join(dir, HISTORY_FILE), next)
    return snapshotOf(dir, entry.revision, entry.deck, next, Date.now())
  })
}

/**
 * 撤销若干步。
 * @param dir - 绝对工程目录。
 * @param steps - 步数（1–20）。
 * @returns 撤销后的快照。
 */
export async function undoProject(dir: string, steps: number): Promise<PptSnapshot> {
  return moveCursor(dir, clampSteps(steps), -1)
}

/**
 * 重做若干步。
 * @param dir - 绝对工程目录。
 * @param steps - 步数（1–20）。
 * @returns 重做后的快照。
 */
export async function redoProject(dir: string, steps: number): Promise<PptSnapshot> {
  return moveCursor(dir, clampSteps(steps), 1)
}

function clampSteps(steps: number): number {
  if (!Number.isSafeInteger(steps)) throw new PptStoreError('bad-request', 'steps 必须是整数')
  return Math.min(Math.max(steps, 1), 20)
}

/**
 * 读取工程内的一张图片。
 * @param dir - 绝对工程目录。
 * @param source - 工程的 `media/<file>` 相对路径（模型已校验）。
 * @returns 图片字节；文件不存在时为 undefined。
 */
export async function readProjectMedia(dir: string, source: string): Promise<Uint8Array | undefined> {
  const target = join(dir, source)
  const inside = relative(dir, target)
  if (inside.startsWith('..') || inside.split(sep).includes('..')) return undefined
  return readFile(target).catch(() => undefined)
}

/** 上传不能通过工程或媒体目录的符号链接落到会话工作区之外。 */
async function assertProjectMediaDir(root: string, dir: string): Promise<void> {
  const base = resolve(root)
  const target = resolveProjectDir(base, dir)
  const canonical = await realpath(base)
  let current = canonical
  for (const segment of relative(base, target).split(sep).filter(Boolean)) {
    current = join(current, segment)
    const info = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PptStoreError('not-found', '演示文稿工程不存在')
      }
      throw error
    })
    if (info.isSymbolicLink()) {
      throw new PptStoreError('forbidden', '工程目录不允许符号链接')
    }
  }
  const media = join(current, 'media')
  const info = await lstat(media).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (info !== undefined && !info.isDirectory()) {
    throw new PptStoreError('forbidden', '媒体目录必须是普通目录')
  }
}

/**
 * 把上传的图片写进工程目录的 `media/`。
 * @param root - 会话工作区目录；已有工程及其媒体目录不得指向链接。
 * @param dir - 绝对工程目录。
 * @param name - 原始文件名，用于取扩展名并生成安全的存储名。
 * @param bytes - 图片字节。
 * @returns 写入后的 `media/<file>` 相对路径。
 * @throws PptStoreError 工程不存在、路径不安全、格式不受支持或图片超出 8 MiB 时。
 */
export async function writeProjectMedia(root: string, dir: string, name: string, bytes: Uint8Array): Promise<string> {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  const allowed = ['png', 'jpg', 'jpeg', 'gif', 'webp']
  if (!allowed.includes(ext)) throw new PptStoreError('bad-request', '图片格式不受支持')
  if (bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 * 1024) {
    throw new PptStoreError('bad-request', '图片大小必须在 1 到 8388608 字节之间')
  }
  const signatures: Record<string, number[]> = {
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    jpg: [0xff, 0xd8, 0xff], jpeg: [0xff, 0xd8, 0xff],
    gif: [0x47, 0x49, 0x46, 0x38],
    webp: [0x52, 0x49, 0x46, 0x46],
  }
  const signature = signatures[ext]
  if (!signature?.every((byte, index) => bytes[index] === byte)
    || (ext === 'webp' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') !== 'WEBP')) {
    throw new PptStoreError('bad-request', '图片内容与格式不符')
  }
  await assertProjectMediaDir(root, dir)
  await loadProject(dir)
  const file = `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  await mkdir(join(dir, 'media'), { recursive: true })
  await writeFile(join(dir, 'media', file), bytes)
  return `media/${file}`
}

/**
 * 把导出结果写到工程目录的 `export/` 下。
 * @param dir - 绝对工程目录。
 * @param revision - 导出的版本号。
 * @param title - 文件名词根。
 * @param bytes - 导出内容。
 * @param extension - 文件扩展名，默认 `pptx`。
 * @returns 绝对文件路径。
 */
export async function writeExport(
  dir: string,
  revision: number,
  title: string,
  bytes: Uint8Array,
  extension = 'pptx',
): Promise<string> {
  const target = join(dir, 'export', `${safeFileName(title)}-v${revision}.${extension}`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return target
}

function safeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/gu, '_').slice(0, 60) || 'deck'
}
