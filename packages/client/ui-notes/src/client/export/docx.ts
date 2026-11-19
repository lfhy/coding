/**
 * Word 导出：把整理后的正文交给 `docx` 自带的 HTML 转换器（`docx/html`），
 * 标题、段落、嵌套列表、任务列表、引用、代码块、表格、链接与公式都落到 Word 自己的样式上。
 * 正文字体来自文档默认样式（中文黑体、西文 SimHei），不跟随应用主题；
 * 内联图片直接嵌入，其余图片保留替代文字。
 */
import { Document, Packer } from 'docx'
import { htmlToContent } from 'docx/html'
import { DOCX_FONT, DOCX_STYLESHEET, prepareNoteHtml } from './document.tsx'
import { downloadBlob, noteFileName } from './files.ts'

/** 正文样式：字号用半磅，22 即 11pt；行距 340 是行高 1.7 换算后的固定值。 */
const NOTE_STYLES = {
  default: {
    document: {
      run: { font: DOCX_FONT, size: 22 },
      paragraph: { spacing: { line: 340 } },
    },
    // 标题除了拿内置样式，还显式给字号和加粗，避免打开方忽略样式表时退回正文大小。
    heading1: { run: { font: DOCX_FONT, size: 39, bold: true } },
    heading2: { run: { font: DOCX_FONT, size: 33, bold: true } },
    heading3: { run: { font: DOCX_FONT, size: 27, bold: true } },
    heading4: { run: { font: DOCX_FONT, size: 24, bold: true } },
    heading5: { run: { font: DOCX_FONT, size: 24, bold: true } },
    heading6: { run: { font: DOCX_FONT, size: 24, bold: true } },
  },
} as const

/**
 * 把渲染好的笔记正文转成 docx 文档。
 * @param title - 文档标题，写入文件元信息。
 * @param markdown - 笔记原文。
 * @returns 生成 docx 的 Promise；打包失败时拒绝。
 */
export async function noteDocxBlob(title: string, markdown: string): Promise<Blob> {
  const children = htmlToContent(prepareNoteHtml(markdown, 'docx'), { stylesheet: DOCX_STYLESHEET })
  return await Packer.toBlob(new Document({
    title,
    styles: NOTE_STYLES,
    sections: [{ children: [...children] }],
  }))
}

/**
 * 导出当前笔记为 Word 文档（`.docx`）。
 * @param title - 当前笔记标题。
 * @param markdown - 笔记原文。
 * @returns 下载完成后结束；生成失败时抛出供调用方提示。
 */
export async function exportWord(title: string, markdown: string): Promise<void> {
  downloadBlob(await noteDocxBlob(title, markdown), noteFileName(title, 'docx'))
}
