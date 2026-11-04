/**
 * 版式模板：新建页时按用途铺好元素，避免每次从空画布开始。
 *
 * 模板只决定「这一页有哪些元素、放在哪」，颜色与字号一律取当前主题与画布尺寸，
 * 因此换主题不会让模板失配。模板产出的元素与手放的元素完全等价，用户可以继续拖、
 * 改、删。
 * @module coding-ppt-workbench/templates
 */

import {
  PPT_THEMES, SLIDE_SIZES, newId,
  type PptChartElement, type PptDeck, type PptElement, type PptLineElement,
  type PptShapeElement, type PptTableElement, type PptTextElement,
} from 'coding-ppt-model'

/** 可用的版式模板。 */
export type PptTemplateId =
  | 'title' | 'section' | 'bullets' | 'two-column' | 'data' | 'chart' | 'quote'

/** 模板列表（面板与提示词共用同一份顺序与名称）。 */
export const PPT_TEMPLATES: readonly { readonly id: PptTemplateId; readonly label: string }[] = [
  { id: 'title', label: '封面' },
  { id: 'section', label: '章节页' },
  { id: 'bullets', label: '要点页' },
  { id: 'two-column', label: '双栏对比' },
  { id: 'data', label: '数据表格' },
  { id: 'chart', label: '图表页' },
  { id: 'quote', label: '引用页' },
]

/** 模板填充时用到的可选内容。 */
export interface TemplateFill {
  /** 页面主标题。 */
  readonly title?: string
  /** 要点页/双栏页的条目，最多 6 条。 */
  readonly bullets?: readonly string[]
}

