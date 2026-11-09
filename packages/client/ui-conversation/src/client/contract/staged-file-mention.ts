/**
 * 从本机暂存文件的规范引用恢复展示名；只识别 Home 上传目录中的绝对路径。
 * 路径本身始终留在剪贴板、会话日志与模型输入中，不从显示名反推文件位置。
 */

/** Host 使用正斜杠表示 POSIX 或 Windows 的规范绝对路径。 */
const STAGED_PATH = new RegExp(
  ['(?:\\/|[A-Za-z]:\\\/)', '(?:[^/]+\\\/)*', 'files\\\/uploads\\\/',
    '[a-f\\d]{8}-[a-f\\d]{4}-4[a-f\\d]{3}-[89ab][a-f\\d]{3}-[a-f\\d]{12}-',
    '([\\p{L}\\p{N} ._-]+)$'].join(''), 'iu')

/**
 * 校验 Host 发布的暂存路径，并提取安全保存名；不接纳其他浏览器本地路径。
 * @param path - Host 返回的完整本机路径。
 * @returns 安全保存名，路径不规范时返回 undefined。
 */
export function stagedFilePathName(path: string): string | undefined {
  if (path.includes('..') || /["'\\\p{Cc}\p{Cf}]/u.test(path)
    || path.split('/').some(segment => segment === '.')) return undefined
  const name = STAGED_PATH.exec(path)?.[1]
  if (name === undefined || /^[. ]|[. ]$/u.test(name)) return undefined
  return name
}

export interface StagedFileMention {
  readonly start: number
  readonly end: number
  readonly mention: string
  readonly label: string
}

/**
 * 提取已落盘文件的安全保存名；普通工作区引用与不完整路径保持原样展示。
 * @param mention - 含 @ 的完整文件提及。
 * @returns 暂存文件名，非暂存引用返回 undefined。
 */
export function stagedFileName(mention: string): string | undefined {
  const quoted = mention.startsWith('@"') && mention.endsWith('"')
  if (!quoted && (!mention.startsWith('@') || /["'()\[\]{}<>]/u.test(mention))) return undefined
  const path = quoted ? mention.slice(2, -1) : mention.slice(1)
  if (!quoted && /\s/u.test(path)) return undefined
  return stagedFilePathName(path)
}

/**
 * 定位持久草稿或粘贴文本中的暂存引用；偏移始终是规范文本的 UTF-16 偏移。
 * @param text - 原始文本，不修改普通引用或非引用路径。
 * @returns 按出现顺序排列的完整暂存引用。
 */
export function stagedFileMentions(text: string): StagedFileMention[] {
  const references: StagedFileMention[] = []
  const pattern = /(^|\s)(@"[^"\n]+"(?=$|[\s,;:!?，。；：！？)\]}<>])|@(?:\/|[A-Za-z]:\/)[^\s,;:!?，。；：！？"'()\[\]{}<>]+)/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const mention = match[2] ?? ''
    const label = stagedFileName(mention)
    if (label === undefined) continue
    const start = match.index + (match[1]?.length ?? 0)
    references.push({ start, end: start + mention.length, mention, label })
  }
  return references
}

/**
 * 将已暂存路径投影成文件名，供导航预览和排队摘要使用；原文不变。
 * @param text - 模型可见或持久草稿文本。
 * @returns 只替换识别出的暂存文件引用后的预览文本。
 */
export function displayStagedFiles(text: string): string {
  const mentions = stagedFileMentions(text)
  if (mentions.length === 0) return text
  let display = ''
  let cursor = 0
  for (const mention of mentions) {
    display += text.slice(cursor, mention.start) + `@${mention.label}`
    cursor = mention.end
  }
  return display + text.slice(cursor)
}
