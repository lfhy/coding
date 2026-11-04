/**
 * 规则质检：在导出前检查那些「打开就能看出来」的版式问题——元素出界、尺寸为零、
 * 文字按估算溢出文本框、文字与底色的对比度不足。
 *
 * 这些规则只依赖工程自身的数据，不需要光栅化或外部进程，因此面板与模型工具拿到的是
 * 同一份结论。估算类规则（溢出、对比度）给出 warning 而不是 error，只有确定性错误
 * 才阻断导出。
 * @module coding-ppt-workbench/check
 */

import {
  PPT_THEMES, SLIDE_SIZES,
  type PptDeck, type PptElement, type PptPage,
} from 'coding-ppt-model'

/** 单条质检结论。 */
export interface PptIssue {
  /** `error` 阻断导出，`warning` 只提示。 */
  readonly severity: 'error' | 'warning'
  /** 稳定的规则标识，供面板分组与模型按规则修复。 */
  readonly code: 'out-of-bounds' | 'zero-size' | 'text-overflow' | 'low-contrast'
    | 'empty-page' | 'too-much-text'
  readonly page: string
  readonly pageName: string
  /** 涉及的元素 id；页面级问题省略。 */
  readonly element?: string
  /** 面向人的说明，指出在哪一页、哪个元素、怎么修。 */
  readonly message: string
}

/** 质检结果。 */
export interface PptCheckResult {
  /** 没有 error 级问题时为 true。 */
  readonly ok: boolean
  readonly issues: readonly PptIssue[]
}

/** 相对亮度，用于 WCAG 对比度计算。 */
function luminance(hex: string): number {
  const value = hex.replace('#', '')
  const channels = [0, 2, 4].map((offset) => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16) / 255
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)
}

/**
 * 两个颜色的对比度。
 * @param foreground - 前景色 `#rrggbb`。
 * @param background - 背景色 `#rrggbb`。
 * @returns 1 到 21 之间的对比度。
 */
export function contrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground)
  const second = luminance(background)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * 估算一段文字在给定宽度下占多少行。
 * @param content - 文本内容。
 * @param width - 文本框宽度（基准像素）。
 * @param size - 字号（基准像素）。
 * @returns 估算行数。
 */
export function estimateLines(content: string, width: number, size: number): number {
  // 字号的一半近似平均字宽：中文全角、英文与数字更窄，取一个略保守的估值。
  const perLine = Math.max(1, Math.floor(width / (size * 0.55)))
  return content
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0)
}

function textOverflows(element: Extract<PptElement, { kind: 'text' }>): boolean {
  if (element.text.content.trim() === '') return false
  const lines = estimateLines(element.text.content, element.w, element.text.size)
  return lines * element.text.size * 1.25 > element.h + element.text.size * 0.5
}

/**
 * 检查一份演示文稿。
 * @param deck - 已校验的工程。
 * @returns 质检结果；`ok` 为 false 时表示存在阻断导出的问题。
 */
export function checkDeck(deck: PptDeck): PptCheckResult {
  const size = SLIDE_SIZES[deck.size]
  const palette = PPT_THEMES[deck.theme]
  const issues: PptIssue[] = []
  const push = (issue: PptIssue): void => { issues.push(issue) }

  for (const page of deck.pages) {
    const background = page.background ?? palette.background
    if (page.elements.length === 0) {
      push({
        severity: 'warning', code: 'empty-page', page: page.id, pageName: page.name,
        message: `第「${page.name}」页是空的：补上内容或删掉这一页`,
      })
    }
    const characters = page.elements.reduce((sum, element) => (
      sum + (element.kind === 'text' ? element.text.content.length : 0)
    ), 0)
    if (characters > 420) {
      push({
        severity: 'warning', code: 'too-much-text', page: page.id, pageName: page.name,
        message: `第「${page.name}」页文字太多（约 ${characters} 字）：一页一个观点，考虑拆页或删减`,
      })
    }
    for (const element of page.elements) {
      checkGeometry(page, element, size, push)
      if (element.kind === 'text') {
        if (textOverflows(element)) {
          push({
            severity: 'warning', code: 'text-overflow', page: page.id, pageName: page.name,
            element: element.id,
            message: `第「${page.name}」页的文字框放不下这些字：减小字号、加高文本框或删掉部分内容`,
          })
        }
        if (contrastRatio(element.text.color, background) < 3) {
          push({
            severity: 'warning', code: 'low-contrast', page: page.id, pageName: page.name,
            element: element.id,
            message: `第「${page.name}」页的文字与底色对比度不足 3:1，深底请用浅字、浅底请用深字`,
          })
        }
      }
      if (element.kind === 'table') {
        const sizeOk = contrastRatio(element.text.color, background) >= 3
        if (!sizeOk) {
          push({
            severity: 'warning', code: 'low-contrast', page: page.id, pageName: page.name,
            element: element.id,
            message: `第「${page.name}」页的表格文字与底色对比度不足 3:1`,
          })
        }
      }
    }
  }
  return { ok: issues.every(issue => issue.severity !== 'error'), issues }
}

function checkGeometry(
  page: PptPage,
  element: PptElement,
  size: { width: number; height: number },
  push: (issue: PptIssue) => void,
): void {
  const outside = element.x < -1 || element.y < -1
    || element.x + element.w > size.width + 1 || element.y + element.h > size.height + 1
  if (outside) {
    push({
      severity: 'error', code: 'out-of-bounds', page: page.id, pageName: page.name, element: element.id,
      message: `第「${page.name}」页有元素超出画布边界（${size.width}×${size.height}）：把位置或尺寸收进画布内`,
    })
  }
  if (element.kind !== 'line' && (element.w <= 0 || element.h <= 0)) {
    push({
      severity: 'error', code: 'zero-size', page: page.id, pageName: page.name, element: element.id,
      message: `第「${page.name}」页有元素宽或高为 0：删除它或给出正的尺寸`,
    })
  }
}
