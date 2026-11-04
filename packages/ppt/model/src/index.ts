/**
 * PPT 工程的幻灯片数据模型：纯 JSON，宿主、模型工具与右侧工作台共用同一份契约。
 *
 * 坐标与尺寸都以「基准像素」表示——宽 1280、高 720（16:9）或 960×720（4:3）。导出时按
 * 96 DPI 换算成 EMU（1 像素 = 9525 EMU），因此面板与 .pptx 的版式一致。颜色一律是
 * `#rrggbb` 字面量；页面 `background` 为 `null` 时使用主题底色，改主题即可整体换色。
 * @module coding-ppt-workbench/model
 */

/** 磁盘与内存中的工程格式版本；读取到其它版本即拒绝，不做迁移。 */
export const PPT_FORMAT = 1

/** 支持的画布尺寸。 */
export type SlideSizeId = '16:9' | '4:3'

/** 一种画布尺寸的基准像素。 */
export interface SlideBaseSize {
  readonly width: number
  readonly height: number
}

/** 画布尺寸表；基准像素同时是编辑器与导出的坐标系。 */
export const SLIDE_SIZES: Readonly<Record<SlideSizeId, SlideBaseSize>> = {
  '16:9': { width: 1280, height: 720 },
  '4:3': { width: 960, height: 720 },
}

/** 随包提供的配色主题。 */
export type ThemeId = 'ink' | 'paper' | 'ocean' | 'forest'

/** 一套主题配色；页面与元素只存具体颜色，取色时回落到这里。 */
export interface PptTheme {
  readonly id: ThemeId
  readonly label: string
  readonly background: string
  readonly surface: string
  readonly text: string
  readonly muted: string
  readonly accent: string
}

/** 四套随包主题，覆盖深色汇报、纸张、海洋与森林四类场合。 */
export const PPT_THEMES: Readonly<Record<ThemeId, PptTheme>> = {
  ink: {
    id: 'ink', label: '深墨', background: '#101418', surface: '#1b222a',
    text: '#f5f7fa', muted: '#9aa7b4', accent: '#4f8cff',
  },
  paper: {
    id: 'paper', label: '纸张', background: '#faf7f1', surface: '#f0eadd',
    text: '#23201b', muted: '#6f675c', accent: '#b5652c',
  },
  ocean: {
    id: 'ocean', label: '海洋', background: '#0b2b3c', surface: '#12384c',
    text: '#eaf6fb', muted: '#8fb6c6', accent: '#37c2d6',
  },
  forest: {
    id: 'forest', label: '森林', background: '#14231b', surface: '#1d3226',
    text: '#f0f6ef', muted: '#9db3a3', accent: '#7cc47f',
  },
}

/** 文本对齐方式。 */
export type TextAlign = 'left' | 'center' | 'right'
/** 文本垂直对齐方式。 */
export type TextVAlign = 'top' | 'middle' | 'bottom'

/** 文本元素的排版属性。 */
export interface PptText {
  readonly content: string
  /** 字号，单位是基准像素。 */
  readonly size: number
  readonly color: string
  readonly bold: boolean
  readonly align: TextAlign
  readonly valign: TextVAlign
  /** 字体族名；空串表示跟随主题的默认字体。 */
  readonly font: string
}

