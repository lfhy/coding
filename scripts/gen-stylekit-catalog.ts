/**
 * 生成 `packages/skill/skill-stylekit/assets/` 下的 StyleKit 快照：目录索引 `styles.jsonl`
 * 与每风格完整规格 `styles/<slug>.json`。
 *
 * 内嵌规格让 `stylekit` 技能完全离线可用：配色、设计令牌、组件配方、示例提示词与
 * do/don't 规则都随包分发，不再依赖运行时联网。上游站点仍是清单与规则的权威来源，
 * 需要最新目录时重新运行本脚本。
 *
 * 用法：
 * - 默认在线拉取 `https://www.stylekit.top/api/styles` 与 `/api/styles/<slug>`，重写全部资产；
 * - `--input <list.json>` 用已保存的目录响应重建索引，`--input-dir <dir>` 用已保存的规格重建规格；
 * - `--check` 离线校验已提交资产（索引结构与顺序、规格与索引的 slug 对应、规格字段与紧凑格式）。
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const LIST_SOURCE = 'https://www.stylekit.top/api/styles'
const SPEC_SOURCE = (slug: string): string => `https://www.stylekit.top/api/styles/${slug}`
const ASSETS = resolve(import.meta.dirname, '../packages/skill/skill-stylekit/assets')
const INDEX_FILE = join(ASSETS, 'styles.jsonl')
const SPEC_DIR = join(ASSETS, 'styles')
/** 上游目录异常缩小到该阈值以下时视为抓取失败，避免用残缺快照覆盖资产。 */
const MIN_STYLES = 100
/** 并发抓取上限：上游是静态站点，6 路足够快且不至于把对方打满。 */
const FETCH_CONCURRENCY = 6
const HEX = /^#[0-9a-f]{6}$/i
/** 上游少数半透明强调色用 `rgba(...)` 表达；只接受这两种颜色写法，避免把任意 CSS 文本写进资产。 */
const FUNCTIONAL = /^(?:rgba?|hsla?)\([\d\s.,%/]+\)$/i

/** 随包固化的单条风格索引；字段取舍以检索需要为准。 */
export interface StylekitCatalogEntry {
  readonly slug: string
  readonly name: string
  readonly nameEn: string
  readonly category: string
  readonly styleType: string
  readonly tags: readonly string[]
  readonly colors: {
    readonly primary: string
    readonly secondary: string
    readonly accent: readonly string[]
  }
  readonly keywords: readonly string[]
  readonly description: string
}

/** 随包固化的完整风格规格：实现需要的一切，去掉站点自用的质量看板与图片地址。 */
export interface StylekitStyleSpec {
  readonly slug: string
  readonly name: string
  readonly nameEn: string
  readonly description: string
  readonly styleType: string
  readonly tags: readonly string[]
  readonly compatibleWith?: readonly string[]
  readonly keywords: readonly string[]
  readonly colors: {
    readonly primary: string
    readonly secondary: string
    readonly accent: readonly string[]
  }
  readonly philosophy: string
  readonly doList: readonly string[]
  readonly dontList: readonly string[]
  readonly aiRules: string
  readonly globalCss: string
  readonly examplePrompts: readonly unknown[]
  readonly tokens: Readonly<Record<string, unknown>>
  readonly recipes: Readonly<Record<string, unknown>>
  readonly components: Readonly<Record<string, unknown>>
}

/** 规格里保留的字段顺序；输出按此顺序写入，保证同一输入产出同一份资产。 */
const SPEC_KEYS = [
  'slug', 'name', 'nameEn', 'description', 'styleType', 'tags', 'compatibleWith',
  'keywords', 'colors', 'philosophy', 'doList', 'dontList', 'aiRules', 'globalCss',
  'examplePrompts', 'tokens', 'recipes', 'components',
] as const

