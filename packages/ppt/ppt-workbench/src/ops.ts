/**
 * 编辑操作：模型工具与面板都通过同一条 ops 数组修改工程，一次调用要么整体生效、
 * 要么整体拒绝（先校验后应用），因此不会留下半改的页面。
 * @module coding-ppt-workbench/ops
 */

import { buildTemplate, PPT_TEMPLATES, templateName, type PptTemplateId } from './templates.ts'
import { patchElement } from './element-patch.ts'
import {
  bounded, color, defaultText, fontFamily, isRecord, mediaPath, newId, parseDeck, parseElement, PPT_THEMES,
  PptModelError,
  type ElementAnimation, type ElementFrame, type PptChartSeries, type PptDeck,
  type PptElement, type PptPage, type PptText, type SlideTransition, type ThemeId,
} from 'coding-ppt-model'

/** 新建一页；给出 `template` 时按版式模板铺好元素。 */
export interface AddPageOp {
  readonly op: 'add_page'
  /** 插入位置（0 起）；缺省追加到末尾。 */
  readonly at?: number
  readonly name?: string
  readonly background?: string | null
  /** 版式模板：title / section / bullets / two-column / data / chart / quote。 */
  readonly template?: PptTemplateId
  /** 模板填充用的主标题。 */
  readonly title?: string
  /** 要点页/双栏页的条目（最多 6 条）。 */
  readonly bullets?: readonly string[]
}

/** 删除一页；不允许删到零页。 */
export interface RemovePageOp {
  readonly op: 'remove_page'
  readonly page: string
}

/** 调整页序。 */
export interface MovePageOp {
  readonly op: 'move_page'
  readonly page: string
  /** 目标位置（0 起）。 */
  readonly to: number
}

/** 改页面名称、底色或转场。 */
export interface UpdatePageOp {
  readonly op: 'update_page'
  readonly page: string
  readonly name?: string
  readonly background?: string | null
  readonly transition?: SlideTransition
}

/** 新增元素；`element.id` 缺省时自动生成。 */
export interface AddElementOp {
  readonly op: 'add_element'
  readonly page: string
  readonly element: Record<string, unknown>
}

/** 修改元素位置、尺寸或内容；只提交给出的字段。 */
export interface UpdateElementOp {
  readonly op: 'update_element'
  readonly page: string
  readonly element: string
  readonly frame?: Partial<ElementFrame>
  readonly text?: Partial<PptText>
  readonly fill?: string
  readonly color?: string
  readonly width?: number
  /** 图片：换图（工程内 media 相对路径）。 */
  readonly source?: string
  readonly fit?: 'cover' | 'contain'
  /** 表格：整表内容替换，维度需与 rows × columns 一致。 */
  readonly cells?: readonly (readonly { readonly content: string }[])[]
  /** 图表：替换分类与系列。 */
  readonly chart?: { readonly categories: readonly string[]; readonly series: readonly PptChartSeries[] }
  /** 入场动画。 */
  readonly animation?: ElementAnimation
  /** 强调动画。 */
  readonly emphasis?: 'none' | 'pulse' | 'grow'
  /** 退场动画。 */
  readonly exitAnimation?: ElementAnimation
  /** 路径动画。 */
  readonly pathAnimation?: 'none' | 'right' | 'left' | 'up' | 'down'
  /** 图表是否堆叠。 */
  readonly stacked?: boolean
}

/** 元素层级调整。 */
export interface ReorderElementOp {
  readonly op: 'reorder_element'
  readonly page: string
  readonly element: string
  readonly to: 'front' | 'back' | 'forward' | 'backward'
}

/** 复制元素（同页、错开 24px）。 */
export interface DuplicateElementOp {
  readonly op: 'duplicate_element'
  readonly page: string
  readonly element: string
}

/** 删除元素。 */
export interface RemoveElementOp {
  readonly op: 'remove_element'
  readonly page: string
  readonly element: string
}

/** 用图片替换图片或矩形占位框；可同时移除覆盖在框上的占位文字，保留原 id、层级与几何。 */
export interface ReplaceImageOp {
  readonly op: 'replace_image'
  readonly page: string
  readonly element: string
  readonly source: string
  readonly fit?: 'cover' | 'contain'
  readonly label?: string
}

/** 改标题、画布尺寸或主题。 */
export interface UpdateDeckOp {
  readonly op: 'update_deck'
  readonly title?: string
  readonly size?: '16:9' | '4:3'
  readonly theme?: ThemeId
}

