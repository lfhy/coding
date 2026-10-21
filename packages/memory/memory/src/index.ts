/**
 * 项目隔离的跨会话记忆：scope 键、条目限额，以及 `ctx.memory` 的服务定义。
 *
 * 存储由 Provider 实现（见 `coding-memory-local`）：本包拥有键计算、
 * 文件名与限额策略、Markdown 条目格式，以及给提示词的摘要渲染；Provider 只管
 * 「列出／读取／原子写入／删除」四个原语。
 *
 * @module coding-memory
 */

import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from 'coding-home-paths'

/** 记忆目录在数据主目录下的位置。 */
export const MEMORY_DIR = 'memory'

/** 记录项目真实路径的元数据文件名；不是模型可见的记忆条目。 */
export const PROJECT_META_FILE = 'project.json'

/** 没有指定文件时的默认记忆文件。 */
export const DEFAULT_MEMORY_FILE = 'notes.md'

/** 没有指定小节时的默认小节标题。 */
export const DEFAULT_MEMORY_SECTION = '要点'

/** 每个记忆文件的默认字节上限。 */
export const DEFAULT_MAX_FILE_BYTES = 64 * 1024

/** 单条记忆写入的默认字节上限。 */
export const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024

/** 每个项目记忆总量的默认字节上限。 */
export const DEFAULT_MAX_PROJECT_BYTES = 1024 * 1024

/** 每个项目记忆文件数的默认上限。 */
export const DEFAULT_MAX_FILES = 16

/** 注入提示词的默认字节预算。 */
export const DEFAULT_INJECT_BYTES = 4096

/** 项目根标记的默认值，与工作区指令发现保持一致。 */
export const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const

const RESERVED_FILE_CHARACTERS = /[^a-z0-9._-]/

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 项目隔离的跨会话记忆；未挂载 Provider 的树里没有这个服务。 */
    memory: Memory
  }
}

/** 记忆条目策略；Provider 追加自己的存储位置配置后交给服务。 */
export interface MemoryConfig {
  /** 从会话 cwd 向上寻找项目根时接受的目录条目。 */
  projectRootMarkers?: string[]
  /** 记忆目录的绝对路径；省略时用 `<数据主目录>/memory`。 */
  root?: string
  maxFileBytes?: number
  maxEntryBytes?: number
  maxProjectBytes?: number
  maxFiles?: number
  /** 注入提示词的字节预算。 */
  injectBytes?: number
}

export const MemoryConfig: z<MemoryConfig> = z.object({
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  root: z.string(),
  maxFileBytes: z.number().step(1).min(1).default(DEFAULT_MAX_FILE_BYTES),
  maxEntryBytes: z.number().step(1).min(1).default(DEFAULT_MAX_ENTRY_BYTES),
  maxProjectBytes: z.number().step(1).min(1).default(DEFAULT_MAX_PROJECT_BYTES),
  maxFiles: z.number().step(1).min(1).default(DEFAULT_MAX_FILES),
  injectBytes: z.number().step(1).min(1).default(DEFAULT_INJECT_BYTES),
})

/** 一个项目在记忆根下的身份：真实路径与它的目录键。 */
export interface MemoryProject {
  /** 项目根的真实路径（已解析 symlink）。 */
  path: string
  /** 目录键，`md5(项目根真实路径)` 的十六进制。 */
  key: string
  /** 该项目的记忆目录绝对路径。 */
  directory: string
}

/** 一个记忆文件的元数据。 */
export interface MemoryFileSummary {
  name: string
  /** 文件首个标题行，缺失时退回文件名。 */
  title: string
  bytes: number
  /** 最近修改时间（ISO 8601）。 */
  updatedAt: string
}

/** 一次读取的结果。 */
export interface MemoryReadResult {
  name: string
  content: string
  /** 内容超过 `maxFileBytes` 时只返回头部。 */
  truncated: boolean
}

/** 一条写入请求。 */
export interface MemorySaveRequest {
  content: string
  /** 目标文件，默认 `notes.md`。 */
  file?: string
  /** 目标小节，默认 `要点`。 */
  section?: string
}

/** 一条记忆替换请求。 */
export interface MemoryUpdateRequest {
  /** 要替换的现有条目：必须在目标文件（或指定小节）内唯一命中。 */
  match: string
  /** 替换后的条目正文。 */
  content: string
  /** 目标文件，默认 `notes.md`。 */
  file?: string
  /** 限定在同名小节内匹配；省略时在整个文件内匹配。 */
  section?: string
}