/**
 * 把上游 `/api/styles` 响应转换为按 slug 排序的目录快照。
 * @param payload - 已解析的上游响应（`{ total, styles }`）。
 * @returns 校验通过的目录条目，按 slug 升序排列。
 * @throws 字段缺失、颜色写法不支持、slug 重复或目录过小时抛出带具体位置的错误。
 */
export function buildStylekitCatalog(payload: unknown): StylekitCatalogEntry[] {
  if (!isRecord(payload) || !Array.isArray(payload.styles)) {
    throw new Error('stylekit catalog: payload must be an object with a styles array')
  }
  return sorted(payload.styles.map((item, index) => entry(item, `styles[${index}]`)))
}

/**
 * 把上游单风格响应裁剪为随包规格。
 *
 * 单风格响应不含 `tags`（只在目录层），三个风格也缺 `examplePrompts`，因此这些字段由
 * 调用方补默认值，其余实现所需的字段缺失即拒绝。
 * @param payload - `/api/styles/<slug>` 的已解析响应。
 * @param slug - 期望的 slug；与响应不一致时拒绝，避免把 A 风格写进 B 的文件。
 * @param tags - 目录层给出的标签，规格自己不带。
 * @returns 保留实现所需字段的规格。
 * @throws 必填字段缺失或类型不符时抛出。
 */
export function buildStylekitSpec(payload: unknown, slug?: string, tags: readonly string[] = []): StylekitStyleSpec {
  if (!isRecord(payload)) throw new Error('stylekit spec: payload must be an object')
  const actual = text(payload.slug, 'slug')
  if (slug !== undefined && actual !== slug) {
    throw new Error(`stylekit spec: expected slug "${slug}", got "${actual}"`)
  }
  const spec: Record<string, unknown> = {
    slug: actual,
    name: text(payload.name, 'name'),
    nameEn: text(payload.nameEn, 'nameEn'),
    description: text(payload.description, 'description'),
    styleType: text(payload.styleType, 'styleType'),
    tags: [...tags],
    keywords: strings(payload.keywords, 'keywords'),
    colors: colors(payload.colors, 'colors'),
    philosophy: text(payload.philosophy, 'philosophy'),
    doList: strings(payload.doList, 'doList'),
    dontList: strings(payload.dontList, 'dontList'),
    aiRules: text(payload.aiRules, 'aiRules'),
    globalCss: text(payload.globalCss, 'globalCss'),
    examplePrompts: payload.examplePrompts === undefined ? [] : records(payload.examplePrompts, 'examplePrompts'),
    tokens: record(payload.tokens, 'tokens'),
    recipes: record(payload.recipes, 'recipes'),
    components: record(payload.components, 'components'),
  }
  if (payload.compatibleWith !== undefined) spec.compatibleWith = strings(payload.compatibleWith, 'compatibleWith')
  return spec as unknown as StylekitStyleSpec
}

/**
 * 序列化为 JSONL：一行一条风格，使 `grep -i <关键词>` 直接命中完整条目，
 * 模型无需整读约 75 KB 索引；按 slug 排序保证输出稳定。
 * @param entries - 目录条目。
 * @returns 以单个换行结尾的 JSONL 文本。
 */
export function serializeStylekitCatalog(entries: readonly StylekitCatalogEntry[]): string {
  return entries.map(item => `${JSON.stringify(item)}\n`).join('')
}

/**
 * 规格文件按 `SPEC_KEYS` 顺序紧凑序列化，一次读取拿到全部实现信息。
 * @param spec - 单风格规格。
 * @returns 紧凑 JSON 文本（含结尾换行）。
 */
export function serializeStylekitSpec(spec: StylekitStyleSpec): string {
  const ordered: Record<string, unknown> = {}
  for (const key of SPEC_KEYS) {
    const value = (spec as unknown as Record<string, unknown>)[key]
    if (value !== undefined) ordered[key] = value
  }
  return `${JSON.stringify(ordered)}\n`
}