/** 一次编辑的任意一步。 */
export type PptOp =
  | AddPageOp | RemovePageOp | MovePageOp | UpdatePageOp
  | AddElementOp | UpdateElementOp | RemoveElementOp | ReplaceImageOp
  | ReorderElementOp | DuplicateElementOp | UpdateDeckOp

const OP_NAMES = [
  'add_page', 'remove_page', 'move_page', 'update_page',
  'add_element', 'update_element', 'remove_element', 'replace_image',
  'reorder_element', 'duplicate_element', 'update_deck',
] as const
const TRANSITIONS = ['none', 'fade', 'push'] as const
const REORDER_TARGETS = ['front', 'back', 'forward', 'backward'] as const

const ALIGNMENTS = ['left', 'center', 'right'] as const
const MOTIONS = ['none', 'fade', 'fly', 'zoom', 'wipe'] as const
const EMPHASIS = ['none', 'pulse', 'grow'] as const
const PATHS = ['none', 'right', 'left', 'up', 'down'] as const
const TEMPLATE_IDS: readonly PptTemplateId[] = PPT_TEMPLATES.map(entry => entry.id)
const VALIGNMENTS = ['top', 'middle', 'bottom'] as const
const THEMES = ['ink', 'paper', 'ocean', 'forest', 'inference'] as const
const SIZES = ['16:9', '4:3'] as const

function pick<T extends string>(allowed: readonly T[], value: unknown, at: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new PptModelError(`${at} 必须是 ${allowed.join(' / ')} 之一`)
  }
  return value as T
}

function shortText(value: unknown, at: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new PptModelError(`${at} 必须是 1 到 ${max} 个字符的字符串`)
  }
  return value
}

function optionalColor(value: unknown, at: string): string | null {
  return value === null ? null : color(value, at)
}

function parseChartPatch(value: unknown, at: string): { categories: readonly string[]; series: readonly PptChartSeries[] } {
  if (!isRecord(value)) throw new PptModelError(`${at} 必须是对象`)
  if (!Array.isArray(value.categories) || value.categories.length === 0) {
    throw new PptModelError(`${at}.categories 必须是非空数组`)
  }
  const categories = value.categories.map((entry, index) => shortText(entry, `${at}.categories[${index}]`, 120))
  if (!Array.isArray(value.series) || value.series.length === 0) {
    throw new PptModelError(`${at}.series 必须是非空数组`)
  }
  const series = value.series.map((entry, index) => {
    if (!isRecord(entry)) throw new PptModelError(`${at}.series[${index}] 必须是对象`)
    if (!Array.isArray(entry.values) || entry.values.length !== categories.length) {
      throw new PptModelError(`${at}.series[${index}].values 长度必须等于分类数`)
    }
    return {
      name: shortText(entry.name, `${at}.series[${index}].name`, 120),
      values: entry.values.map((item, valueIndex) => bounded(item, `${at}.series[${index}].values[${valueIndex}]`, -1e9, 1e9)),
      color: color(entry.color, `${at}.series[${index}].color`),
    }
  })
  return { categories, series }
}

function parseBullets(value: unknown, at: string): string[] {
  if (!Array.isArray(value)) throw new PptModelError(`${at} 必须是数组`)
  if (value.length > 6) throw new PptModelError(`${at} 最多 6 条`)
  return value.map((entry, index) => shortText(entry, `${at}[${index}]`, 500))
}

function parseCells(value: unknown, at: string): readonly (readonly { readonly content: string }[])[] {
  if (!Array.isArray(value) || value.length === 0) throw new PptModelError(`${at} 必须是非空数组`)
  return value.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length === 0) throw new PptModelError(`${at}[${rowIndex}] 必须是非空数组`)
    return row.map((cell, columnIndex) => {
      if (!isRecord(cell)) throw new PptModelError(`${at}[${rowIndex}][${columnIndex}] 必须是对象`)
      const content: unknown = cell.content
      if (typeof content !== 'string' || content.length > 5000) {
        throw new PptModelError(`${at}[${rowIndex}][${columnIndex}].content 必须是不超过 5000 个字符的字符串`)
      }
      return { content }
    })
  })
}

