/** 包 README“已知限制”章节的双语兼容词汇。 */

export const CANONICAL_LIMITATIONS_HEADINGS = [
  '## Known Limitations and Deferred Work',
  '## 已知限制与延后工作',
] as const

/** 供诊断展示的合法 H2 集合。 */
export const CANONICAL_LIMITATIONS_DESCRIPTION =
  CANONICAL_LIMITATIONS_HEADINGS.map(heading => `\`${heading}\``).join(' 或 ')

/**
 * 判断标题语义是否像限制／延后工作章节，包括应被拒绝的旧变体。
 * @param headingText - Markdown parser 提取的纯标题文本。
 * @returns 该标题是否应进入唯一性与 canonical 检查。
 */
export function isLimitationsLike(headingText: string): boolean {
  return (
    /\blimitations?\b/i.test(headingText)
    || /deferred work/i.test(headingText)
    || /what is not here/i.test(headingText)
    || /^deferred\b/i.test(headingText)
    || /^non-goals?\b/i.test(headingText)
    || /已知限制|延后工作|暂缓事项|非目标/u.test(headingText)
  )
}

/**
 * 判断一个原始 Markdown 标题是否为允许的英文或中文 H2。
 * @param raw - 包含井号的原始标题行。
 * @param depth - Markdown 标题层级。
 * @returns 仅对两种 canonical H2 返回 true。
 */
export function isCanonicalLimitationsHeading(raw: string, depth: number): boolean {
  return depth === 2
    && (CANONICAL_LIMITATIONS_HEADINGS as readonly string[]).includes(raw.trimEnd())
}
