/**
 * 把一页工程渲染成自包含 HTML：给宿主侧的浏览器截图通道用，也是「光栅化」的第一半。
 *
 * 这里不依赖 React 或客户端包，只把元素模型映射成定位与内联样式，尺寸就是基准像素
 * （16:9 = 1280×720，4:3 = 960×720），截图时视口设成同样的尺寸即可一比一落像素。
 * 图表画成内联 SVG，图片以内联 data URL 带入，因此产物只有一个文件、离线可渲染。
 * @module coding-ppt-workbench/render-html
 */

import {
  fontStack, PPT_THEMES, SLIDE_SIZES,
  type PptChartElement, type PptDeck, type PptElement, type PptPage,
} from 'coding-ppt-model'

/** 渲染需要的工程内图片字节。 */
export interface RenderMedia {
  readonly [source: string]: Uint8Array | undefined
}

/**
 * 元素字体的 CSS 值：默认黑体，缺字时退到 `fontStack` 里的中文黑体链。
 * 截图机器与用户机器装的黑体不同，所以这里只决定「尽量黑体」，不保证同一款字形。
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value)
}

function mediaTypeOf(source: string): string {
  const ext = source.split('.').pop()?.toLowerCase() ?? 'png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'svg') return 'image/svg+xml'
  return 'image/png'
}

function dataUrl(source: string, bytes: Uint8Array | undefined): string | null {
  if (bytes === undefined) return null
  return `data:${mediaTypeOf(source)};base64,${Buffer.from(bytes).toString('base64')}`
}

function alignOf(align: string): string {
  return align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start'
}

function valignOf(valign: string): string {
  return valign === 'middle' ? 'center' : valign === 'bottom' ? 'flex-end' : 'flex-start'
}

/**
 * 图表的 SVG 预览：柱、折线、饼。
 * @param element - 图表元素。
 * @param width - 宽度（基准像素）。
 * @param height - 高度（基准像素）。
 * @returns SVG 字符串。
 */
export function chartSvg(element: PptChartElement, width: number, height: number): string {
  const pad = 16
  const parts: string[] = []
  if (element.chart === 'pie') {
    const values = (element.series[0]?.values ?? []).map(value => Math.max(value, 0))
    const total = values.reduce((sum, value) => sum + value, 0) || 1
    const radius = Math.min(width, height) / 2 - pad
    const cx = width / 2
    const cy = height / 2
    let angle = -Math.PI / 2
    values.forEach((value, index) => {
      const sweep = value / total * Math.PI * 2
      const x1 = cx + radius * Math.cos(angle)
      const y1 = cy + radius * Math.sin(angle)
      const x2 = cx + radius * Math.cos(angle + sweep)
      const y2 = cy + radius * Math.sin(angle + sweep)
      const large = sweep > Math.PI ? 1 : 0
      parts.push(`<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} `
        + `A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" `
        + `fill="${escapeAttr(element.series[0]?.color ?? '#4f8cff')}" opacity="${(0.55 + index * 0.15).toFixed(2)}"/>`)
      angle += sweep
    })
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
  }
  const max = Math.max(...element.series.flatMap(series => series.values), 1)
  const plotHeight = height - pad * 2
  const plotWidth = width - pad * 2
  const slot = plotWidth / Math.max(element.categories.length, 1)
  element.series.forEach((series, seriesIndex) => {
    series.values.forEach((value, index) => {
      const barWidth = Math.max(2, slot / (element.series.length + 1))
      const x = pad + slot * index + barWidth * seriesIndex + barWidth / 2
      const barHeight = Math.max(0, value / max * plotHeight)
      if (element.chart === 'line' || series.as === 'line') return
      parts.push(`<rect x="${(x - barWidth / 2).toFixed(2)}" y="${(pad + plotHeight - barHeight).toFixed(2)}" `
        + `width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" fill="${escapeAttr(series.color)}"/>`)
    })
  })
  element.series.forEach((series) => {
    if (element.chart !== 'line' && series.as !== 'line') return
    const points = series.values.map((value, index) => {
      const x = pad + slot * index + slot / 2
      const y = pad + plotHeight - Math.max(0, value / max * plotHeight)
      return `${x.toFixed(2)},${y.toFixed(2)}`
    }).join(' ')
    parts.push(`<polyline points="${points}" fill="none" stroke="${escapeAttr(series.color)}" stroke-width="3"/>`)
  })
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
}