function parseFrame(value: unknown, at: string): Partial<ElementFrame> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new PptModelError(`${at} 必须是对象`)
  return {
    ...value.x === undefined ? {} : { x: bounded(value.x, `${at}.x`, -100_000, 100_000) },
    ...value.y === undefined ? {} : { y: bounded(value.y, `${at}.y`, -100_000, 100_000) },
    ...value.w === undefined ? {} : { w: bounded(value.w, `${at}.w`, 0, 100_000) },
    ...value.h === undefined ? {} : { h: bounded(value.h, `${at}.h`, 0, 100_000) },
  }
}

function parseTextPatch(value: unknown, at: string): Partial<PptText> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new PptModelError(`${at} 必须是对象`)
  return {
    ...value.content === undefined ? {} : { content: shortText(value.content, `${at}.content`, 5000) },
    ...value.size === undefined ? {} : { size: bounded(value.size, `${at}.size`, 6, 400) },
    ...value.color === undefined ? {} : { color: color(value.color, `${at}.color`) },
    ...value.bold === undefined ? {} : { bold: value.bold === true },
    ...value.align === undefined ? {} : { align: pick(ALIGNMENTS, value.align, `${at}.align`) },
    ...value.valign === undefined ? {} : { valign: pick(VALIGNMENTS, value.valign, `${at}.valign`) },
    ...value.font === undefined ? {} : { font: fontFamily(value.font, `${at}.font`) },
  }
}

function parseOp(value: unknown, at: string): PptOp {
  if (!isRecord(value)) throw new PptModelError(`${at} 必须是对象`)
  const op = pick(OP_NAMES, value.op, `${at}.op`)
  switch (op) {
    case 'add_page':
      return {
        op,
        ...value.at === undefined ? {} : { at: bounded(value.at, `${at}.at`, 0, 199) },
        ...value.name === undefined ? {} : { name: shortText(value.name, `${at}.name`, 200) },
        ...value.background === undefined
          ? {}
          : { background: optionalColor(value.background, `${at}.background`) },
        ...value.template === undefined
          ? {}
          : { template: pick(TEMPLATE_IDS, value.template, `${at}.template`) },
        ...value.title === undefined ? {} : { title: shortText(value.title, `${at}.title`, 200) },
        ...value.bullets === undefined ? {} : { bullets: parseBullets(value.bullets, `${at}.bullets`) },
      }
    case 'remove_page':
      return { op, page: shortText(value.page, `${at}.page`, 64) }
    case 'move_page':
      return {
        op,
        page: shortText(value.page, `${at}.page`, 64),
        to: bounded(value.to, `${at}.to`, 0, 199),
      }
    case 'update_page':
      return {
        op,
        page: shortText(value.page, `${at}.page`, 64),
        ...value.name === undefined ? {} : { name: shortText(value.name, `${at}.name`, 200) },
        ...value.background === undefined
          ? {}
          : { background: optionalColor(value.background, `${at}.background`) },
        ...value.transition === undefined
          ? {}
          : { transition: pick(TRANSITIONS, value.transition, `${at}.transition`) },
      }
    case 'add_element':
      if (!isRecord(value.element)) throw new PptModelError(`${at}.element 必须是对象`)
      return { op, page: shortText(value.page, `${at}.page`, 64), element: { ...value.element } }
    case 'update_element': {
      const frame = parseFrame(value.frame, `${at}.frame`)
      const text = parseTextPatch(value.text, `${at}.text`)
      return {
        op,
        page: shortText(value.page, `${at}.page`, 64),
        element: shortText(value.element, `${at}.element`, 64),
        ...frame === undefined ? {} : { frame },
        ...text === undefined ? {} : { text },
        ...value.fill === undefined ? {} : { fill: color(value.fill, `${at}.fill`) },
        ...value.color === undefined ? {} : { color: color(value.color, `${at}.color`) },
        ...value.width === undefined ? {} : { width: bounded(value.width, `${at}.width`, 0.5, 40) },
        ...value.source === undefined ? {} : { source: mediaPath(value.source, `${at}.source`) },
        ...value.fit === undefined ? {} : { fit: pick(['cover', 'contain'] as const, value.fit, `${at}.fit`) },
        ...value.cells === undefined ? {} : { cells: parseCells(value.cells, `${at}.cells`) },
        ...value.animation === undefined
          ? {}
          : { animation: pick(MOTIONS, value.animation, `${at}.animation`) },
        ...value.emphasis === undefined
          ? {}
          : { emphasis: pick(EMPHASIS, value.emphasis, `${at}.emphasis`) },
        ...value.exitAnimation === undefined
          ? {}
          : { exitAnimation: pick(MOTIONS, value.exitAnimation, `${at}.exitAnimation`) },
        ...value.pathAnimation === undefined
          ? {}
          : { pathAnimation: pick(PATHS, value.pathAnimation, `${at}.pathAnimation`) },
        ...value.chart === undefined ? {} : { chart: parseChartPatch(value.chart, `${at}.chart`) },
        ...value.stacked === undefined ? {} : { stacked: value.stacked === true },
      }
    }
    case 'remove_element':
    case 'duplicate_element':
      // 两个 op 只认页面与元素 id，参数形状一致。
      return {
        op,
        page: shortText(value.page, `${at}.page`, 64),
        element: shortText(value.element, `${at}.element`, 64),
      }
    case 'replace_image':
      return {
        op, page: shortText(value.page, `${at}.page`, 64),
        element: shortText(value.element, `${at}.element`, 64),
        source: mediaPath(value.source, `${at}.source`),
        ...value.fit === undefined ? {} : { fit: pick(['cover', 'contain'] as const, value.fit, `${at}.fit`) },
        ...value.label === undefined ? {} : { label: shortText(value.label, `${at}.label`, 64) },
      }
    case 'reorder_element':
      return {
        op,
        page: shortText(value.page, `${at}.page`, 64),
        element: shortText(value.element, `${at}.element`, 64),
        to: pick(REORDER_TARGETS, value.to, `${at}.to`),
      }
    case 'update_deck':
      return {
        op,
        ...value.title === undefined ? {} : { title: shortText(value.title, `${at}.title`, 200) },
        ...value.size === undefined ? {} : { size: pick(SIZES, value.size, `${at}.size`) },
        ...value.theme === undefined ? {} : { theme: pick(THEMES, value.theme, `${at}.theme`) },
      }
  }
}

