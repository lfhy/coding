// @vitest-environment jsdom
/** 笔记导出：文件名、下载、文档组装与四种导出动作的接线。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  downloadBlob, exportImage, exportMarkdown, exportPdf, exportWord, noteDocumentHtml, noteDocxBlob,
  noteFileName, renderNoteBody,
} from '../src/client/export.tsx'

// 位图编码依赖真实浏览器排版；这里只验证接线与失败传播。
const rasterize = vi.hoisted(() => ({ toPng: vi.fn(async (): Promise<string> => 'data:image/png;base64,iVBORw0KGgo=') }))
vi.mock('html-to-image', () => rasterize)

/** 捕获本次下载的 Blob 与文件名；返回释放调用以便断言。 */
function captureDownload(): { blobs: Blob[]; names: string[]; clicks: number; revoked: string[] } {
  const captured = { blobs: [] as Blob[], names: [] as string[], clicks: 0, revoked: [] as string[] }
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn((blob: Blob) => {
      captured.blobs.push(blob)
      return `blob:note-${captured.blobs.length}`
    }),
    revokeObjectURL: vi.fn((url: string) => { captured.revoked.push(url) }),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    captured.clicks += 1
    captured.names.push(this.download)
  })
  return captured
}

afterEach(() => {
  // 打印框架由 afterprint 或超时收掉；清掉可能残留的那个，避免串到下一个用例。
  document.querySelectorAll('iframe').forEach((frame) => { frame.remove() })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rasterize.toPng.mockImplementation(async () => 'data:image/png;base64,iVBORw0KGgo=')
})

describe('export helpers', () => {
  it('生成安全文件名：替换保留字符、去掉尾部点号、空标题回退', () => {
    expect(noteFileName('周报/2026:Q4*?', 'md')).toBe('周报-2026-Q4--.md')
    expect(noteFileName('  计划…  ', 'docx')).toBe('计划….docx')
    expect(noteFileName('...', 'md')).toBe('note.md')
    expect(noteFileName('a'.repeat(200), 'png')).toHaveLength(124)
  })

  it('下载 Blob 后异步释放对象 URL', async () => {
    vi.useFakeTimers()
    const captured = captureDownload()
    downloadBlob(new Blob(['x']), 'note.md')
    expect(captured.clicks).toBe(1)
    expect(captured.names).toEqual(['note.md'])
    expect(document.querySelector('a[download]')).toBeNull()
    expect(captured.revoked).toEqual([])
    vi.advanceTimersByTime(0)
    expect(captured.revoked).toEqual(['blob:note-1'])
    vi.useRealTimers()
  })

  it('导出文档带上转义后的标题与固定样式，字体是黑体', () => {
    const html = noteDocumentHtml('周报 & <Q4> "草稿" \'x\'', '<p>正文</p>')
    expect(html).toContain('<title>周报 &amp; &lt;Q4&gt; &quot;草稿&quot; &#39;x&#39;</title>')
    expect(html).toContain('<article class="note"><p>正文</p></article>')
    expect(html).toContain('@page { size: A4; margin: 20mm; }')
    expect(html).toContain('"SimHei", "黑体"')
  })

  it('用预览同一套渲染把 Markdown 转成 HTML', () => {
    const body = renderNoteBody('# 标题\n\n一段正文')
    expect(body).toContain('<h1')
    expect(body).toContain('一段正文')
  })
})

describe('note exports', () => {
  it('导出 Markdown 原文，文件名取自标题', () => {
    const captured = captureDownload()
    exportMarkdown('周报', '# 周报\n')
    expect(captured.names).toEqual(['周报.md'])
  })

  it('导出 Word 生成真正的 docx：压缩包以 PK 开头并带正文', async () => {
    const blob = await noteDocxBlob('周报', '<h1>周报</h1><p>正文</p><ul><li>条目</li></ul>'
      + '<ol><li>第一步</li></ol><blockquote><p>引用</p></blockquote><pre><code>code</code></pre>'
      + '<table><tr><th>列</th></tr><tr><td>值</td></tr></table><hr><img alt="图"><p><strong>粗</strong>'
      + '<em>斜</em><code>内联</code><a href="https://example.com">链接</a><br></p>')
    const head = new Uint8Array(await blob.arrayBuffer()).slice(0, 2)
    expect([...head]).toEqual([0x50, 0x4b])
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })

  it('docx 转换覆盖任务列表、空链接与空单元格', async () => {
    const blob = await noteDocxBlob('边界', '<p><input type="checkbox">完成</p>'
      + '<p><a href="https://example.com"></a><a>无地址</a></p>'
      + '<table><tr><td></td></tr></table><ul><li>外层<ul><li>内层</li></ul></li></ul>')
    expect((await blob.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  it('docx 转换覆盖 figure 与缺少替代文字的图片', async () => {
    const blob = await noteDocxBlob('图', '<figure><img alt="示意"><img alt=""></figure>')
    expect((await blob.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  it('导出 Word 触发下载并带上 .docx 后缀', async () => {
    const captured = captureDownload()
    await exportWord('周报', '# 周报')
    expect(captured.names).toEqual(['周报.docx'])
  })

  it('导出 PDF 写入隐藏框架打印，结束打印后移除框架', () => {
    captureDownload()
    exportPdf('周报', '# 周报')
    const frame = document.querySelector<HTMLIFrameElement>('iframe')
    expect(frame).not.toBeNull()
    expect(frame?.contentDocument?.title).toBe('周报')
    expect(frame?.contentDocument?.querySelector('article.note h1')?.textContent).toBe('周报')
    frame?.contentWindow?.dispatchEvent(new Event('afterprint'))
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('导出图片编码成 PNG 并下载', async () => {
    const captured = captureDownload()
    await exportImage('周报', '# 周报')
    await vi.waitFor(() => { expect(captured.names).toEqual(['周报.png']) })
    expect(rasterize.toPng).toHaveBeenCalledOnce()
    expect(document.querySelector('.note')).toBeNull()
  })

  it('图片渲染失败时抛出，交给页面提示', async () => {
    captureDownload()
    rasterize.toPng.mockImplementationOnce(async () => { throw new Error('note image render failed') })
    await expect(exportImage('周报', '# 周报')).rejects.toThrow(/note image render failed/u)
  })
})
