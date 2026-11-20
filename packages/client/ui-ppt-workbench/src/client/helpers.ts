/** PPT 面板共享的纯视图辅助函数。 */
import type { PptElementKind, PptPage } from 'coding-ppt-model'
import type { PptSnapshotView } from './wire.ts'
import type { PptPanelState } from './controller.ts'

type PptIssues = PptPanelState['issues']

/**
 * 取当前页。
 * @param project - 工程快照。
 * @param index - 页码下标。
 * @returns 页面；没有工程或下标越界时 null。
 */
export function currentPage(project: PptSnapshotView | null, index: number): PptPage | null {
  if (project === null) return null
  return project.deck.pages[index] ?? null
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 把上传图片的字节编码成宿主接受的内容。 */
export { toBase64 }

/**
 * 解析质检响应。
 * @param value - 响应里的 `check` 字段。
 * @returns 问题列表；结构不完整时 null。
 */
export function parseCheck(value: unknown): PptIssues {
  if (typeof value !== 'object' || value === null) return null
  const issues = (value as { issues?: unknown }).issues
  if (!Array.isArray(issues)) return null
  return issues.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    const severity = record.severity === 'error' ? 'error' : record.severity === 'warning' ? 'warning' : null
    if (severity === null || typeof record.code !== 'string'
      || typeof record.pageName !== 'string' || typeof record.message !== 'string') return []
    return [{ severity, code: record.code, pageName: record.pageName, message: record.message }]
  })
}

/** 页数变化时让选中页保持在有效范围。 */
export function clampPageIndex(project: PptSnapshotView, index: number): number {
  return Math.min(Math.max(index, 0), Math.max(project.deck.pages.length - 1, 0))
}

/** 新元素的默认几何：按已有元素数量错位摆放，避免完全重叠。 */
export function newElement(kind: PptElementKind, count: number): Record<string, unknown> {
  const offset = (count % 6) * 24
  const base = { x: 120 + offset, y: 140 + offset }
  if (kind === 'table') {
    return {
      kind, ...base, w: 720, h: 264, rows: 3, columns: 3, header: true,
      cells: [
        [{ content: '项目' }, { content: '本期' }, { content: '上期' }],
        [{ content: '' }, { content: '' }, { content: '' }],
        [{ content: '' }, { content: '' }, { content: '' }],
      ],
    }
  }
  if (kind === 'text') {
    return {
      kind, ...base, w: 520, h: 96,
      text: { content: '双击编辑文字', size: 32, bold: false, align: 'left', valign: 'top' },
    }
  }
  if (kind === 'line') return { kind, ...base, w: 640, h: 0, color: '#9aa7b4', width: 4 }
  if (kind === 'chart') {
    return {
      kind, ...base, w: 720, h: 360, chart: 'bar',
      categories: ['一季度', '二季度', '三季度', '四季度'],
      series: [{ name: '本期', values: [32, 45, 38, 56], color: '#4f8cff' }],
      textColor: '#9aa7b4',
    }
  }
  return { kind, ...base, w: 320, h: 200, fill: '#4f8cff' }
}
