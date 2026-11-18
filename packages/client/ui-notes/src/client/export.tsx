/**
 * 笔记导出：Markdown 原文、Word 文档（.docx）、打印成 PDF、以及整页 PNG。
 *
 * 正文复用预览同一套 Markdown 渲染，避免第二份排版实现；导出文档统一用黑体，
 * 不跟随应用主题。PDF 交给浏览器打印对话框（文本可选中、中文无需额外字库）；
 * PNG 由 html-to-image 把渲染好的预览画成位图，引用远程图片时受同源策略限制。
 */
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import {
  AlignmentType, Document, ExternalHyperlink, HeadingLevel, LevelFormat, Packer, Paragraph, Table, TableCell,
  TableRow, TextRun, WidthType,
} from 'docx'
import { toPng } from 'html-to-image'
import { MarkdownText } from 'coding-client-ui-primitives'

/** 可导出的目标格式。 */
export type NoteExportFormat = 'markdown' | 'word' | 'pdf' | 'image'

/** 图片导出的排版宽度（CSS 像素）。 */
const IMAGE_WIDTH = 900

/** 导出文档统一使用的字体：黑体优先，缺失时退回常见中文字体。 */
const EXPORT_FONT = '"SimHei", "黑体", "Heiti SC", "Microsoft YaHei", "PingFang SC", sans-serif'
/** 代码块与行内代码的等宽字体。 */
const CODE_FONT = 'Consolas, "SFMono-Regular", Menlo, monospace'

/** 导出文档的固定样式；白底深字，不读取应用主题。 */
const EXPORT_CSS = `
body { margin: 0; background: #ffffff; color: #1f2328; font-family: ${EXPORT_FONT}; font-size: 15px; line-height: 1.7; }
.note { box-sizing: border-box; max-width: 760px; margin: 0 auto; padding: 32px; }
.note h1, .note h2, .note h3, .note h4, .note h5, .note h6 { margin: 1.4em 0 0.6em; font-family: ${EXPORT_FONT}; line-height: 1.3; }
.note h1 { font-size: 26px; } .note h2 { font-size: 22px; } .note h3 { font-size: 18px; }
.note h4, .note h5, .note h6 { font-size: 16px; }
.note p { margin: 0.8em 0; }
.note ul, .note ol { margin: 0.8em 0; padding-left: 1.4em; }
.note li { margin: 0.3em 0; }
.note code { padding: 0.15em 0.35em; border-radius: 4px; background: #f1f3f5; font-family: ${CODE_FONT}; font-size: 0.9em; }
.note pre { margin: 0.9em 0; padding: 12px 14px; border-radius: 8px; background: #f6f8fa; overflow: auto; }
.note pre code { padding: 0; background: none; }
.note blockquote { margin: 0.9em 0; padding: 0.2em 0 0.2em 1em; border-left: 3px solid #d0d7de; color: #57606a; }
.note table { width: 100%; margin: 0.9em 0; border-collapse: collapse; }
.note th, .note td { padding: 6px 10px; border: 1px solid #d0d7de; text-align: left; }
.note img { max-width: 100%; }
.note a { color: #0969da; }
.note hr { margin: 1.6em 0; border: 0; border-top: 1px solid #d0d7de; }
.note input[type="checkbox"] { margin-right: 6px; }
`

/**
 * 生成安全的导出文件名：去掉路径与保留字符，空标题回退到 `note`。
 * @param title - 当前笔记标题（不含扩展名）。
 * @param extension - 目标扩展名，不含点。
 * @returns 可直接交给下载的文件名。
 */
export function noteFileName(title: string, extension: string): string {
  const base = title.trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-')
    .replace(/[.\s]+$/u, '')
    .slice(0, 120)
  return `${base === '' ? 'note' : base}.${extension}`
}

/**
 * 触发浏览器下载；对象 URL 在点击后异步释放，避免部分浏览器读不到内容。
 * @param blob - 要保存的内容。
 * @param filename - 建议的文件名。
 * @returns 无返回值。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

/**
 * 用预览同一套渲染把 Markdown 转成静态 HTML。
 * @param markdown - 笔记原文。
 * @returns 渲染后的 HTML 片段。
 */
export function renderNoteBody(markdown: string): string {
  const host = document.createElement('div')
  const root = createRoot(host)
  // 同步渲染后立刻读 innerHTML：导出的结构与用户在预览里看到的完全一致。
  flushSync(() => { root.render(<MarkdownText text={markdown} />) })
  const html = host.innerHTML
  root.unmount()
  return html
}

/**
 * 组装打印用文档；Word 与图片各自有专门的生成器。
 * @param title - 文档标题，用于 `<title>`。
 * @param body - 已渲染的正文 HTML。
 * @returns 独立的 HTML 文档文本。
 */
