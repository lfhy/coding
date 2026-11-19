/**
 * 笔记导出的对外入口：页面只依赖这里的四种格式与对应动作。
 * Markdown 直接存原文；Word、PDF、图片各自生成真正的文件并触发下载。
 */
export { exportMarkdown } from './files.ts'
export { exportWord } from './docx.ts'
export { exportPdf } from './pdf.ts'
export { exportImage } from './image.ts'

/** 可导出的目标格式。 */
export type NoteExportFormat = 'markdown' | 'word' | 'pdf' | 'image'