/**
 * 解析已提交的 JSONL 索引，并对每行结构与顺序做完整性校验。
 * @param text - `assets/styles.jsonl` 的文本内容。
 * @returns 按 slug 升序排列的目录条目。
 * @throws 空行、无法解析的行、字段不合法、slug 重复或顺序错乱时抛出带行号的错误。
 */
export function parseStylekitCatalog(text: string): StylekitCatalogEntry[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const entries = lines.map((line, index) => {
    if (line === '') throw new Error(`stylekit catalog: blank line at ${index + 1}`)
    return entry(parseJson(line, `line ${index + 1}`), `line ${index + 1}`)
  })
  const slugs = entries.map(item => item.slug)
  const ordered = [...slugs].sort((left, right) => left.localeCompare(right))
  if (ordered.some((slug, index) => slug !== slugs[index])) {
    throw new Error('stylekit catalog: entries are not sorted by slug')
  }
  return sorted(entries)
}

/**
 * 校验索引与规格目录的对应关系：两者 slug 集合必须一致。
 * @param slugs - 索引里的 slug。
 * @param files - 规格目录里的文件名（含 `.json`）。
 * @returns 缺失与多余的 slug 列表；两者都为空时资产一致。
 */
export function compareSpecSlugs(
  slugs: readonly string[],
  files: readonly string[],
): { missing: string[]; orphaned: string[] } {
  const indexed = new Set(slugs)
  const present = new Set(files.filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length)))
  return {
    missing: [...indexed].filter(slug => !present.has(slug)).sort(),
    orphaned: [...present].filter(slug => !indexed.has(slug)).sort(),
  }
}

function sorted(entries: StylekitCatalogEntry[]): StylekitCatalogEntry[] {
  if (entries.length < MIN_STYLES) {
    throw new Error(`stylekit catalog: only ${entries.length} styles, expected at least ${MIN_STYLES}`)
  }
  const seen = new Map<string, number>()
  for (const [index, item] of entries.entries()) {
    const previous = seen.get(item.slug)
    if (previous !== undefined) {
      throw new Error(`stylekit catalog: duplicate slug "${item.slug}" at entry ${index + 1} (also ${previous + 1})`)
    }
    seen.set(item.slug, index)
  }
  return entries.sort((left, right) => left.slug.localeCompare(right.slug))
}

function entry(value: unknown, path: string): StylekitCatalogEntry {
  if (!isRecord(value)) throw new Error(`stylekit catalog: ${path} must be an object`)
  return {
    slug: text(value.slug, `${path}.slug`),
    name: text(value.name, `${path}.name`),
    nameEn: text(value.nameEn, `${path}.nameEn`),
    category: text(value.category, `${path}.category`),
    styleType: text(value.styleType, `${path}.styleType`),
    tags: strings(value.tags, `${path}.tags`),
    colors: colors(value.colors, `${path}.colors`),
    keywords: strings(value.keywords, `${path}.keywords`),
    description: text(value.description, `${path}.description`),
  }
}

function colors(value: unknown, path: string): StylekitCatalogEntry['colors'] {
  if (!isRecord(value)) throw new Error(`stylekit catalog: ${path} must be an object`)
  const accent = value.accent
  if (!Array.isArray(accent) || accent.length === 0) {
    throw new Error(`stylekit catalog: ${path}.accent must be a non-empty array`)
  }
  return {
    primary: color(value.primary, `${path}.primary`),
    secondary: color(value.secondary, `${path}.secondary`),
    accent: accent.map((item, index) => color(item, `${path}.accent[${index}]`)),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`stylekit catalog: ${path} is not JSON (${String(error)})`)
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`stylekit catalog: ${path} must be a non-empty string`)
  }
  return value
}

function color(value: unknown, path: string): string {
  const resolved = text(value, path)
  if (HEX.test(resolved)) return resolved.toLowerCase()
  if (FUNCTIONAL.test(resolved)) return resolved
  throw new Error(`stylekit catalog: ${path} must be a #rrggbb or rgb()/hsl() color, got "${resolved}"`)
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`stylekit catalog: ${path} must be an array`)
  return value.map((item, index) => text(item, `${path}[${index}]`))
}

