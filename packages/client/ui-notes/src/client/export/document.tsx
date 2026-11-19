/**
 * 导出共用的正文渲染与样式：复用预览同一套 Markdown 渲染（`MarkdownText`），
 * Word、PDF 与图片因此不会各自排版一遍。导出前按目标格式整理 DOM——去掉复制按钮、
 * 代码块横幅与高亮主题色这类只在界面里成立的样式；Word 里另把远程图片换成替代文字、
 * 去掉 KaTeX 的重复可见层，只留可转成公式的 MathML。导出文档固定白底黑体，不读取应用主题。
 */
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { toPng } from 'html-to-image'
import { MarkdownText } from 'coding-client-ui-primitives'

/** 导出目标：`docx` 走文档转换，`raster` 走浏览器排版后光栅化。 */
export type NoteExportMode = 'docx' | 'raster'

/** 浏览器排版的字体栈：黑体优先，缺失时退回常见中文字体。 */
const SCREEN_FONT = '"SimHei", "黑体", "Heiti SC", "Microsoft YaHei", "PingFang SC", sans-serif'
/** 浏览器排版的等宽字体栈，用于代码块与行内代码。 */
const SCREEN_CODE_FONT = 'Consolas, "SFMono-Regular", Menlo, monospace'
/** Word 文档字体：中文字符走黑体，西文与符号用同一字体的西文名。 */
export const DOCX_FONT = {
  ascii: 'SimHei', eastAsia: '黑体', hAnsi: 'SimHei', cs: 'SimHei',
} as const
/** Word 里非内联图片留下的替代文字前缀。 */
const IMAGE_PLACEHOLDER = '[图片]'

/** 正文规则：选择器相对正文根，生成样式表时按目标补作用域前缀；`true` 表示这条也写正文字体。 */
const NOTE_RULES: readonly (readonly [string, string, boolean?])[] = [
  ['h1, h2, h3, h4, h5, h6', 'margin: 1.4em 0 0.6em; line-height: 1.3', true],
  ['h1', 'font-size: 26px'],
  ['h2', 'font-size: 22px'],
  ['h3', 'font-size: 18px'],
  ['h4, h5, h6', 'font-size: 16px'],
  ['p', 'margin: 0.8em 0'],
  ['ul, ol', 'margin: 0.8em 0; padding-left: 1.4em'],
  ['li', 'margin: 0.3em 0'],
  ['code', 'padding: 0.15em 0.35em; border-radius: 4px; background: #f1f3f5; font-size: 0.9em'],
  ['pre', 'margin: 0.9em 0; padding: 12px 14px; border-radius: 8px; background: #f6f8fa; overflow: auto'],
  ['pre code', 'padding: 0; background: none; font-size: 13px'],
  ['blockquote', 'margin: 0.9em 0; padding: 0.2em 0 0.2em 1em; border-left: 3px solid #d0d7de; color: #57606a'],
  ['table', 'width: 100%; margin: 0.9em 0; border-collapse: collapse'],
  ['th, td', 'padding: 6px 10px; border: 1px solid #d0d7de; text-align: left'],
  ['th', 'background: #f2f4f7; font-weight: 600'],
  ['img', 'max-width: 100%'],
  ['a', 'color: #0969da'],
  ['hr', 'margin: 1.6em 0; border: 0; border-top: 1px solid #d0d7de'],
  ['input[type="checkbox"]', 'margin-right: 6px'],
]

/**
 * 生成导出样式表。
 * @param options - `scope` 是选择器前缀：浏览器排版用 `.note ` 把规则关在导出正文里，
 * Word 转换器作用于片段本身，用空前缀；`body` 为 `null` 时不写正文字体，
 * 交给 Word 的文档默认样式，避免把字体栈当成单一字体名写进 OOXML。
 * @returns 可直接放进 `<style>` 或交给 HTML 转换器的 CSS 文本。
 */
function exportCss(options: { scope: string; body: string | null; code: string }): string {
  const font = options.body === null ? '' : `font-family: ${options.body}; `
  const rules = NOTE_RULES.map(([selectors, declarations, heading]) => {
    const scoped = selectors.split(',').map(selector => `${options.scope}${selector.trim()}`).join(', ')
    // 代码字体由谁排版决定：浏览器用等宽字体栈，Word 只认单一字体名。
    const code = selectors === 'code' ? `font-family: ${options.code}; ` : ''
    return `${scoped} { ${heading === true ? font : ''}${code}${declarations} }`
  })
  const root = options.scope === '' ? '' : `${options.scope.trim()} { box-sizing: border-box; }\n`
  return `body { margin: 0; background: #ffffff; color: #1f2328; ${font}font-size: 15px; line-height: 1.7; }\n`
    + `${root}${rules.join('\n')}\n`
}