/** 所有元素共有的位置与尺寸。 */
export interface ElementFrame {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** 可选元素属性：入场动画。 */
export interface ElementMotion {
  /** 入场动画；`none` 或缺省表示不带动画。 */
  readonly animation?: ElementAnimation
}

/** 文本框。 */
export interface PptTextElement extends ElementFrame, ElementMotion {
  readonly id: string
  readonly kind: 'text'
  readonly text: PptText
}

/** 矩形或椭圆色块。 */
export interface PptShapeElement extends ElementFrame, ElementMotion {
  readonly id: string
  readonly kind: 'rect' | 'ellipse'
  readonly fill: string
}

/** 水平或斜向直线段，坐标系与其它元素一致（可旋转，以帧的对角线表示）。 */
export interface PptLineElement extends ElementFrame, ElementMotion {
  readonly id: string
  readonly kind: 'line'
  readonly color: string
  /** 线宽，单位是基准像素。 */
  readonly width: number
}

/** 图片元素：`source` 是工程目录内的相对路径（例如 `media/cover.png`）。 */
export interface PptImageElement extends ElementFrame, ElementMotion {
  readonly id: string
  readonly kind: 'image'
  readonly source: string
  /** `cover` 填满裁切，`contain` 完整放入。 */
  readonly fit: 'cover' | 'contain'
}

/** 表格单元格。 */
export interface PptTableCell {
  readonly content: string
}

/** 表格元素的共享排版。 */
export interface PptTableStyle {
  /** 字号，单位是基准像素。 */
  readonly size: number
  readonly color: string
  readonly bold: boolean
  readonly align: TextAlign
  /** 字体族名；空串表示跟随主题的默认字体。 */
  readonly font: string
}

/** 表格元素；`cells` 的维度必须等于 rows × columns。 */
export interface PptTableElement extends ElementFrame, ElementMotion {
  readonly id: string
  readonly kind: 'table'
  readonly rows: number
  readonly columns: number
  /** 各列相对宽度权重，长度等于 columns。 */
  readonly columnWeights: readonly number[]
  /** 首行是否按表头样式绘制。 */
  readonly header: boolean
  readonly headerFill: string
  readonly borderColor: string
  readonly text: PptTableStyle
  readonly cells: readonly (readonly PptTableCell[])[]
}

/** 图表类型。 */
export type PptChartKind = 'bar' | 'line' | 'pie'

/** 图表里的一条系列。 */
export interface PptChartSeries {
  readonly name: string
  readonly values: readonly number[]
  readonly color: string
  /** 画在主轴还是次坐标轴；缺省主轴。 */
  readonly axis?: 'primary' | 'secondary'
  /** 组合图里这条系列画成柱还是线；缺省跟随图表类型。 */
  readonly as?: 'bar' | 'line'
}

/** 图表元素：分类轴 + 一到多条系列。 */
export interface PptChartElement extends ElementFrame, ElementMotion {
  readonly id: string
  readonly kind: 'chart'
  readonly chart: PptChartKind
  readonly categories: readonly string[]
  readonly series: readonly PptChartSeries[]
  /** 是否显示数值标签。 */
  readonly showValues: boolean
  /** 柱状/折线是否堆叠。 */
  readonly stacked: boolean
  /** 文字与网格颜色。 */
  readonly textColor: string
}

/** 元素入场动画。 */
export type ElementAnimation = 'none' | 'fade' | 'fly' | 'zoom' | 'wipe'

/** 一页上的一个元素；数组顺序即绘制顺序（后面的盖住前面的）。 */
export type PptElement =
  | PptTextElement | PptShapeElement | PptLineElement | PptImageElement | PptTableElement | PptChartElement

/** 元素种类。 */
export type PptElementKind = PptElement['kind']

/** 页面切换时的转场效果。 */
export type SlideTransition = 'none' | 'fade' | 'push'

/** 一页幻灯片。 */
export interface PptPage {
  readonly id: string
  readonly name: string
  /** `null` 表示使用主题底色。 */
  readonly background: string | null
  readonly transition: SlideTransition
  readonly elements: readonly PptElement[]
}

/** 一份演示文稿。 */
export interface PptDeck {
  readonly format: number
  readonly title: string
  readonly size: SlideSizeId
  readonly theme: ThemeId
  readonly pages: readonly PptPage[]
}

/** 工程内容不合法时抛出；调用方据此拒绝写入并把原因回给模型或面板。 */
export class PptModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PptModelError'
  }
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/u
const MAX_PAGES = 200
const MAX_ELEMENTS = 200
const MAX_TEXT = 5000

/**
 * 判断一个值是否是可以索引的普通对象。
 * @param value - 待判断的值。
 * @returns 为非 null 且非数组的对象时为 true。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new PptModelError(`${what} 必须是有限数字`)
  return value
}

/**
 * 校验并收敛一个数值到闭区间。
 * @param value - 待校验的值。
 * @param what - 诊断里使用的字段名。
 * @param min - 允许的最小值。
 * @param max - 允许的最大值。
 * @returns 原值；越界或非数字时抛错。
 */
export function bounded(value: unknown, what: string, min: number, max: number): number {
  const number = finite(value, what)
  if (number < min || number > max) throw new PptModelError(`${what} 必须在 ${min} 到 ${max} 之间`)
  return number
}

