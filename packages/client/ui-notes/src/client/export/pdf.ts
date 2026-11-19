/**
 * PDF 导出：把正文按 A4 可打印区域切成连续若干页，逐页光栅化后用 PDF 库组装成文件直接下载，
 * 不弹打印对话框。页内文字随页面变成位图，因此中文字形不依赖额外字库，也不需要用户二次操作；
 * 代价是 PDF 里的文字不能选中搜索，需要可选中文本时导出 Markdown 或 Word。
 */
import { PDFDocument } from 'pdf-lib'
import { mountNoteDocument } from './document.tsx'
import { downloadBlob, noteFileName } from './files.ts'

/** A4 纸张宽度（pt，1pt = 1/72 英寸）。 */
const PAGE_WIDTH = 595.28
/** A4 纸张高度（pt）。 */
const PAGE_HEIGHT = 841.89
/** 页边距（pt）：20mm，与 Word 与图片导出的版心观感一致。 */
const PAGE_MARGIN = 56.69
/** 正文排版宽度（CSS 像素）：铺满页宽后文字大小与屏幕上一致。 */
const CONTENT_WIDTH = 760
/** 光栅化倍率：760px 铺满页宽后约 228 DPI，打印时文字边缘仍然清晰。 */
const PIXEL_RATIO = 2
/** 版心宽度（pt）。 */
const CONTENT_WIDTH_PT = PAGE_WIDTH - PAGE_MARGIN * 2
/** 版心高度（pt）。 */
const CONTENT_HEIGHT_PT = PAGE_HEIGHT - PAGE_MARGIN * 2
/** 1 CSS 像素换算成多少 pt。 */
const PT_PER_PX = CONTENT_WIDTH_PT / CONTENT_WIDTH
/** 每页可容纳的正文高度（CSS 像素）。 */
const PAGE_CONTENT_HEIGHT = Math.floor(CONTENT_HEIGHT_PT / PT_PER_PX)

/** 一页要截取的正文区间。 */
export interface NotePageSlice {
  /** 区间顶部偏移（CSS 像素）。 */
  top: number
  /** 区间高度（CSS 像素）。 */
  height: number
}

/**
 * 按块边界把正文切成页：整块放不下就另起一页，只有单块比一页还高时才在该块内部截断。
 * @param spans - 正文块的纵向区间，按文档顺序给出，单位 CSS 像素。
 * @param capacity - 每页可容纳的高度，默认取 A4 版心高度。
 * @returns 每页要截取的区间；正文为空时返回空数组。
 */
export function paginateNote(
  spans: readonly { top: number; bottom: number }[],
  capacity: number = PAGE_CONTENT_HEIGHT,
): NotePageSlice[] {
  const slices: NotePageSlice[] = []
  let top = spans[0]?.top ?? 0
  let bottom = top
  for (const span of spans) {
    // 这一块放不进当前页：先收掉当前页，再从这一块开头重新排。
    if (bottom > top && span.bottom - top > capacity) {
      slices.push({ top, height: bottom - top })
      top = span.top
    }
    bottom = span.bottom
    if (capacity <= 0) continue
    // 单块比一页还高（超长代码块、大表格）：在这一块内部按页高连续截断。
    while (bottom - top > capacity) {
      slices.push({ top, height: capacity })
      top += capacity
    }
  }
  if (bottom > top) slices.push({ top, height: bottom - top })
  return slices
}

/**
 * 把笔记排成 PDF。
 * @param title - 笔记标题，写入 PDF 元信息。
 * @param markdown - 笔记原文。
 * @returns PDF 内容；排版或光栅化失败时抛出。
 */
export async function notePdfBlob(title: string, markdown: string): Promise<Blob> {
  const note = mountNoteDocument(markdown, { width: CONTENT_WIDTH, padding: 0 })
  try {
    const slices = paginateNote(note.spans())
    // 量不到布局（正文为空或排版尚未完成）时仍输出一页，不让导出变成空文件。
    const pages = slices.length === 0 ? [{ top: 0, height: PAGE_CONTENT_HEIGHT }] : slices
    const pdf = await PDFDocument.create()
    pdf.setTitle(title)
    for (const page of pages) {
      const source = await note.capture({ top: page.top, height: page.height, pixelRatio: PIXEL_RATIO })
      const image = await pdf.embedPng(source)
      const height = page.height * PT_PER_PX
      // PDF 的原点在左下角：这一页从版心顶端向下排。
      pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]).drawImage(image, {
        x: PAGE_MARGIN,
        y: PAGE_HEIGHT - PAGE_MARGIN - height,
        width: CONTENT_WIDTH_PT,
        height,
      })
    }
    // 复制一份到普通 ArrayBuffer 视图，交给 Blob 时不带 SharedArrayBuffer 的可能。
    return new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' })
  } finally {
    note.dispose()
  }
}

/**
 * 导出当前笔记为 PDF。
 * @param title - 当前笔记标题。
 * @param markdown - 笔记原文。
 * @returns 下载完成后结束；生成失败时抛出供调用方提示。
 */
export async function exportPdf(title: string, markdown: string): Promise<void> {
  downloadBlob(await notePdfBlob(title, markdown), noteFileName(title, 'pdf'))
}