/** PDF 与 PNG 用的样式：只作用在导出正文节点内，不影响页面其余部分。 */
const SCREEN_STYLES = exportCss({ scope: '.note ', body: SCREEN_FONT, code: SCREEN_CODE_FONT })
/** Word 用的样式：只描述字号、颜色、边框与背景，正文字体来自文档默认样式。 */
export const DOCX_STYLESHEET = exportCss({ scope: '', body: null, code: 'Consolas' })

/**
 * 用预览同一套渲染把 Markdown 转成静态 HTML。
 * @param markdown - 笔记原文。
 * @returns 渲染后的 HTML 片段，尚未整理。
 */
function renderMarkdown(markdown: string): string {
  const host = document.createElement('div')
  const root = createRoot(host)
  // 同步渲染后立刻读 innerHTML：导出的结构与用户在预览里看到的完全一致。
  flushSync(() => { root.render(<MarkdownText text={markdown} />) })
  const markup = host.innerHTML
  root.unmount()
  return markup
}

/**
 * 整理导出用的正文：去掉只在界面里成立的控件，代码块只保留代码本体。
 * @param markup - 预览渲染出来的 HTML。
 * @param mode - `docx` 额外处理 Word 无法直接使用的元素。
 * @returns 整理后的 HTML。
 */
function tidyMarkup(markup: string, mode: NoteExportMode): string {
  const host = document.createElement('div')
  host.innerHTML = markup
  for (const block of host.querySelectorAll('.md-code-block')) {
    const pre = block.querySelector('pre')
    /* v8 ignore next 3 -- 代码块渲染始终带 `<pre>`；这里只防御被裁剪的渲染结果。 */
    if (pre === null) {
      block.remove()
      continue
    }
    // 高亮颜色来自应用主题；导出固定白底深字，去掉行内样式后代码只剩正文色。
    for (const styled of [pre, ...pre.querySelectorAll('[style]')]) styled.removeAttribute('style')
    // 横幅与复制按钮是界面控件，导出只留 `<pre>` 里的代码。
    block.replaceWith(pre)
  }
  for (const node of host.querySelectorAll('button, svg, script, style, link')) node.remove()
  if (mode === 'docx') {
    // KaTeX 同时输出 MathML 与可见排版；Word 只读前者，重复的可见层会变成两份公式。
    for (const node of host.querySelectorAll('[aria-hidden="true"]')) node.remove()
    // 预览只把远程图片画成 `<img>`；Word 不联网取图，这里换成替代文字。
    for (const image of host.querySelectorAll<HTMLImageElement>('img')) {
      const alt = image.alt.trim()
      image.replaceWith(document.createTextNode(alt === '' ? IMAGE_PLACEHOLDER : `${IMAGE_PLACEHOLDER} ${alt}`))
    }
  }
  return host.innerHTML
}

/**
 * 生成 Word 转换器要吃的正文 HTML。
 * @param markdown - 笔记原文。
 * @param mode - 导出目标。
 * @returns 整理后的 HTML 片段。
 */
export function prepareNoteHtml(markdown: string, mode: NoteExportMode): string {
  return tidyMarkup(renderMarkdown(markdown), mode)
}

/** 一段要光栅化的正文区间，坐标相对正文顶部，单位 CSS 像素。 */
export interface NoteCapture {
  /** 区间顶部偏移。 */
  top: number
  /** 区间高度。 */
  height: number
  /** 位图倍率，2 表示按两倍像素渲染。 */
  pixelRatio: number
}

/** 挂载在文档里的导出正文。 */
export interface NoteDocument {
  /** 正文根节点（`.note`）；调用方可以直接读取它的测量值或整块光栅化。 */
  readonly host: HTMLElement
  /** 正文顶层块的纵向区间，坐标相对正文顶部，单位 CSS 像素。 */
  spans(): { top: number; bottom: number }[]
  /**
   * 截取正文的一段并光栅化成 PNG data URL。
   * @param capture - 要截取的区间与倍率。
   * @returns PNG data URL。
   */
  capture(capture: NoteCapture): Promise<string>
  /** 卸载正文与导出样式表。 */
  dispose(): void
}

/** 可以继续向下找正文块的容器标签；`pre`、`table` 这类本身就是一整块的标签到此为止。 */
const FLOW_CONTAINERS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'FIGURE', 'FORM'])