/**
 * 校验颜色字面量。
 * @param value - 待校验的值。
 * @param what - 诊断里使用的字段名。
 * @returns 规范为小写的 `#rrggbb`。
 */
export function color(value: unknown, what: string): string {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) throw new PptModelError(`${what} 必须是 #rrggbb 颜色`)
  return value.toLowerCase()
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw new PptModelError(`${what} 必须是字符串`)
  if (value.length > max) throw new PptModelError(`${what} 不能超过 ${max} 个字符`)
  return value
}

function oneOf<T extends string>(value: unknown, what: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new PptModelError(`${what} 必须是 ${allowed.join(' / ')} 之一`)
  }
  return value as T
}

function frame(value: Record<string, unknown>, at: string): ElementFrame {
  return {
    x: bounded(value.x, `${at}.x`, -100_000, 100_000),
    y: bounded(value.y, `${at}.y`, -100_000, 100_000),
    w: bounded(value.w, `${at}.w`, 0, 100_000),
    h: bounded(value.h, `${at}.h`, 0, 100_000),
  }
}

function parseTextStyle(value: unknown, at: string): PptText {
  if (!isRecord(value)) throw new PptModelError(`${at} 必须是对象`)
  return {
    content: text(value.content, `${at}.content`, MAX_TEXT),
    size: bounded(value.size, `${at}.size`, 6, 400),
    color: color(value.color, `${at}.color`),
    bold: value.bold === true,
    align: oneOf(value.align, `${at}.align`, ['left', 'center', 'right'] as const),
    valign: oneOf(value.valign, `${at}.valign`, ['top', 'middle', 'bottom'] as const),
    font: fontFamily(value.font, `${at}.font`),
  }
}

/**
 * 校验字体族名：空串表示跟随主题默认字体。
 * @param value - 候选值。
 * @param at - 诊断里使用的位置描述。
 * @returns 规范化后的族名。
 */
export function fontFamily(value: unknown, at: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > 120) throw new PptModelError(`${at} 必须是 120 字符以内的字符串`)
  return value.trim()
}

function motion(value: Record<string, unknown>, at: string): { animation?: ElementAnimation } {
  if (value.animation === undefined) return {}
  return { animation: oneOf(value.animation, `${at}.animation`, MOTIONS) }
}

const MOTIONS = ['none', 'fade', 'fly', 'zoom', 'wipe'] as const
const CHART_KINDS = ['bar', 'line', 'pie'] as const

/**
 * 校验一个元素。
 * @param value - 候选元素。
 * @param at - 诊断里使用的位置描述。
 * @returns 归一化后的元素。
 */
export function parseElement(value: unknown, at: string): PptElement {
  if (!isRecord(value)) throw new PptModelError(`${at} 必须是对象`)
  const id = text(value.id, `${at}.id`, 64)
  const box = frame(value, at)
  if (value.kind === 'text') {
    return { id, kind: 'text', ...box, ...motion(value, at), text: parseTextStyle(value.text, `${at}.text`) }
  }
  if (value.kind === 'rect' || value.kind === 'ellipse') {
    return { id, kind: value.kind, ...box, ...motion(value, at), fill: color(value.fill, `${at}.fill`) }
  }
  if (value.kind === 'line') {
    return {
      id, kind: 'line', ...box, ...motion(value, at),
      color: color(value.color, `${at}.color`),
      width: bounded(value.width, `${at}.width`, 0.5, 40),
    }
  }
  if (value.kind === 'image') {
    return {
      id, kind: 'image', ...box, ...motion(value, at),
      source: mediaPath(value.source, `${at}.source`),
      fit: value.fit === 'contain' ? 'contain' : 'cover',
    }
  }
  if (value.kind === 'table') {
    return { id, kind: 'table', ...box, ...parseTable(value, at), ...motion(value, at) }
  }
  if (value.kind === 'chart') {
    return { id, kind: 'chart', ...box, ...parseChart(value, at), ...motion(value, at) }
  }
  throw new PptModelError(`${at}.kind 必须是 text / rect / ellipse / line / image / table 之一`)
}

