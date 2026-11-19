/**
 * 导出共用的落地动作：文件名净化、浏览器下载，以及 Markdown 原文导出。
 * 三种排版导出各自生成 Blob，都由这里触发保存。
 */

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
 * 导出当前笔记为 Markdown 原文，不改写内容。
 * @param title - 当前笔记标题。
 * @param markdown - 笔记原文。
 * @returns 无返回值。
 */
export function exportMarkdown(title: string, markdown: string): void {
  downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), noteFileName(title, 'md'))
}