/** 一条注入摘要。 */
export interface MemoryExcerpt {
  text: string
  /** 摘要里出现的文件。 */
  files: string[]
  /** 因预算没有出现的文件。 */
  omitted: string[]
  /** 至少一个文件被截断或省略。 */
  truncated: boolean
}

/** 无记忆、或预算无法容纳任何内容时的空摘要。 */
export const EMPTY_EXCERPT: MemoryExcerpt = { text: '', files: [], omitted: [], truncated: false }

/** 项目路径的目录键：`md5(真实路径)` 的十六进制。 */
export function memoryProjectKey(projectPath: string): string {
  return createHash('md5').update(resolve(projectPath)).digest('hex')
}

/**
 * 把会话 cwd 解析成项目身份：向上找到第一个带项目根标记的目录（找不到就用 cwd
 * 本身），解析 symlink 后取 `md5` 作为目录键。同一项目在任何子目录开会话都会命中
 * 同一份记忆。
 *
 * 工作区指令发现保留自己的 `ctx.fs` 版本走目录链，因为那一步必须跟随文件系统
 * Provider；记忆键只需要宿主可见的项目路径。
 * @param cwd - 会话工作目录。
 * @param markers - 项目根标记名。
 * @param root - 记忆根目录。
 * @returns 项目真实路径、目录键与记忆目录。
 */
export function resolveMemoryProject(cwd: string, markers: readonly string[], root: string): MemoryProject {
  const path = realProjectRoot(cwd, markers)
  const key = memoryProjectKey(path)
  return { path, key, directory: join(root, key) }
}

function realProjectRoot(cwd: string, markers: readonly string[]): string {
  let current = resolve(cwd)
  for (;;) {
    if (markers.some(marker => existsSync(join(current, marker)))) break
    const parent = dirname(current)
    if (parent === current) {
      current = resolve(cwd)
      break
    }
    current = parent
  }
  try {
    return realpathSync(current)
  } catch {
    // 目录在探测与解析之间消失：调用方仍需一个稳定键，退回解析前的绝对路径。
    return current
  }
}

/**
 * 规范化记忆文件名，拒绝任何可能逃出项目目录的取值。
 * @param value - 调用方给的文件名；省略时用 `notes.md`。
 * @returns 通过校验的文件名。
 * @throws 取值不是同一目录下的 `.md` 文件名时抛出。
 */
export function memoryFileName(value?: string): string {
  if (value === undefined || value.trim().length === 0) return DEFAULT_MEMORY_FILE
  const name = value.trim()
  if (!name.endsWith('.md') || name.startsWith('.') || RESERVED_FILE_CHARACTERS.test(name) || name.includes('/')) {
    throw new Error(`memory: invalid memory file ${JSON.stringify(value)}; use a lowercase *.md file name in the project's memory directory`)
  }
  return name
}

/** 记忆文件的默认标题。 */
export function memoryTitle(name: string): string {
  return name.replace(/\.md$/, '')
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * 把条目渲染成 Markdown 列表项：首行带 `- `，其余行缩进两格保持同一条目。
 * @param entry - 条目正文。
 * @returns 逐行渲染结果。
 */
export function memoryBullet(entry: string): string[] {
  return entry.trimEnd().split('\n').map((line, index) => index === 0 ? `- ${line}` : `  ${line}`)
}

/**
 * 找到小节标题到下一个同级或更高级标题之间的行范围。
 * @param lines - 文件按行拆分的结果。
 * @param section - 小节标题。
 * @returns `start` 是标题行、`end` 是结束行（不含）；没有该小节时返回 undefined。
 */
function sectionExtent(lines: readonly string[], section: string): { start: number; end: number } | undefined {
  const start = lines.indexOf(`## ${section}`)
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s/.test(lines[index] ?? '')) {
      end = index
      break
    }
  }
  return { start, end }
}

/**
 * 把一条记忆追加到指定小节：小节不存在时在文件末尾新建，其余内容原样保留。
 * 条目按 Markdown 列表项写入，多行内容缩进续行。
 * @param content - 文件当前内容，空串表示新建文件。
 * @param projectTitle - 新建文件时的标题。
 * @param section - 目标小节标题。
 * @param entry - 条目正文。
 * @returns 写入后的完整文件内容。
 */