/**
 * 校验工程内的媒体相对路径：只允许 `media/` 下的单层文件名，避免读到工程外的东西。
 * @param value - 候选路径。
 * @param at - 诊断里使用的位置描述。
 * @returns 规范化的相对路径。
 */
export function mediaPath(value: unknown, at: string): string {
  const path = text(value, at, 200)
  if (!/^media\/[A-Za-z0-9._-]{1,120}$/u.test(path) || path.includes('..')) {
    throw new PptModelError(`${at} 必须是 media/ 下的文件名`)
  }
  return path
}

function parseTableStyle(value: unknown, at: string): PptTableStyle {
  if (!isRecord(value)) throw new PptModelError(`${at} 必须是对象`)
  return {
    size: bounded(value.size, `${at}.size`, 6, 120),
    color: color(value.color, `${at}.color`),
    bold: value.bold === true,
    align: oneOf(value.align, `${at}.align`, ['left', 'center', 'right'] as const),
    font: fontFamily(value.font, `${at}.font`),
  }
}

function parseTable(value: Record<string, unknown>, at: string): Omit<PptTableElement, 'id' | 'kind' | 'x' | 'y' | 'w' | 'h'> {
  const rows = bounded(value.rows, `${at}.rows`, 1, 50)
  const columns = bounded(value.columns, `${at}.columns`, 1, 20)
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns)) {
    throw new PptModelError(`${at} 的行列数必须是整数`)
  }
  if (!Array.isArray(value.columnWeights) || value.columnWeights.length !== columns) {
    throw new PptModelError(`${at}.columnWeights 长度必须等于列数`)
  }
  const columnWeights = value.columnWeights.map((weight, index) => bounded(weight, `${at}.columnWeights[${index}]`, 0.1, 100))
  if (!Array.isArray(value.cells) || value.cells.length !== rows) {
    throw new PptModelError(`${at}.cells 的维度必须等于行数`)
  }
  const cells = value.cells.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== columns) {
      throw new PptModelError(`${at}.cells[${rowIndex}] 的列数必须等于 ${columns}`)
    }
    return row.map((cell, columnIndex) => {
      if (!isRecord(cell)) throw new PptModelError(`${at}.cells[${rowIndex}][${columnIndex}] 必须是对象`)
      return { content: text(cell.content, `${at}.cells[${rowIndex}][${columnIndex}].content`, MAX_TEXT) }
    })
  })
  return {
    rows, columns, columnWeights, cells,
    header: value.header !== false,
    headerFill: color(value.headerFill, `${at}.headerFill`),
    borderColor: color(value.borderColor, `${at}.borderColor`),
    text: parseTableStyle(value.text, `${at}.text`),
  }
}

function parseChart(value: Record<string, unknown>, at: string): Omit<PptChartElement, 'id' | 'kind' | 'x' | 'y' | 'w' | 'h'> {
  if (!Array.isArray(value.categories) || value.categories.length === 0) {
    throw new PptModelError(`${at}.categories 必须是非空数组`)
  }
  if (value.categories.length > 50) throw new PptModelError(`${at}.categories 不能超过 50 项`)
  const categories = value.categories.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length > 120) {
      throw new PptModelError(`${at}.categories[${index}] 必须是 120 字符以内的字符串`)
    }
    return entry
  })
  if (!Array.isArray(value.series) || value.series.length === 0) {
    throw new PptModelError(`${at}.series 必须是非空数组`)
  }
  if (value.series.length > 8) throw new PptModelError(`${at}.series 不能超过 8 条`)
  const series = value.series.map((entry, index) => {
    if (!isRecord(entry)) throw new PptModelError(`${at}.series[${index}] 必须是对象`)
    if (typeof entry.name !== 'string' || entry.name.length > 120) {
      throw new PptModelError(`${at}.series[${index}].name 必须是 120 字符以内的字符串`)
    }
    if (!Array.isArray(entry.values) || entry.values.length !== categories.length) {
      throw new PptModelError(`${at}.series[${index}].values 长度必须等于分类数`)
    }
    return {
      name: entry.name,
      values: entry.values.map((item, valueIndex) => bounded(item, `${at}.series[${index}].values[${valueIndex}]`, -1e9, 1e9)),
      color: color(entry.color, `${at}.series[${index}].color`),
      ...entry.axis === undefined
        ? {}
        : { axis: oneOf(entry.axis, `${at}.series[${index}].axis`, ['primary', 'secondary'] as const) },
      ...entry.as === undefined
        ? {}
        : { as: oneOf(entry.as, `${at}.series[${index}].as`, ['bar', 'line'] as const) },
    }
  })
  return {
    chart: oneOf(value.chart, `${at}.chart`, CHART_KINDS),
    categories,
    series,
    showValues: value.showValues === true,
    stacked: value.stacked === true,
    textColor: color(value.textColor, `${at}.textColor`),
  }
}

