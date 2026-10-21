/**
 * 生成 `packages/skill/skill-stylekit/assets/styles.jsonl`：StyleKit 公开风格目录的随包快照。
 *
 * 该资产让 `stylekit` 技能在离线状态下也能把用户的措辞映射到风格 slug、配色和关键词；
 * 完整的设计令牌与 do/don't 规则仍由上游在线提供，本脚本只固化目录层。
 *
 * 用法：
 * - 默认在线拉取 `https://www.stylekit.top/api/styles` 并重写资产；
 * - `--input <file>` 用已保存的接口响应重建，便于离线或复现；
 * - `--check` 离线校验已提交资产（逐行结构、slug 唯一且有序、条目数量），供门禁使用。
 *   与上游的一致性由维护者按需运行一次刷新确认，因此不放进需要网络的自动化门禁。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const SOURCE = 'https://www.stylekit.top/api/styles'
const OUT = resolve(import.meta.dirname, '../packages/skill/skill-stylekit/assets/styles.jsonl')
/** 上游目录异常缩小到该阈值以下时视为抓取失败，避免用残缺快照覆盖资产。 */
const MIN_STYLES = 100
const HEX = /^#[0-9a-f]{6}$/i
/** 上游少数半透明强调色用 `rgba(...)` 表达；只接受这两种颜色写法，避免把任意 CSS 文本写进资产。 */
const FUNCTIONAL = /^(?:rgba?|hsla?)\([\d\s.,%/]+\)$/i

/** 随包固化的单条风格记录；字段取舍以技能检索需要为准，不复制上游的封面与变体。 */
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
 * 解析已提交的 JSONL 资产，并对每行结构与顺序做完整性校验。
 * @param text - `assets/styles.jsonl` 的文本内容。
 * @returns 按 slug 升序排列的目录条目。
 * @throws 空行、无法解析的行、字段不合法、slug 重复或顺序错乱时抛出带行号的错误。
 */
export function parseStylekitCatalog(text: string): StylekitCatalogEntry[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const entries = lines.map((line, index) => {
    if (line === '') throw new Error(`stylekit catalog: blank line at ${index + 1}`)
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw new Error(`stylekit catalog: line ${index + 1} is not JSON (${String(error)})`)
    }
    return entry(parsed, `line ${index + 1}`)
  })
  const slugs = entries.map(item => item.slug)
  const ordered = [...slugs].sort((left, right) => left.localeCompare(right))
  if (ordered.some((slug, index) => slug !== slugs[index])) {
    throw new Error('stylekit catalog: entries are not sorted by slug')
  }
  return sorted(entries)
}

/**
 * 序列化为 JSONL：一行一条风格，使 `grep -i <关键词>` 直接命中完整条目，
 * 模型无需整读约 75 KB 资产；按 slug 排序保证输出稳定。
 * @param entries - 目录条目。
 * @returns 以单个换行结尾的 JSONL 文本。
 */
export function serializeStylekitCatalog(entries: readonly StylekitCatalogEntry[]): string {
  return entries.map(item => `${JSON.stringify(item)}\n`).join('')
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
  const colors = isRecord(value.colors) ? value.colors : undefined
  if (colors === undefined) throw new Error(`stylekit catalog: ${path}.colors must be an object`)
  const accent = colors.accent
  if (!Array.isArray(accent) || accent.length === 0) {
    throw new Error(`stylekit catalog: ${path}.colors.accent must be a non-empty array`)
  }
  return {
    slug: text(value.slug, `${path}.slug`),
    name: text(value.name, `${path}.name`),
    nameEn: text(value.nameEn, `${path}.nameEn`),
    category: text(value.category, `${path}.category`),
    styleType: text(value.styleType, `${path}.styleType`),
    tags: strings(value.tags, `${path}.tags`),
    colors: {
      primary: color(colors.primary, `${path}.colors.primary`),
      secondary: color(colors.secondary, `${path}.colors.secondary`),
      accent: accent.map((item, index) => color(item, `${path}.colors.accent[${index}]`)),
    },
    keywords: strings(value.keywords, `${path}.keywords`),
    description: text(value.description, `${path}.description`),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

async function load(): Promise<StylekitCatalogEntry[]> {
  const inputIndex = process.argv.indexOf('--input')
  const input = inputIndex === -1 ? undefined : process.argv[inputIndex + 1]
  if (input !== undefined) {
    return buildStylekitCatalog(JSON.parse(await readFile(input, 'utf8')))
  }
  const response = await fetch(SOURCE, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`stylekit catalog: ${SOURCE} answered ${response.status}`)
  return buildStylekitCatalog(await response.json())
}

async function main(): Promise<void> {
  const committedFile = process.argv.includes('--check')
  if (committedFile) {
    // 资产只能整文件替换：不写临时文件，比较失败即表示需要重新运行生成器。
    const text = await readFile(OUT, 'utf8')
    if (serializeStylekitCatalog(parseStylekitCatalog(text)) !== text) {
      throw new Error(`stylekit catalog: ${OUT} is not in canonical form; run "pnpm run gen:stylekit-catalog"`)
    }
    return
  }
  await writeFile(OUT, serializeStylekitCatalog(await load()))
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`[gen-stylekit-catalog] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