/**
 * 校验一次编辑请求的 ops；兼容单层 JSON 编码的数组字符串，仍拒绝其他值。
 * @param value - 来自工具参数或 HTTP 请求体的值。
 * @returns 通过校验的 ops 数组。
 * @throws PptModelError - 结构不合法或编码超限时拒绝整次编辑。
 */
export function parseOps(value: unknown): PptOp[] {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) throw new PptModelError('ops 字符串不能超过 1 MiB')
    try {
      value = JSON.parse(value) as unknown
    } catch {
      throw new PptModelError('ops 字符串必须是合法的 JSON 数组')
    }
  }
  if (!Array.isArray(value) || value.length === 0) throw new PptModelError('ops 必须是非空数组')
  if (value.length > 100) throw new PptModelError('ops 一次最多 100 步')
  return value.map((entry, index) => parseOp(entry, `ops[${index}]`))
}

function findPage(pages: readonly PptPage[], pageId: string): number {
  const at = pages.findIndex(page => page.id === pageId)
  if (at < 0) throw new PptModelError(`找不到页面 "${pageId}"`)
  return at
}

/** 取已存在的页面；`findPage` 已经确认过下标，这里只把可空性收掉。 */
function pageAt(pages: readonly PptPage[], at: number): PptPage {
  const page = pages[at]
  if (page === undefined) throw new PptModelError(`页面下标 ${at} 越界`)
  return page
}

function replacePage(pages: readonly PptPage[], at: number, page: PptPage): PptPage[] {
  return pages.map((entry, index) => index === at ? page : entry)
}