/**
 * 找到正文真正的块级层：预览会在最外层再包一层样式容器，跳过它才能按块分页。
 * @param host - 正文根节点。
 * @returns 直接持有正文块的元素；正文为空时返回最外层。
 */
function flowOf(host: HTMLElement): HTMLElement {
  let current = host
  for (;;) {
    const only = current.children.item(0)
    if (current.children.length !== 1 || only === null || !FLOW_CONTAINERS.has(only.tagName)) return current
    current = only as HTMLElement
  }
}

/** 正文块在文档里的纵向区间；`heading` 表示标题块，分页时不能与后面的正文拆开。 */
export interface NoteSpan {
  /** 块顶部偏移（CSS 像素）。 */
  top: number
  /** 下一块开始的位置；块间空白算进本块。 */
  bottom: number
  /** 该块是否为标题。 */
  heading: boolean
}

/**
 * 把标题与它后面的一块合成一段：标题不会独自留在页尾，正文也不会与标题分离。
 * @param spans - 按文档顺序排列的正文块，已去掉零高度块。
 * @param end - 正文结束位置，用于最后一块是标题的场合。
 * @returns 合并后的区间。
 */
export function mergeHeadingSpans(spans: readonly NoteSpan[], end: number): { top: number; bottom: number }[] {
  const merged: { top: number; bottom: number }[] = []
  let pending: number | null = null
  for (const span of spans) {
    const top: number = pending ?? span.top
    if (span.heading) {
      pending = top
      continue
    }
    merged.push({ top, bottom: span.bottom })
    pending = null
  }
  if (pending !== null) merged.push({ top: pending, bottom: end })
  return merged
}

/**
 * 判断是否为标题块；`tagName` 在 HTML 里是大写，必须忽略大小写比较。
 * @param block - 正文顶层块。
 * @returns 是否为 `h1`–`h6`。
 */
export function isHeadingBlock(block: Element): boolean {
  return /^h[1-6]$/iu.test(block.tagName)
}

/**
 * 量出正文顶层块的纵向区间；块之间的空白算进上一块，因此相邻区间首尾相接。
 * @param host - 挂载中的正文根节点。
 * @returns 按文档顺序排列、已去掉零高度块并合并了标题的区间。
 */
function noteSpans(host: HTMLElement): { top: number; bottom: number }[] {
  const flow = flowOf(host)
  const end = flow.offsetTop + flow.offsetHeight
  const blocks = [...flow.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
  const spans = blocks
    .map((block, index) => ({
      top: block.offsetTop,
      bottom: blocks[index + 1]?.offsetTop ?? end,
      heading: isHeadingBlock(block),
    }))
    .filter(span => span.bottom > span.top)
  return mergeHeadingSpans(spans, end)
}

/**
 * 把笔记渲染成挂在文档里、位于视口外的白底正文，供需要真实排版的 PDF 与 PNG 导出使用。
 * 节点放在视口左侧之外，调用方不能假设它可见或可交互。
 * @param markdown - 笔记原文。
 * @param options - 排版宽度与内边距（CSS 像素）。
 * @returns 正文句柄；用完必须 `dispose`，否则样式表与节点会留在页面里。
 */
export function mountNoteDocument(
  markdown: string,
  options: { width: number; padding: number },
): NoteDocument {
  const styles = document.createElement('style')
  styles.textContent = SCREEN_STYLES
  const frame = document.createElement('div')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none'
  const host = document.createElement('div')
  host.className = 'note'
  host.style.cssText = `width:${options.width}px;padding:${options.padding}px;background:#ffffff`
  host.innerHTML = prepareNoteHtml(markdown, 'raster')
  frame.append(host)
  document.head.append(styles)
  document.body.append(frame)
  return {
    host,
    spans: () => noteSpans(host),
    capture: async (capture) => {
      const clipper = document.createElement('div')
      clipper.setAttribute('aria-hidden', 'true')
      // 裁切框不能自己带负偏移：位图按节点自身的位置渲染，负偏移会让整页取到空白。
      clipper.style.cssText = `position:relative;width:${options.width}px;`
        + `height:${capture.height}px;overflow:hidden;background:#ffffff`
      // 上移正文后用固定高度的视口裁切：每页拿到的是同一份排版的连续切片，翻页不改行距。
      host.style.marginTop = `${-capture.top}px`
      clipper.append(host)
      frame.append(clipper)
      try {
        return await toPng(clipper, { pixelRatio: capture.pixelRatio, backgroundColor: '#ffffff' })
      } finally {
        clipper.remove()
        host.style.marginTop = ''
        frame.append(host)
      }
    },
    dispose: () => {
      frame.remove()
      styles.remove()
    },
  }
}