export function noteDocumentHtml(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}
@page { size: A4; margin: 20mm; }
</style>
</head>
<body><article class="note">${body}</article></body>
</html>`
}

/** 转义需要放进 HTML 文本节点的内容。 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (token) => {
    switch (token) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

/**
 * 导出当前笔记为 Markdown 原文。
 * @param title - 当前笔记标题。
 * @param markdown - 笔记原文。
 * @returns 无返回值。
 */
export function exportMarkdown(title: string, markdown: string): void {
  downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), noteFileName(title, 'md'))
}

/** 内联片段的样式，供 HTML 到 docx 的转换累积。 */
interface RunStyle {
  bold?: boolean
  italics?: boolean
  code?: boolean
}

/**
 * 把行内节点转成 docx 文本片段；链接保留可见文字，地址写进超链接关系。
 * @param node - 行内 DOM 节点。
 * @param style - 已继承的样式。
 * @returns docx 段落片段。
 */
function inlineRuns(node: Node, style: RunStyle = {}): (TextRun | ExternalHyperlink)[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? ''
    /* v8 ignore next -- 浏览器不为空文本保留文本节点；防御解析器注入的空节点。 */
    return text === '' ? [] : [new TextRun({
      text,
      ...(style.bold === true ? { bold: true } : {}),
      ...(style.italics === true ? { italics: true } : {}),
      font: style.code === true ? CODE_FONT : EXPORT_FONT,
    })]
  }
  if (!(node instanceof Element)) return []
  const tag = node.tagName.toLowerCase()
  if (tag === 'br') return [new TextRun({ text: '', break: 1 })]
  if (tag === 'input') return []
  const next: RunStyle = {
    ...style,
    ...(tag === 'strong' || tag === 'b' ? { bold: true } : {}),
    ...(tag === 'em' || tag === 'i' ? { italics: true } : {}),
    ...(tag === 'code' ? { code: true } : {}),
  }
  const children = Array.from(node.childNodes).flatMap(child => inlineRuns(child, next))
  if (tag !== 'a') return children
  const href = node.getAttribute('href') ?? ''
  if (href === '') return children
  const label = node.textContent.trim()
  return [new ExternalHyperlink({
    link: href,
    children: [new TextRun({ text: label === '' ? href : label, style: 'Hyperlink' })],
  })]
}

/** 表格单元格内的纯文本：合并空白，保留可读的一行。 */
function plainText(element: Element): string {
  return element.textContent.replace(/\s+/gu, ' ').trim()
}

/** 单个标题级别到 docx 标题的映射。 */
const HEADINGS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
] as const

/**
 * 把一段 HTML 转成 docx 块级元素。
 * @param element - 由预览渲染产出的块级元素。
 * @returns docx 段落或表格列表。
 */
function blockOf(element: Element): (Paragraph | Table)[] {
  const tag = element.tagName.toLowerCase()
  const heading = /^h([1-6])$/u.exec(tag)
  if (heading !== null) {
    return [new Paragraph({
      heading: HEADINGS[Number(heading[1]) - 1] ?? HeadingLevel.HEADING_6,
      children: inlineRuns(element),
    })]
  }
  if (tag === 'ul' || tag === 'ol') {
    const ordered = tag === 'ol'
    return Array.from(element.children).flatMap(item => Array.from(item.childNodes).flatMap((child) => {
      const childTag = child instanceof Element ? child.tagName.toLowerCase() : ''
      // 嵌套列表按外层条目文本处理，避免把子项压成同一层级。
      if (childTag === 'ul' || childTag === 'ol') return []
      return [new Paragraph({
        children: inlineRuns(child),
        ...(ordered
          ? { numbering: { reference: 'note-ordered', level: 0 } }
          : { bullet: { level: 0 } }),
      })]
    }))
  }
  if (tag === 'blockquote') {
    return [new Paragraph({
      children: Array.from(element.children).flatMap(child => inlineRuns(child)),
      indent: { left: 480 },
    })]
  }
  if (tag === 'pre') {
    return [new Paragraph({
      children: [new TextRun({ text: element.textContent, font: CODE_FONT, size: 20 })],
      shading: { fill: 'F6F8FA' },
      indent: { left: 240, right: 240 },
    })]
  }
  if (tag === 'table') {
    return [new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: Array.from(element.querySelectorAll('tr')).map(row => new TableRow({
        children: Array.from(row.children).map(cell => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: plainText(cell), font: EXPORT_FONT })] })],
        })),
      })),
    })]
  }
  if (tag === 'hr') return [new Paragraph({ children: [] })]
  if (tag === 'img') {
    const alt = element.getAttribute('alt') ?? ''
    return alt === '' ? [] : [new Paragraph({ children: [new TextRun({ text: `[图片] ${alt}`, font: EXPORT_FONT })] })]
  }
  if (tag === 'figure') {
    return Array.from(element.children).flatMap(child => blockOf(child))
  }
  return [new Paragraph({ children: inlineRuns(element) })]
}

/**
 * 把渲染好的 HTML 转成 docx 文档。
 * @param title - 文档标题，写入文件元信息。
 * @param body - 已渲染的正文 HTML。
 * @returns 生成 docx 的 Promise；打包失败时拒绝。
 */
export async function noteDocxBlob(title: string, body: string): Promise<Blob> {
  const parsed = new DOMParser().parseFromString(body, 'text/html')
  const blocks = Array.from(parsed.body.children).flatMap(child => blockOf(child))
  return await Packer.toBlob(new Document({
    title,
    styles: {
      default: {
        document: {
          run: { font: EXPORT_FONT, size: 22 },
          paragraph: { spacing: { line: 320 } },
        },
        heading1: { run: { font: EXPORT_FONT, size: 36, bold: true } },
        heading2: { run: { font: EXPORT_FONT, size: 30, bold: true } },
        heading3: { run: { font: EXPORT_FONT, size: 26, bold: true } },
        heading4: { run: { font: EXPORT_FONT, size: 24, bold: true } },
        heading5: { run: { font: EXPORT_FONT, size: 22, bold: true } },
        heading6: { run: { font: EXPORT_FONT, size: 22, bold: true } },
      },
    },
    numbering: {
      config: [{
        reference: 'note-ordered',
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START }],
      }],
    },
    sections: [{ children: blocks }],
  }))
}

/**
 * 导出当前笔记为 Word 文档（`.docx`），正文统一使用黑体。
 * @param title - 当前笔记标题。
 * @param markdown - 笔记原文。
 * @returns 下载完成后结束；生成失败时抛出。
 */
export async function exportWord(title: string, markdown: string): Promise<void> {
  const blob = await noteDocxBlob(title, renderNoteBody(markdown))
  downloadBlob(blob, noteFileName(title, 'docx'))
}

/**
 * 导出当前笔记为 PDF：交给隐藏框架打印，由浏览器对话框另存为 PDF。
 * @param title - 当前笔记标题。
 * @param markdown - 笔记原文。
 * @returns 无返回值。
 */
export function exportPdf(title: string, markdown: string): void {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('tabindex', '-1')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.append(frame)
  const win = frame.contentWindow
  const doc = frame.contentDocument
  /* v8 ignore next -- 同源框架一定有 window 与 document；防御被隔离的文档。 */
  if (win === null || doc === null) {
    frame.remove()
    return
  }
  doc.open()
  /* oxlint-disable-next-line typescript/no-deprecated -- 隐藏框架只能靠 document.write 写入整份文档。 */
  doc.write(noteDocumentHtml(title, renderNoteBody(markdown)))
  doc.close()
  const remove = () => { frame.remove() }
  win.addEventListener('afterprint', remove, { once: true })
  // 少数环境不派发 afterprint；留一个兜底，避免框架常驻文档。
  window.setTimeout(remove, 60_000)
  win.focus()
  /* v8 ignore next 2 -- 同源框架的 window 总有 print；这里只防御被裁剪的嵌入式运行时。 */
  if (typeof win.print === 'function') win.print()
  else remove()
}

/**
 * 把 data URL 解成 Blob，避免再走一次 fetch 与对象 URL。
 * @param dataUrl - `toPng` 返回的 data URL。
 * @returns 对应媒体类型的二进制内容。
 */
function dataUrlToBlob(dataUrl: string): Blob {
  // 输入来自 toPng，必定是 `data:<mime>;base64,<payload>`。
  const comma = dataUrl.indexOf(',')
  const meta = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  const type = /data:([^;,]+)/u.exec(meta)?.[1] ?? 'image/png'
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type })
}

/**
 * 把笔记渲染成 PNG：挂载一份预览节点交给 html-to-image，再下载结果。
 * @param markdown - 笔记原文。
 * @returns PNG 内容。
 */
async function renderNotePng(markdown: string): Promise<Blob> {
  const host = document.createElement('div')
  host.className = 'note'
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${IMAGE_WIDTH}px;background:#ffffff;font-family:${EXPORT_FONT}`
  const style = document.createElement('style')
  style.textContent = EXPORT_CSS
  const root = createRoot(host)
  document.head.append(style)
  document.body.append(host)
  try {
    flushSync(() => { root.render(<MarkdownText text={markdown} />) })
    const dataUrl = await toPng(host, {
      width: IMAGE_WIDTH,
      backgroundColor: '#ffffff',
      pixelRatio: 2,
      style: { fontFamily: EXPORT_FONT },
    })
    return dataUrlToBlob(dataUrl)
  } finally {
    root.unmount()
    host.remove()
    style.remove()
  }
}

/**
 * 导出当前笔记为整页 PNG。
 * @param title - 当前笔记标题。
 * @param markdown - 笔记原文。
 * @returns 下载完成后结束；渲染失败时抛出供调用方提示。
 */
export async function exportImage(title: string, markdown: string): Promise<void> {
  const blob = await renderNotePng(markdown)
  downloadBlob(blob, noteFileName(title, 'png'))
}
