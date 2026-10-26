/**
 * 主题包的导入、导出与分享链接。
 *
 * 主题包是一个纯数据的 JSON：id、名称、明暗归属、令牌表与可选强调色。导入
 * 路径对外部文件做完整校验——令牌名必须以 `--` 开头、值必须是字符串、条数
 * 与长度有上限，任何一项不合格就整包拒绝并给出具体原因，不做"尽量导入"。
 * 分享链接把同一份 JSON 编码进 URL hash，落地时走同一条校验。
 */
import type { ImportedThemePack, ThemePackTokens } from '../theme-settings.ts'

/** 主题包文件格式版本。 */
export const THEME_PACK_VERSION = 1

/** 一个令牌表最多容纳的条目数。 */
const MAX_TOKENS = 512

/** 单个令牌值（或名称）的最大长度。 */
const MAX_VALUE_LENGTH = 400

/** 主题名最大长度。 */
const MAX_NAME_LENGTH = 40

/** 分享链接里的 hash 参数名。 */
const HASH_KEY = 'theme-pack'

/** 解析结果：成功给出主题包，失败给出可直接展示的原因。 */
export type ThemePackParse =
  | { ok: true; pack: ImportedThemePack }
  | { ok: false; reason: string }

/**
 * 把一个令牌表的取值收成 `Record<string, string>`。
 * @param value - 外部 JSON 里的候选值。
 * @param label - 出错时用于定位的字段名。
 * @returns 令牌表，或一条错误原因。
 */
function readTokens(value: unknown, label: string): ThemePackTokens | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${label} 必须是一个对象`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return `${label} 不能为空`
  if (entries.length > MAX_TOKENS) return `${label} 的条目超过 ${MAX_TOKENS} 条`
  const tokens: ThemePackTokens = {}
  for (const [name, token] of entries) {
    if (!name.startsWith('--')) return `${label} 里的 "${name}" 不是 CSS 变量名（应以 -- 开头）`
    if (name.length > MAX_VALUE_LENGTH) return `${label} 里的变量名过长`
    if (typeof token !== 'string' || token.trim() === '') return `${label} 里的 "${name}" 必须是非空字符串`
    if (token.length > MAX_VALUE_LENGTH) return `${label} 里的 "${name}" 的取值过长`
    tokens[name] = token
  }
  return tokens
}

/**
 * 把主题名压成可做 id 的 slug。
 * @param name - 主题名。
 * @returns 只含小写字母、数字与连字符的 slug；中文名会回落到固定前缀。
 */
function slugOf(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'pack' : slug.slice(0, 32)
}

/**
 * 校验并归一化一个外部主题包。
 * @param raw - 解析后的 JSON 值。
 * @param existingIds - 已知的主题 id，用于避免覆盖内置主题或已导入的包。
 * @returns 解析结果；失败时 `reason` 是给用户看的具体原因。
 */
export function parseThemePack(raw: unknown, existingIds: Iterable<string> = []): ThemePackParse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: '主题包必须是一个 JSON 对象' }
  }
  const record = raw as Record<string, unknown>
  const version = record.version
  if (version !== undefined && version !== THEME_PACK_VERSION) {
    return { ok: false, reason: `不支持的主题包版本 ${JSON.stringify(version)}` }
  }
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (name === '') return { ok: false, reason: '主题包缺少 name' }
  if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: `主题名不能超过 ${MAX_NAME_LENGTH} 个字符` }
  const englishNameRaw = typeof record.englishName === 'string' ? record.englishName.trim() : ''
  const englishName = englishNameRaw === '' ? name : englishNameRaw.slice(0, MAX_NAME_LENGTH)
  const scheme = record.scheme
  if (scheme !== 'light' && scheme !== 'dark' && scheme !== 'auto') {
    return { ok: false, reason: '主题包的 scheme 必须是 light、dark 或 auto' }
  }

  const taken = new Set(existingIds)
  let id = `imported-${slugOf(name)}`
  for (let suffix = 2; taken.has(id); suffix += 1) id = `imported-${slugOf(name)}-${suffix}`

  const accent = typeof record.accent === 'string' ? record.accent.trim().slice(0, MAX_VALUE_LENGTH) : ''
  const pack: ImportedThemePack = { id, name, englishName, scheme, ...(accent === '' ? {} : { accent }) }

  if (scheme === 'auto') {
    const palettes = record.palettes
    if (typeof palettes !== 'object' || palettes === null || Array.isArray(palettes)) {
      return { ok: false, reason: '跟随明暗的主题包必须提供 palettes' }
    }
    const light = readTokens((palettes as Record<string, unknown>).light, 'palettes.light')
    if (typeof light === 'string') return { ok: false, reason: light }
    const dark = readTokens((palettes as Record<string, unknown>).dark, 'palettes.dark')
    if (typeof dark === 'string') return { ok: false, reason: dark }
    return { ok: true, pack: { ...pack, palettes: { light, dark } } }
  }

  const tokens = readTokens(record.tokens, 'tokens')
  if (typeof tokens === 'string') return { ok: false, reason: tokens }
  return { ok: true, pack: { ...pack, tokens } }
}

/**
 * 把主题包导出成可下载/可复制的 JSON 文本。
 * @param pack - 主题包。
 * @returns 带版本号的 JSON 文本。
 */
export function serializeThemePack(pack: ImportedThemePack): string {
  return JSON.stringify({ version: THEME_PACK_VERSION, ...pack }, null, 2)
}

/** UTF-8 文本转 base64url（分享链接里不带 `+/=`）。 */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64url 转回 UTF-8 文本；格式不对返回 undefined。 */
function fromBase64Url(encoded: string): string | undefined {
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * 生成分享链接（当前页面地址 + hash）。
 * @param pack - 主题包。
 * @param base - 可选的地址前缀，默认为当前页面的 origin + pathname。
 * @returns 可复制的分享链接；没有浏览器地址时返回空串。
 */
export function themePackShareUrl(pack: ImportedThemePack, base?: string): string {
  const prefix = base ?? (typeof location === 'undefined' ? '' : `${location.origin}${location.pathname}`)
  if (prefix === '') return ''
  return `${prefix}#${HASH_KEY}=${toBase64Url(JSON.stringify({ version: THEME_PACK_VERSION, ...pack }))}`
}

/**
 * 从 URL hash 里取出主题包文本。
 * @param hash - `location.hash`（可带前导 `#`）。
 * @returns JSON 文本；hash 里没有主题包或解不开时返回 undefined。
 */
export function themePackFromHash(hash: string): string | undefined {
  const normalized = hash.startsWith('#') ? hash.slice(1) : hash
  const prefix = `${HASH_KEY}=`
  const entry = normalized.split('&').find(part => part.startsWith(prefix))
  if (entry === undefined) return undefined
  return fromBase64Url(entry.slice(prefix.length))
}