/**
 * 校验一页幻灯片。
 * @param value - 候选页面。
 * @param at - 诊断里使用的位置描述。
 * @returns 归一化后的页面。
 */
export function parsePage(value: unknown, at: string): PptPage {
  if (!isRecord(value)) throw new PptModelError(`${at} 必须是对象`)
  if (!Array.isArray(value.elements)) throw new PptModelError(`${at}.elements 必须是数组`)
  if (value.elements.length > MAX_ELEMENTS) {
    throw new PptModelError(`${at}.elements 不能超过 ${MAX_ELEMENTS} 个元素`)
  }
  const ids = new Set<string>()
  const elements = value.elements.map((entry, index) => {
    const element = parseElement(entry, `${at}.elements[${index}]`)
    if (ids.has(element.id)) throw new PptModelError(`${at} 里元素 id "${element.id}" 重复`)
    ids.add(element.id)
    return element
  })
  return {
    id: text(value.id, `${at}.id`, 64),
    name: text(value.name, `${at}.name`, 200),
    background: value.background === null ? null : color(value.background, `${at}.background`),
    transition: oneOf(value.transition ?? 'none', `${at}.transition`, ['none', 'fade', 'push'] as const),
    elements,
  }
}

/**
 * 校验整份演示文稿；磁盘、HTTP 与工具入参都从这里进入模型。
 * @param value - 候选工程。
 * @returns 归一化后的工程。
 */
export function parseDeck(value: unknown): PptDeck {
  if (!isRecord(value)) throw new PptModelError('演示文稿必须是对象')
  if (value.format !== PPT_FORMAT) {
    throw new PptModelError(`演示文稿格式版本必须是 ${PPT_FORMAT}`)
  }
  if (!Array.isArray(value.pages) || value.pages.length === 0) {
    throw new PptModelError('演示文稿至少需要一页')
  }
  if (value.pages.length > MAX_PAGES) throw new PptModelError(`演示文稿不能超过 ${MAX_PAGES} 页`)
  const ids = new Set<string>()
  const pages = value.pages.map((entry, index) => {
    const page = parsePage(entry, `pages[${index}]`)
    if (ids.has(page.id)) throw new PptModelError(`页面 id "${page.id}" 重复`)
    ids.add(page.id)
    return page
  })
  return {
    format: PPT_FORMAT,
    title: text(value.title, 'title', 200),
    size: oneOf(value.size, 'size', ['16:9', '4:3'] as const),
    theme: oneOf(value.theme, 'theme', ['ink', 'paper', 'ocean', 'forest'] as const),
    pages,
  }
}

/**
 * 取画布基准尺寸。
 * @param deck - 演示文稿。
 * @returns 该尺寸下的宽高。
 */
export function slideSize(deck: PptDeck): SlideBaseSize {
  return SLIDE_SIZES[deck.size]
}

/**
 * 取主题配色。
 * @param deck - 演示文稿。
 * @returns 主题定义。
 */
export function themeOf(deck: PptDeck): PptTheme {
  return PPT_THEMES[deck.theme]
}

/**
 * 生成一个稳定的元素或页面 id。
 * @returns 32 位十六进制字符串。
 */
export function newId(): string {
  return globalThis.crypto.randomUUID().replace(/-/gu, '')
}

/**
 * 用主题默认值补全一个文本属性。
 * @param deck - 演示文稿，用于取主题色。
 * @param content - 文本内容。
 * @param size - 字号（基准像素）。
 * @returns 可直接写入元素的文本属性。
 */
export function defaultText(deck: PptDeck, content: string, size: number): PptText {
  return {
    content,
    size,
    color: themeOf(deck).text,
    bold: false,
    align: 'left',
    valign: 'top',
    font: '',
  }
}