function elementHtml(element: PptElement, media: RenderMedia): string {
  const box = `left:${element.x}px;top:${element.y}px;width:${element.w}px;height:${element.h}px;`
  if (element.kind === 'line') {
    const length = Math.hypot(element.w, element.h)
    const angle = Math.atan2(element.h, element.w) * (180 / Math.PI)
    return `<div style="position:absolute;${box}transform:rotate(${angle}deg);transform-origin:0 50%;`
      + `background:${element.color};height:${element.width}px;width:${length}px"></div>`
  }
  if (element.kind === 'text') {
    const style = `position:absolute;${box}display:flex;flex-direction:column;`
      + `justify-content:${valignOf(element.text.valign)};align-items:${alignOf(element.text.align)};`
      + `font-family:${escapeAttr(fontStack(element.text.font))};font-size:${element.text.size}px;`
      + `line-height:1.25;color:${element.text.color};font-weight:${element.text.bold ? 700 : 400};`
      + `text-align:${element.text.align};white-space:pre-wrap;word-break:break-word;`
    return `<div style="${style}">${escapeHtml(element.text.content)}</div>`
  }
  if (element.kind === 'image') {
    const url = dataUrl(element.source, media[element.source])
    if (url === null) {
      return `<div style="position:absolute;${box}background:#333;opacity:.4"></div>`
    }
    return `<div style="position:absolute;${box}overflow:hidden">`
      + `<img src="${url}" style="width:100%;height:100%;object-fit:${element.fit}" alt=""/></div>`
  }
  if (element.kind === 'table') {
    const total = element.columnWeights.reduce((sum, weight) => sum + weight, 0)
    const columns = element.columnWeights.map(weight => `${weight / total}fr`).join(' ')
    const rows = element.cells.map((row, rowIndex) => row.map(cell => (
      '<div style="display:flex;align-items:center;padding:0 8px;overflow:hidden;'
      + `border-right:1px solid ${element.borderColor};border-bottom:1px solid ${element.borderColor};`
      + `justify-content:${alignOf(element.text.align)};`
      + `background:${element.header && rowIndex === 0 ? element.headerFill : 'transparent'}">`
      + `${escapeHtml(cell.content)}</div>`
    )).join('')).join('')
    return `<div style="position:absolute;${box}display:grid;grid-template-columns:${columns};`
      + `grid-template-rows:repeat(${element.rows},1fr);border:1px solid ${element.borderColor};`
      + `font-family:${escapeAttr(fontStack(element.text.font))};font-size:${element.text.size}px;`
      + `color:${element.text.color};font-weight:${element.text.bold ? 700 : 400}">${rows}</div>`
  }
  if (element.kind === 'chart') {
    return `<div style="position:absolute;${box}">${chartSvg(element, element.w, element.h)}</div>`
  }
  const radius = element.kind === 'ellipse' ? 'border-radius:50%;' : ''
  return `<div style="position:absolute;${box}background:${element.fill};${radius}"></div>`
}

/**
 * 渲染一页为自包含 HTML。
 * @param deck - 演示文稿（取主题与画布尺寸）。
 * @param page - 页面。
 * @param media - 工程内图片字节，键为 `media/<file>`。
 * @returns 完整 HTML 文本。
 */
export function renderPageHtml(deck: PptDeck, page: PptPage, media: RenderMedia = {}): string {
  const size = SLIDE_SIZES[deck.size]
  const palette = PPT_THEMES[deck.theme]
  const background = page.background ?? palette.background
  const elements = page.elements.map(element => elementHtml(element, media)).join('')
  return '<!doctype html><html><head><meta charset="utf-8"/>'
    + `<style>html,body{margin:0;padding:0;width:${size.width}px;height:${size.height}px;`
    + `background:${background};-webkit-font-smoothing:antialiased}`
    + '*{box-sizing:border-box}</style></head>'
    + `<body><div style="position:relative;width:${size.width}px;height:${size.height}px;`
    + `background:${background}">${elements}</div></body></html>`
}