interface Frame {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

function text(
  frame: Frame,
  content: string,
  style: { size: number; color: string; bold?: boolean; align?: 'left' | 'center' | 'right'; valign?: 'top' | 'middle' | 'bottom' },
): PptTextElement {
  return {
    id: newId(), kind: 'text', ...frame,
    text: {
      content,
      size: style.size,
      color: style.color,
      bold: style.bold === true,
      align: style.align ?? 'left',
      valign: style.valign ?? 'top',
      font: '',
    },
  }
}

function rect(frame: Frame, fill: string): PptShapeElement {
  return { id: newId(), kind: 'rect', ...frame, fill }
}

function line(frame: Frame, color: string, width: number): PptLineElement {
  return { id: newId(), kind: 'line', ...frame, color, width }
}

function table(frame: Frame, deck: PptDeck, header: readonly string[], rows: number): PptTableElement {
  const palette = PPT_THEMES[deck.theme]
  return {
    id: newId(), kind: 'table', ...frame,
    rows, columns: header.length,
    columnWeights: header.map(() => 1),
    header: true,
    headerFill: palette.accent,
    borderColor: palette.muted,
    cells: Array.from({ length: rows }, (_, rowIndex) => header.map(name => ({
      content: rowIndex === 0 ? name : '',
    }))),
    text: { size: 22, color: palette.text, bold: false, align: 'left', font: '' },
  }
}

function chart(frame: Frame, deck: PptDeck): PptChartElement {
  const palette = PPT_THEMES[deck.theme]
  return {
    id: newId(), kind: 'chart', ...frame,
    chart: 'bar',
    categories: ['一季度', '二季度', '三季度', '四季度'],
    series: [{ name: '本期', values: [32, 45, 38, 56], color: palette.accent }],
    showValues: false,
    textColor: palette.muted,
  }
}

/**
 * 按模板生成一页的元素。
 * @param template - 模板 id。
 * @param deck - 当前工程（取主题与画布尺寸）。
 * @param fill - 标题与要点内容；缺省时用占位文案。
 * @returns 铺好位置的元素列表。
 */
export function buildTemplate(
  template: PptTemplateId,
  deck: PptDeck,
  fill: TemplateFill = {},
): PptElement[] {
  const palette = PPT_THEMES[deck.theme]
  const size = SLIDE_SIZES[deck.size]
  const margin = deck.size === '16:9' ? 96 : 72
  const width = size.width - margin * 2
  const title = fill.title ?? '页面标题'
  const bullets = (fill.bullets ?? []).filter(item => item.trim() !== '').slice(0, 6)
  const bulletText = bullets.length > 0 ? bullets.map(item => `· ${item}`).join('\n') : '· 第一条要点\n· 第二条要点\n· 第三条要点'

  switch (template) {
    case 'title':
      return [
        text({ x: margin, y: size.height * 0.32, w: width, h: 140 },
          title, { size: 64, color: palette.text, bold: true, valign: 'middle' }),
        text({ x: margin, y: size.height * 0.32 + 150, w: width, h: 64 },
          '副标题 · 汇报人 · 日期', { size: 28, color: palette.muted }),
        rect({ x: margin, y: size.height * 0.32 + 132, w: 160, h: 8 }, palette.accent),
      ]
    case 'section':
      return [
        rect({ x: 0, y: 0, w: size.width, h: size.height }, palette.surface),
        text({ x: margin, y: size.height * 0.3, w: 160, h: 96 },
          '01', { size: 72, color: palette.accent, bold: true }),
        text({ x: margin, y: size.height * 0.3 + 110, w: width, h: 96 },
          title, { size: 48, color: palette.text, bold: true }),
      ]
    case 'bullets':
      return [
        text({ x: margin, y: margin, w: width, h: 96 }, title, { size: 48, color: palette.text, bold: true }),
        line({ x: margin, y: margin + 112, w: 120, h: 0 }, palette.accent, 4),
        text({ x: margin, y: margin + 150, w: width, h: size.height - margin - 200 },
          bulletText, { size: 30, color: palette.text }),
      ]
    case 'two-column':
      return [
        text({ x: margin, y: margin, w: width, h: 80 }, title, { size: 44, color: palette.text, bold: true }),
        rect({ x: margin, y: margin + 104, w: width / 2 - 16, h: 24 }, palette.accent),
        text({ x: margin, y: margin + 104, w: width / 2 - 16, h: 24 }, '现状', { size: 18, color: palette.background, bold: true }),
        text({ x: margin, y: margin + 150, w: width / 2 - 32, h: 360 }, bulletText, { size: 26, color: palette.text }),
        rect({ x: margin + width / 2 + 16, y: margin + 104, w: width / 2 - 16, h: 24 }, palette.accent),
        text({ x: margin + width / 2 + 16, y: margin + 104, w: width / 2 - 16, h: 24 }, '目标', { size: 18, color: palette.background, bold: true }),
        text({ x: margin + width / 2 + 32, y: margin + 150, w: width / 2 - 48, h: 360 }, bulletText, { size: 26, color: palette.text }),
      ]
    case 'data':
      return [
        text({ x: margin, y: margin, w: width, h: 80 }, title, { size: 44, color: palette.text, bold: true }),
        table({ x: margin, y: margin + 120, w: width, h: size.height - margin - 200 }, deck, ['指标', '本期', '上期'], 5),
        text({ x: margin, y: size.height - 96, w: width, h: 40 }, '数据来源：', { size: 18, color: palette.muted }),
      ]
    case 'chart':
      return [
        text({ x: margin, y: margin, w: width, h: 80 }, title, { size: 44, color: palette.text, bold: true }),
        chart({ x: margin, y: margin + 110, w: width, h: size.height - margin - 200 }, deck),
        text({ x: margin, y: size.height - 96, w: width, h: 40 }, '数据来源：', { size: 18, color: palette.muted }),
      ]
    case 'quote':
      return [
        text({ x: margin, y: size.height * 0.22, w: width, h: 240 },
          `「${title}」`, { size: 44, color: palette.text, valign: 'middle' }),
        line({ x: margin, y: size.height * 0.22 + 260, w: 120, h: 0 }, palette.accent, 4),
        text({ x: margin, y: size.height * 0.22 + 290, w: width, h: 48 },
          '—— 署名', { size: 24, color: palette.muted }),
      ]
  }
}

/**
 * 模板的占位页名。
 * @param template - 模板 id。
 * @returns 写在页面名上的中文标签。
 */
export function templateName(template: PptTemplateId): string {
  return PPT_TEMPLATES.find(entry => entry.id === template)?.label ?? '页面'
}