export function appendMemoryEntry(content: string, projectTitle: string, section: string, entry: string): string {
  const bullet = memoryBullet(entry).join('\n')
  if (content.trim().length === 0) return `# ${projectTitle} 记忆\n\n## ${section}\n\n${bullet}\n`
  const heading = `## ${section}`
  const lines = content.replace(/\n*$/, '\n').split('\n')
  const extent = sectionExtent(lines, section)
  if (extent === undefined) return `${lines.join('\n')}\n${heading}\n\n${bullet}\n`
  const { start, end } = extent
  const before = lines.slice(0, end)
  while (before.length > start + 1 && (before[before.length - 1] ?? '').trim().length === 0) before.pop()
  const after = lines.slice(end)
  const inserted = [bullet, '']
  return [...before, ...inserted, ...after].join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * 删除一个小节（含标题到下一个同级或更高级标题之间的内容）。
 * @param content - 文件当前内容。
 * @param section - 要删除的小节标题。
 * @returns 删除后的内容，以及是否确实删掉了该小节。
 */
export function removeMemorySection(content: string, section: string): { content: string; removed: boolean } {
  const lines = content.split('\n')
  const extent = sectionExtent(lines, section)
  if (extent === undefined) return { content, removed: false }
  const { start, end } = extent
  const remaining = [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
  return { content: remaining.trimEnd().length === 0 ? '' : `${remaining.replace(/\n*$/, '')}\n`, removed: true }
}

/** 一条记忆条目的位置与正文。 */
export interface MemoryEntryRange {
  /** 条目起始行（含）。 */
  start: number
  /** 条目结束行（不含），续行也算在同一条目里。 */
  end: number
  /** 条目正文：去掉 `- ` 列表符号与续行缩进。 */
  text: string
}

/**
 * 列出含 `match` 的条目。条目是 `- ` 开头的一段，紧随其后的两空格缩进行属于同一条；
 * 空行或其它行结束该条目。
 * @param content - 记忆文件内容。
 * @param match - 要匹配的文本片段，按字面子串比较。
 * @param section - 只在该小节内匹配；省略时匹配整个文件。
 * @returns 命中的条目范围，按文件顺序排列。
 */
export function findMemoryEntries(content: string, match: string, section?: string): MemoryEntryRange[] {
  const lines = content.split('\n')
  const extent = section === undefined ? { start: -1, end: lines.length } : sectionExtent(lines, section)
  if (extent === undefined) return []
  const hits: MemoryEntryRange[] = []
  for (let index = extent.start + 1; index < extent.end; index += 1) {
    const first = lines[index]
    if (first === undefined || !first.startsWith('- ')) continue
    let end = index + 1
    while (end < extent.end && (lines[end] ?? '').startsWith('  ')) end += 1
    const text = [first.slice(2), ...lines.slice(index + 1, end).map(line => line.slice(2))].join('\n').trimEnd()
    if (text.includes(match)) hits.push({ start: index, end, text })
    index = end - 1
  }
  return hits
}

/**
 * 用新条目替换一条已定位的条目，其余内容原样保留。
 * @param content - 文件当前内容。
 * @param target - {@link findMemoryEntries} 命中的条目。
 * @param entry - 替换后的条目正文。
 * @returns 替换后的完整文件内容。
 */
export function replaceMemoryEntry(content: string, target: MemoryEntryRange, entry: string): string {
  const lines = content.split('\n')
  return [...lines.slice(0, target.start), ...memoryBullet(entry), ...lines.slice(target.end)].join('\n')
}

/**
 * 项目记忆服务。Provider 实现四个存储原语，本类负责校验、限额与渲染，因此工具与
 * 提示词两个消费方共享同一套语义。
 */
export abstract class Memory extends Service {
  private readonly config: Required<Omit<MemoryConfig, 'root'>> & { root: string }

  constructor(ctx: Context, config: MemoryConfig) {
    super(ctx, 'memory')
    this.config = {
      projectRootMarkers: config.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS],
      root: resolve(config.root ?? dshHomePath(MEMORY_DIR)),
      maxFileBytes: config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      maxEntryBytes: config.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
      maxProjectBytes: config.maxProjectBytes ?? DEFAULT_MAX_PROJECT_BYTES,
      maxFiles: config.maxFiles ?? DEFAULT_MAX_FILES,
      injectBytes: config.injectBytes ?? DEFAULT_INJECT_BYTES,
    }
  }

  /** 记忆根目录的绝对路径。 */
  get root(): string {
    return this.config.root
  }

  /**
   * 把会话 cwd 解析成项目身份。
   * @param cwd - 会话工作目录。
   * @returns 项目真实路径、目录键与记忆目录。
   */
  projectFor(cwd: string): MemoryProject {
    return resolveMemoryProject(cwd, this.config.projectRootMarkers, this.config.root)
  }

  /**
   * 列出项目的记忆文件，最近修改的在前。
   * @param project - {@link projectFor} 返回的项目身份。
   * @returns 文件元数据。
   */
  async list(project: MemoryProject): Promise<MemoryFileSummary[]> {
    const files = await this.listFiles(project)
    return [...files].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /**
   * 读取一个记忆文件，超出单文件上限时只返回头部。
   * @param project - 项目身份。
   * @param name - 记忆文件名。
   * @returns 读取结果；文件不存在时返回 undefined。
   */
  async read(project: MemoryProject, name: string): Promise<MemoryReadResult | undefined> {
    const file = memoryFileName(name)
    const content = await this.readFile(project, file)
    if (content === undefined) return undefined
    const truncated = byteLength(content) > this.config.maxFileBytes
    return { name: file, content: truncated ? truncateUtf8(content, this.config.maxFileBytes) : content, truncated }
  }

  /**
   * 追加一条记忆，并在此处执行单条、单文件、总量与文件数限额。
   * @param project - 项目身份。
   * @param request - 条目内容与目标文件／小节。
   * @returns 写入后的文件元数据。
   * @throws 条目为空、或越过任一限额时抛出，诊断里带上实际数值。
   */
  async save(project: MemoryProject, request: MemorySaveRequest): Promise<MemoryFileSummary> {
    const entry = request.content.trim()
    if (entry.length === 0) throw new Error('memory: refusing to save an empty entry')
    const entryBytes = byteLength(entry)
    if (entryBytes > this.config.maxEntryBytes) {
      throw new Error(`memory: entry is ${entryBytes} bytes, above the ${this.config.maxEntryBytes}-byte limit`)
    }
    const file = memoryFileName(request.file)
    const section = request.section?.trim() ?? DEFAULT_MEMORY_SECTION
    const existing = await this.readFile(project, file)
    const existingFiles = await this.listFiles(project)
    if (existing === undefined && existingFiles.length >= this.config.maxFiles) {
      throw new Error(`memory: ${existingFiles.length} memory files already exist, at the ${this.config.maxFiles}-file limit`)
    }
    const next = appendMemoryEntry(existing ?? '', memoryTitle(basename(project.path)), section, entry)
    const nextBytes = byteLength(next)
    if (nextBytes > this.config.maxFileBytes) {
      throw new Error(`memory: ${file} would grow to ${nextBytes} bytes, above the ${this.config.maxFileBytes}-byte file limit`)
    }
    const projectBytes = existingFiles.reduce((total, item) => total + (item.name === file ? 0 : item.bytes), 0) + nextBytes
    if (projectBytes > this.config.maxProjectBytes) {
      throw new Error(`memory: project memory would grow to ${projectBytes} bytes, above the ${this.config.maxProjectBytes}-byte limit`)
    }
    await this.writeFile(project, file, next)
    const written = (await this.listFiles(project)).find(item => item.name === file)
    /* v8 ignore next -- the provider just wrote the file it is asked to describe. */
    if (written === undefined) throw new Error(`memory: ${file} disappeared after writing`)
    return written
  }

  /**
   * 替换一条已有记忆：命中必须在目标文件（或指定小节）内唯一，其余内容原样保留。
   *
   * 与 {@link save} 共用单条、单文件与每项目总量三项限额；文件数不变，因此不检查
   * 文件数上限。命中零条或多条都抛错，避免模型改错条目。
   * @param project - 项目身份。
   * @param request - 匹配片段、新条目内容与目标文件／小节。
   * @returns 写入后的文件元数据与被替换掉的原文。
   * @throws 目标文件不存在、未唯一命中或越过任一限额时抛出，诊断里带上实际数值。
   */
  async update(
    project: MemoryProject,
    request: MemoryUpdateRequest,
  ): Promise<{ summary: MemoryFileSummary; previous: string }> {
    const entry = request.content.trim()
    if (entry.length === 0) throw new Error('memory: refusing to save an empty entry')
    const entryBytes = byteLength(entry)
    if (entryBytes > this.config.maxEntryBytes) {
      throw new Error(`memory: entry is ${entryBytes} bytes, above the ${this.config.maxEntryBytes}-byte limit`)
    }
    const file = memoryFileName(request.file)
    const content = await this.readFile(project, file)
    if (content === undefined) throw new Error(`memory: ${file} does not exist in this project's memory`)
    const match = request.match.trim()
    if (match.length === 0) {
      throw new Error('memory: refusing to update without a match; pass a snippet of the entry to replace')
    }
    const section = request.section?.trim()
    const scope = section === undefined ? file : `${file} section "${section}"`
    const hits = findMemoryEntries(content, match, section)
    if (hits.length === 0) {
      throw new Error(`memory: no entry in ${scope} matches ${JSON.stringify(match)}; read the file before updating an entry`)
    }
    if (hits.length > 1) {
      throw new Error(`memory: ${hits.length} entries in ${scope} match ${JSON.stringify(match)}; pass a longer match or narrow it with section`)
    }
    const target = hits[0]
    /* v8 ignore next -- `hits.length === 1` was just checked. */
    if (target === undefined) throw new Error(`memory: no entry in ${scope} matches ${JSON.stringify(match)}`)
    const next = replaceMemoryEntry(content, target, entry)
    const nextBytes = byteLength(next)
    if (nextBytes > this.config.maxFileBytes) {
      throw new Error(`memory: ${file} would grow to ${nextBytes} bytes, above the ${this.config.maxFileBytes}-byte file limit`)
    }
    const existingFiles = await this.listFiles(project)
    const projectBytes = existingFiles.reduce((total, item) => total + (item.name === file ? 0 : item.bytes), 0) + nextBytes
    if (projectBytes > this.config.maxProjectBytes) {
      throw new Error(`memory: project memory would grow to ${projectBytes} bytes, above the ${this.config.maxProjectBytes}-byte limit`)
    }
    await this.writeFile(project, file, next)
    const written = (await this.listFiles(project)).find(item => item.name === file)
    /* v8 ignore next -- the provider just wrote the file it is asked to describe. */
    if (written === undefined) throw new Error(`memory: ${file} disappeared after writing`)
    return { summary: written, previous: target.text }
  }

  /**
   * 删除整个记忆文件，或只删除其中一个小节。
   * @param project - 项目身份。
   * @param name - 记忆文件名。
   * @param section - 省略时删除整个文件。
   * @returns 是否确实删除了内容。
   */
  async remove(project: MemoryProject, name: string, section?: string): Promise<boolean> {
    const file = memoryFileName(name)
    if (section === undefined) return this.removeFile(project, file)
    const content = await this.readFile(project, file)
    if (content === undefined) return false
    const stripped = removeMemorySection(content, section.trim())
    if (!stripped.removed) return false
    if (isMemoryShell(stripped.content)) return this.removeFile(project, file)
    await this.writeFile(project, file, stripped.content)
    return true
  }

  /**
   * 渲染注入提示词的有界摘要：按最近修改排序，逐个文件给出标题与开头，直到用完
   * `injectBytes`；被截断或省略的文件列在结果里，让消费方提示模型去读全文。
   * @param project - 项目身份。
   * @returns 摘要文本与文件清单；没有记忆时返回 {@link EMPTY_EXCERPT}。
   */
  async excerpt(project: MemoryProject): Promise<MemoryExcerpt> {
    const files = await this.list(project)
    const included: string[] = []
    const omitted: string[] = []
    const blocks: string[] = []
    let used = 0
    let truncated = false
    for (const file of files) {
      const content = await this.readFile(project, file.name)
      if (content === undefined) continue
      const heading = `### ${file.name}\n\n`
      const remaining = this.config.injectBytes - used - byteLength(heading)
      if (remaining <= 0) {
        omitted.push(file.name)
        truncated = true
        continue
      }
      const body = content.trimEnd()
      const head = truncateUtf8(body, remaining)
      if (byteLength(head) < byteLength(body)) truncated = true
      const block = `${heading}${head}`
      blocks.push(block)
      included.push(file.name)
      used += byteLength(block)
    }
    if (blocks.length === 0) return { ...EMPTY_EXCERPT, omitted }
    return { text: blocks.join('\n\n'), files: included, omitted, truncated }
  }

  /** Provider 实现：列出项目记忆文件（顺序不限）。 */
  protected abstract listFiles(project: MemoryProject): Promise<MemoryFileSummary[]>
  /** Provider 实现：读取一个记忆文件，不存在时返回 undefined。 */
  protected abstract readFile(project: MemoryProject, name: string): Promise<string | undefined>
  /** Provider 实现：原子写入一个记忆文件，必要时创建目录。 */
  protected abstract writeFile(project: MemoryProject, name: string, content: string): Promise<void>
  /** Provider 实现：删除一个记忆文件，返回它此前是否存在。 */
  protected abstract removeFile(project: MemoryProject, name: string): Promise<boolean>
}

/**
 * 判断文件是否只剩标题、没有条目内容。删掉最后一个小节后留下这样的空壳没有意义，
 * 因此删除操作把它当作文件已清空。
 * @param content - 待检查的文件内容。
 * @returns 除标题与空行外没有任何内容时为 true。
 */
export function isMemoryShell(content: string): boolean {
  return content.split('\n').every(line => line.trim().length === 0 || line.startsWith('#'))
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  // 预算切在一个码点中间时退回它的前导字节，避免产出半个字符。
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}
