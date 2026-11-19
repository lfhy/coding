/**
 * 图片导出：把预览同一套排版整页画成 PNG，白底黑体，不跟随应用主题。
 * 位图由 html-to-image 生成，引用远程图片时受同源策略限制。
 */
import { toPng } from 'html-to-image'
import { mountNoteDocument } from './document.tsx'
import { downloadBlob, noteFileName } from './files.ts'

/** 图片导出的排版宽度（CSS 像素）。 */
const IMAGE_WIDTH = 900
/** 位图倍率：整页画成两倍像素，放大查看时文字不发虚。 */
const PIXEL_RATIO = 2
/** 正文四周留白，让导出图不贴边。 */
const IMAGE_PADDING = 32

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
  /* v8 ignore next -- `toPng` 的产物恒为 `data:image/png;...`，这里只防御被裁剪的运行时。 */
  const type = /data:([^;,]+)/u.exec(meta)?.[1] ?? 'image/png'
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type })
}

/**
 * 导出当前笔记为整页 PNG。
 * @param title - 当前笔记标题。
 * @param markdown - 笔记原文。
 * @returns 下载完成后结束；渲染失败时抛出供调用方提示。
 */
export async function exportImage(title: string, markdown: string): Promise<void> {
  const note = mountNoteDocument(markdown, { width: IMAGE_WIDTH, padding: IMAGE_PADDING })
  try {
    const dataUrl = await toPng(note.host, {
      width: IMAGE_WIDTH,
      backgroundColor: '#ffffff',
      pixelRatio: PIXEL_RATIO,
    })
    downloadBlob(dataUrlToBlob(dataUrl), noteFileName(title, 'png'))
  } finally {
    note.dispose()
  }
}
