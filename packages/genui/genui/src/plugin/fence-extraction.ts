/** 从 assistant 正文中提取 GenUI 围栏，并保留旧语言别名的兼容识别。 */

import { createHash } from 'node:crypto'
import { isGenuiFenceLanguage } from '../shared/fence-language.ts'

/** 围栏结束行；GenUI 正文不会嵌套 Markdown 围栏。 */
const FENCE_CLOSE = /^ {0,3}```[ \t]*$/u
/** 围栏起始行；语言名之后只能有空白，避免误认 `gen-ui-dark` 等标签。 */
const FENCE_OPEN = /^ {0,3}```[ \t]*([^\s`]+)[ \t]*$/u
/** 单条回复最多检查的围栏数量。 */
const MAX_FENCES = 40

/** 一条 assistant 回复中的 GenUI 围栏。 */
export interface ExtractedFence {
  /** 围栏分隔符之间的正文，不包含分隔符。 */
  readonly raw: string
  /** 回复结束前是否看到了闭合围栏。 */
  readonly closed: boolean
  /** 该围栏在当前回复中的一基序号。 */
  readonly index: number
}

/**
 * 提取回复中的新旧 GenUI 围栏。
 *
 * 语言信息必须整行精确匹配；普通代码围栏、带后缀的语言名和正文中的提及
 * 都不会进入反馈链路。旧 `dsh-ui` 只在这里作为兼容别名保留。
 *
 * @param text - assistant 回复正文。
 * @returns 按文档顺序排列的围栏，最多 {@link MAX_FENCES} 条。
 */
export function extractGenuiFences(text: string): ExtractedFence[] {
  const lines = text.split('\n')
  const fences: ExtractedFence[] = []
  let open: { start: number; index: number } | null = null
  for (let line = 0; line < lines.length; line += 1) {
    const current = lines[line] ?? ''
    if (open === null) {
      const match = FENCE_OPEN.exec(current)
      if (match !== null && isGenuiFenceLanguage(match[1])) {
        open = { start: line + 1, index: fences.length + 1 }
      }
      continue
    }
    if (!FENCE_CLOSE.test(current)) continue
    fences.push({ raw: lines.slice(open.start, line).join('\n'), closed: true, index: open.index })
    open = null
    if (fences.length >= MAX_FENCES) return fences
  }
  if (open !== null && fences.length < MAX_FENCES) {
    fences.push({ raw: lines.slice(open.start).join('\n'), closed: false, index: open.index })
  }
  return fences
}

/** 兼容旧的内部导出名；识别逻辑同时接受 gen-ui 与 dsh-ui。 */
export const extractDshUiFences = extractGenuiFences

/** 围栏正文的稳定、可写入日志的身份。 */
export function fenceFingerprint(raw: string): string {
  return createHash('sha256').update(raw.trim()).digest('hex').slice(0, 12)
}