function records(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`stylekit catalog: ${path} must be an array`)
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`stylekit catalog: ${path}[${index}] must be an object`)
    return item
  })
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`stylekit catalog: ${path} must be an object`)
  return value
}

/** 命令行参数取值；缺失时返回 undefined。 */
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`stylekit catalog: ${url} answered ${response.status}`)
  return response.json()
}

/** 以固定并发跑完所有任务，结果顺序与输入一致。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index] as T)
    }
  })
  await Promise.all(runners)
  return results
}

async function loadIndex(): Promise<StylekitCatalogEntry[]> {
  const input = flag('--input')
  if (input !== undefined) return buildStylekitCatalog(parseJson(await readFile(input, 'utf8'), input))
  return buildStylekitCatalog(await fetchJson(LIST_SOURCE))
}

async function loadSpecs(entries: readonly StylekitCatalogEntry[]): Promise<Map<string, StylekitStyleSpec>> {
  const inputDir = flag('--input-dir')
  const specs = await mapLimit(
    /** 每项带上目录条目，规格里缺的标签从目录层补齐。 */
    entries.map(entry => ({ slug: entry.slug, tags: entry.tags })),
    inputDir === undefined ? FETCH_CONCURRENCY : Math.max(1, entries.length),
    async ({ slug, tags }) => {
      const payload = inputDir === undefined
        ? await fetchJson(SPEC_SOURCE(slug))
        : parseJson(await readFile(join(inputDir, `${slug}.json`), 'utf8'), `${slug}.json`)
      return [slug, buildStylekitSpec(payload, slug, tags)] as const
    },
  )
  return new Map(specs)
}

async function writeAssets(
  entries: readonly StylekitCatalogEntry[],
  specs: Map<string, StylekitStyleSpec>,
): Promise<void> {
  await mkdir(SPEC_DIR, { recursive: true })
  await writeFile(INDEX_FILE, serializeStylekitCatalog(entries))
  for (const [slug, spec] of specs) await writeFile(join(SPEC_DIR, `${slug}.json`), serializeStylekitSpec(spec))
  // 上游删除的风格不能留在包里，否则规格目录与索引对不上。
  const stale = compareSpecSlugs(entries.map(entry => entry.slug), await readdir(SPEC_DIR)).orphaned
  await Promise.all(stale.map(slug => rm(join(SPEC_DIR, `${slug}.json`), { force: true })))
}

async function checkAssets(): Promise<void> {
  const index = await readFile(INDEX_FILE, 'utf8')
  const entries = parseStylekitCatalog(index)
  if (serializeStylekitCatalog(entries) !== index) {
    throw new Error(`stylekit catalog: ${INDEX_FILE} is not in canonical form; run "pnpm run gen-stylekit-catalog"`)
  }
  const { missing, orphaned } = compareSpecSlugs(entries.map(entry => entry.slug), await readdir(SPEC_DIR))
  if (missing.length > 0) throw new Error(`stylekit catalog: missing spec files for ${missing.join(', ')}`)
  if (orphaned.length > 0) throw new Error(`stylekit catalog: orphaned spec files for ${orphaned.join(', ')}`)
  for (const entry of entries) {
    const path = join(SPEC_DIR, `${entry.slug}.json`)
    const raw = await readFile(path, 'utf8')
    const spec = buildStylekitSpec(parseJson(raw, `${entry.slug}.json`), entry.slug, entry.tags)
    if (serializeStylekitSpec(spec) !== raw) {
      throw new Error(`stylekit catalog: ${path} is not in canonical form; run "pnpm run gen-stylekit-catalog"`)
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    await checkAssets()
    return
  }
  const entries = await loadIndex()
  await writeAssets(entries, await loadSpecs(entries))
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`[gen-stylekit-catalog] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