/** 补全缺省 id 与各类默认值后校验新元素。 */
function normalizeElement(raw: Record<string, unknown>, deck: PptDeck): PptElement {
  const source: Record<string, unknown> = { ...raw }
  if (source.id === undefined) source.id = newId()
  const palette = PPT_THEMES[deck.theme]
  if (source.kind === 'table') {
    const rows = typeof source.rows === 'number' ? source.rows : 3
    const columns = typeof source.columns === 'number' ? source.columns : 3
    source.rows = rows
    source.columns = columns
    source.columnWeights = source.columnWeights ?? Array.from({ length: columns }, () => 1)
    source.header = source.header ?? true
    source.headerFill = source.headerFill ?? palette.accent
    source.borderColor = source.borderColor ?? palette.muted
    source.text = {
      size: 24, color: palette.text, bold: false, align: 'left', font: '',
      ...isRecord(source.text) ? source.text : {},
    }
    source.cells = source.cells ?? Array.from({ length: rows }, () => Array.from({ length: columns }, () => ({ content: '' })))
  }
  if (source.kind === 'chart') {
    source.chart = source.chart ?? 'bar'
    source.categories = source.categories ?? ['一季度', '二季度', '三季度', '四季度']
    source.series = source.series ?? [{ name: '系列 1', values: [1, 2, 3, 4], color: palette.accent }]
    source.showValues = source.showValues ?? false
    source.stacked = source.stacked ?? false
    source.textColor = source.textColor ?? palette.muted
  }
  if (source.kind === 'image') {
    if (source.source === undefined) throw new PptModelError('图片元素必须提供 source')
    source.fit = source.fit ?? 'cover'
  }
  if (source.kind === 'text') {
    if (!isRecord(source.text)) throw new PptModelError('文本元素必须提供 text 对象')
    const patch = defaultText(deck, '', 32)
    const given = source.text
    source.text = {
      ...patch,
      ...given,
      ...given.content === undefined ? { content: '' } : {},
    }
  }
  return parseElement(source, 'element')
}

/**
 * 把一次编辑应用到工程上。
 * @param deck - 当前工程（不会被修改）。
 * @param ops - 已校验的编辑步骤。
 * @returns 新工程与本次改动涉及的页面／元素 id。
 * @throws PptModelError - 任一步引用了不存在的页面或元素时整体失败。
 */
export function applyOps(deck: PptDeck, ops: readonly PptOp[]): { deck: PptDeck; touched: string[] } {
  let pages: PptPage[] = [...deck.pages]
  let meta = { title: deck.title, size: deck.size, theme: deck.theme }
  const touched: string[] = []
  for (const op of ops) {
    switch (op.op) {
      case 'add_page': {
        const at = op.at ?? pages.length
        if (at > pages.length) throw new PptModelError(`add_page 的 at 超出页数（当前 ${pages.length} 页）`)
        const elements = op.template === undefined
          ? []
          : buildTemplate(op.template, deck, {
            ...op.title === undefined ? {} : { title: op.title },
            ...op.bullets === undefined ? {} : { bullets: op.bullets },
          })
        const page: PptPage = {
          id: newId(),
          name: op.name ?? (op.template === undefined ? `第 ${at + 1} 页` : templateName(op.template)),
          background: op.background ?? null,
          transition: 'none',
          elements,
        }
        pages = [...pages.slice(0, at), page, ...pages.slice(at)]
        touched.push(page.id)
        break
      }
      case 'remove_page': {
        if (pages.length === 1) throw new PptModelError('不能删除最后一页')
        const at = findPage(pages, op.page)
        pages = [...pages.slice(0, at), ...pages.slice(at + 1)]
        touched.push(op.page)
        break
      }
      case 'move_page': {
        const at = findPage(pages, op.page)
        if (op.to >= pages.length) throw new PptModelError(`move_page 的 to 超出页数（当前 ${pages.length} 页）`)
        const moved = pageAt(pages, at)
        const rest = [...pages.slice(0, at), ...pages.slice(at + 1)]
        pages = [...rest.slice(0, op.to), moved, ...rest.slice(op.to)]
        touched.push(op.page)
        break
      }
      case 'update_page': {
        const at = findPage(pages, op.page)
        const current = pageAt(pages, at)
        pages = replacePage(pages, at, {
          ...current,
          ...op.name === undefined ? {} : { name: op.name },
          ...op.background === undefined ? {} : { background: op.background },
          ...op.transition === undefined ? {} : { transition: op.transition },
        })
        touched.push(op.page)
        break
      }
      case 'add_element': {
        const at = findPage(pages, op.page)
        const page = pageAt(pages, at)
        if (page.elements.length >= 200) throw new PptModelError('一页最多 200 个元素')
        const element = normalizeElement(op.element, deck)
        if (page.elements.some(entry => entry.id === element.id)) {
          throw new PptModelError(`页面里已有元素 "${element.id}"`)
        }
        pages = replacePage(pages, at, { ...page, elements: [...page.elements, element] })
        touched.push(element.id)
        break
      }
      case 'update_element': {
        const at = findPage(pages, op.page)
        const page = pageAt(pages, at)
        const elementAt = page.elements.findIndex(entry => entry.id === op.element)
        if (elementAt < 0) throw new PptModelError(`页面 "${page.id}" 里没有元素 "${op.element}"`)
        const elements = page.elements.map((item, index) => index === elementAt ? patchElement(item, op) : item)
        pages = replacePage(pages, at, { ...page, elements })
        touched.push(op.element)
        break
      }
      case 'remove_element': {
        const at = findPage(pages, op.page)
        const page = pageAt(pages, at)
        if (!page.elements.some(entry => entry.id === op.element)) {
          throw new PptModelError(`页面 "${page.id}" 里没有元素 "${op.element}"`)
        }
        pages = replacePage(pages, at, { ...page, elements: page.elements.filter(item => item.id !== op.element) })
        touched.push(op.element)
        break
      }
      case 'replace_image': {
        const at = findPage(pages, op.page)
        const page = pageAt(pages, at)
        const source = page.elements.find(entry => entry.id === op.element)
        if (source === undefined) throw new PptModelError(`页面 "${page.id}" 里没有元素 "${op.element}"`)
        if (source.kind !== 'image' && source.kind !== 'rect') {
          throw new PptModelError('只能替换图片或矩形占位框')
        }
        // 只移除紧贴目标且完全重合的单个覆盖文字；其他设计元素不作猜测。
        const sourceIndex = page.elements.indexOf(source)
        const candidate = page.elements[sourceIndex + 1]
        const label = op.label === undefined ? undefined : candidate?.id === op.label && candidate.kind === 'text'
          && candidate.x === source.x && candidate.y === source.y
          && candidate.w === source.w && candidate.h === source.h ? candidate : undefined
        if (op.label !== undefined && label === undefined) throw new PptModelError('占位文字未与图片框相邻且重合')
        const image: PptElement = parseElement({
          id: source.id, kind: 'image', x: source.x, y: source.y, w: source.w, h: source.h,
          source: op.source, fit: op.fit ?? (source.kind === 'image' ? source.fit : 'cover'),
          ...source.animation === undefined ? {} : { animation: source.animation },
          ...source.emphasis === undefined ? {} : { emphasis: source.emphasis },
          ...source.exitAnimation === undefined ? {} : { exitAnimation: source.exitAnimation },
          ...source.pathAnimation === undefined ? {} : { pathAnimation: source.pathAnimation },
        }, 'element')
        const elements = page.elements.filter(entry => entry.id !== label?.id)
          .map(entry => entry.id === source.id ? image : entry)
        pages = replacePage(pages, at, { ...page, elements })
        touched.push(source.id)
        if (label !== undefined) touched.push(label.id)
        break
      }
      case 'reorder_element': {
        const at = findPage(pages, op.page)
        const page = pageAt(pages, at)
        const current = page.elements.findIndex(entry => entry.id === op.element)
        if (current < 0) throw new PptModelError(`页面 "${page.id}" 里没有元素 "${op.element}"`)
        const target = op.to === 'front' ? page.elements.length - 1
          : op.to === 'back' ? 0
            : Math.min(Math.max(current + (op.to === 'forward' ? 1 : -1), 0), page.elements.length - 1)
        const rest = page.elements.filter((_, index) => index !== current)
        const moved = page.elements[current]
        if (moved === undefined) throw new PptModelError(`页面 "${page.id}" 里没有元素 "${op.element}"`)
        const elements = [...rest.slice(0, target), moved, ...rest.slice(target)]
        pages = replacePage(pages, at, { ...page, elements })
        touched.push(op.element)
        break
      }
      case 'duplicate_element': {
        const at = findPage(pages, op.page)
        const page = pageAt(pages, at)
        const source = page.elements.find(entry => entry.id === op.element)
        if (source === undefined) throw new PptModelError(`页面 "${page.id}" 里没有元素 "${op.element}"`)
        if (page.elements.length >= 200) throw new PptModelError('一页最多 200 个元素')
        const copy: PptElement = { ...source, id: newId(), x: source.x + 24, y: source.y + 24 }
        pages = replacePage(pages, at, { ...page, elements: [...page.elements, copy] })
        touched.push(copy.id)
        break
      }
      case 'update_deck':
        meta = {
          title: op.title ?? meta.title,
          size: op.size ?? meta.size,
          theme: op.theme ?? meta.theme,
        }
        break
    }
  }
  return { deck: parseDeck({ ...meta, format: 1, pages }), touched }
}
