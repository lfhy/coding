// @vitest-environment jsdom
/** 笔记导出：文件落地、导出前整理、Word 文档结构、PDF 分页与组装、图片导出。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { isHeadingBlock, mergeHeadingSpans, prepareNoteHtml } from '../src/client/export/document.tsx'
import { exportWord, noteDocxBlob } from '../src/client/export/docx.ts'
import { exportPdf, notePdfBlob, paginateNote } from '../src/client/export/pdf.ts'
import { exportImage } from '../src/client/export/image.ts'
import { downloadBlob, exportMarkdown, noteFileName } from '../src/client/export/files.ts'

interface PdfDraw { x: number; y: number; width: number; height: number }

// 位图编码与 PDF 组装依赖真实浏览器排版与文件格式；这里只验证接线与产物结构。
const rasterize = vi.hoisted(() => ({ toPng: vi.fn(async (): Promise<string> => 'data:image/png;base64,iVBORw0KGgo=') }))
vi.mock('html-to-image', () => rasterize)

const pdfStub = vi.hoisted(() => ({
  titles: [] as string[],
  images: [] as string[],
  sizes: [] as number[][],
  draws: [] as PdfDraw[][],
}))
vi.mock('pdf-lib', () => ({
  PDFDocument: {
    create: async () => {
      const draws: PdfDraw[] = []
      pdfStub.draws.push(draws)
      return {
        setTitle: (title: string) => { pdfStub.titles.push(title) },
        embedPng: async (image: string) => {
          pdfStub.images.push(image)
          return { image }
        },
        addPage: (size: number[]) => {
          pdfStub.sizes.push(size)
          return { drawImage: (_image: unknown, draw: PdfDraw) => { draws.push(draw) } }
        },
        save: async () => new TextEncoder().encode('%PDF-1.7'),
      }
    },
  },
}))

/** 捕获本次下载的 Blob 与文件名；返回释放调用以便断言。 */
function captureDownload(): { blobs: Blob[]; names: string[]; revoked: string[] } {
  const captured = { blobs: [] as Blob[], names: [] as string[], revoked: [] as string[] }
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn((blob: Blob) => {
      captured.blobs.push(blob)
      return `blob:note-${captured.blobs.length}`
    }),
    revokeObjectURL: vi.fn((url: string) => { captured.revoked.push(url) }),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    captured.names.push(this.download)
  })
  return captured
}

/** 解开 docx 压缩包取出正文；断言写论文档结构，而不是字节长度。 */
async function docxXml(blob: Blob, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  const file = zip.file(path)
  if (file === null) throw new Error(`docx 缺少 ${path}`)
  return await file.async('string')
}

// jsdom 不做排版：需要多页场景时临时把元素高度顶成指定值。
let originalOffsetHeight: PropertyDescriptor | undefined
function stubOffsetHeight(height: number): void {
  originalOffsetHeight ??= Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => height })
}

afterEach(() => {
  if (originalOffsetHeight !== undefined) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
    originalOffsetHeight = undefined
  }
  pdfStub.titles.length = 0
  pdfStub.images.length = 0
  pdfStub.sizes.length = 0
  pdfStub.draws.length = 0
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rasterize.toPng.mockReset()
  rasterize.toPng.mockImplementation(async () => 'data:image/png;base64,iVBORw0KGgo=')
})

describe('导出文件落地', () => {
  it('生成安全文件名：替换保留字符、去掉尾部点号、空标题回退', () => {
    expect(noteFileName('周报/2026:Q4*?', 'md')).toBe('周报-2026-Q4--.md')
    expect(noteFileName('  计划…  ', 'docx')).toBe('计划….docx')
    expect(noteFileName('...', 'md')).toBe('note.md')
    expect(noteFileName('a'.repeat(200), 'png')).toHaveLength(124)
  })

  it('下载 Blob 后异步释放对象 URL', () => {
    vi.useFakeTimers()
    const captured = captureDownload()
    downloadBlob(new Blob(['x']), 'note.md')
    expect(captured.names).toEqual(['note.md'])
    expect(document.querySelector('a[download]')).toBeNull()
    expect(captured.revoked).toEqual([])
    vi.advanceTimersByTime(0)
    expect(captured.revoked).toEqual(['blob:note-1'])
    vi.useRealTimers()
  })

  it('导出 Markdown 原文，文件名取自标题', () => {
    const captured = captureDownload()
    exportMarkdown('周报', '# 周报\n')
    expect(captured.names).toEqual(['周报.md'])
    expect(captured.blobs[0]?.type).toBe('text/markdown;charset=utf-8')
  })
})

describe('导出前整理正文', () => {
  it('代码块只保留代码本体，横幅、复制按钮与主题高亮色都不进导出文档', () => {
    const html = prepareNoteHtml('```ts\nconst a = 1\n```', 'raster')
    expect(html).toContain('<pre')
    expect(html.replace(/<[^>]+>/gu, '')).toContain('const a = 1')
    expect(html).not.toContain('复制')
    expect(html).not.toContain('md-code-block')
    expect(html).not.toContain('style=')
  })

  it('Word 把远程图片换成替代文字，不留取不到的地址', () => {
    const html = prepareNoteHtml('![示意图](https://example.com/a.png)\n\n![](https://example.com/b.png)', 'docx')
    expect(html).toContain('[图片] 示意图')
    expect(html).toContain('[图片]</p>')
    expect(html).not.toContain('example.com')
  })

  it('浏览器排版保留远程图片，Word 才去掉 KaTeX 的重复可见层', () => {
    const markdown = '![示意图](https://example.com/a.png)'
    expect(prepareNoteHtml(markdown, 'raster')).toContain('https://example.com/a.png')
  })
})

describe('Word 导出', () => {
  const markdown = `# 周报

正文有**加粗**和[链接](https://example.com)。

## 进展

- 一项
- 二项
  - 子项

1. 第一步
2. 第二步

> 引用

\`\`\`ts
const a = 1
\`\`\`

| 列一 | 列二 |
| --- | --- |
| 值一 | 值二 |
`

  it('生成真正的 docx：标题、列表、表格各用 Word 样式，正文不再挤在一段里', async () => {
    const blob = await noteDocxBlob('周报', markdown)
    expect(new Uint8Array(await blob.slice(0, 2).arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b]))
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')

    const body = await docxXml(blob, 'word/document.xml')
    expect(body).toContain('w:pStyle w:val="Heading1"')
    expect(body).toContain('w:pStyle w:val="Heading2"')
    expect(body).toContain('<w:numPr>')
    expect(body).toContain('<w:tbl>')
    expect(body).toContain('const a = 1')
    expect(body).not.toContain('复制')
    // 段落数必须是多个：整篇合成一段正是这次修掉的缺陷。
    expect(body.match(/<w:p>/gu)?.length ?? 0).toBeGreaterThan(4)
  })

  it('文档默认字体是黑体：中文走 eastAsia，西文走 SimHei', async () => {
    const styles = await docxXml(await noteDocxBlob('周报', '# 标题'), 'word/styles.xml')
    expect(styles).toContain('w:ascii="SimHei"')
    expect(styles).toContain('w:eastAsia="黑体"')
  })

  it('导出 Word 触发下载并带上 .docx 后缀', async () => {
    const captured = captureDownload()
    await exportWord('周报', '# 周报')
    expect(captured.names).toEqual(['周报.docx'])
  })
})

describe('PDF 分页的块合并', () => {
  it('标题与它后面的一块合成一段，不拆到两页', () => {
    expect(mergeHeadingSpans([
      { top: 0, bottom: 40, heading: true },
      { top: 40, bottom: 200, heading: false },
      { top: 200, bottom: 260, heading: false },
    ], 260)).toEqual([{ top: 0, bottom: 200 }, { top: 200, bottom: 260 }])
  })

  it('连续标题一起等正文，块间空白跟着合并后的区间走', () => {
    expect(mergeHeadingSpans([
      { top: 0, bottom: 40, heading: true },
      { top: 40, bottom: 80, heading: true },
      { top: 80, bottom: 300, heading: false },
    ], 300)).toEqual([{ top: 0, bottom: 300 }])
  })

  it('正文以标题结尾时保留标题，区间到正文末尾', () => {
    expect(mergeHeadingSpans([
      { top: 0, bottom: 100, heading: false },
      { top: 100, bottom: 140, heading: true },
    ], 140)).toEqual([{ top: 0, bottom: 100 }, { top: 100, bottom: 140 }])
  })

  it('没有块时没有任何区间', () => {
    expect(mergeHeadingSpans([], 0)).toEqual([])
  })

  it('按 DOM 判断标题块，HTML 的大写标签也算', () => {
    const html = prepareNoteHtml('# 一级\n\n## 二级\n\n正文', 'raster')
    const host = document.createElement('div')
    host.innerHTML = html
    const tags = [...host.querySelectorAll('h1, h2, p')]
    expect(tags.filter(tag => isHeadingBlock(tag)).map(tag => tag.tagName)).toEqual(['H1', 'H2'])
  })
})

describe('PDF 导出', () => {
  it('空正文没有可排的块', () => {
    expect(paginateNote([])).toEqual([])
  })

  it('按块边界分页：整块放不下就另起一页', () => {
    expect(paginateNote([{ top: 0, bottom: 60 }, { top: 60, bottom: 90 }], 100))
      .toEqual([{ top: 0, height: 90 }])
    expect(paginateNote([{ top: 0, bottom: 60 }, { top: 60, bottom: 120 }], 100))
      .toEqual([{ top: 0, height: 60 }, { top: 60, height: 60 }])
  })

  it('单块超过一页时按页高连续截断', () => {
    expect(paginateNote([{ top: 0, bottom: 250 }], 100))
      .toEqual([{ top: 0, height: 100 }, { top: 100, height: 100 }, { top: 200, height: 50 }])
  })

  it('页容量为 0 时每块各自成页，内容不丢', () => {
    expect(paginateNote([{ top: 0, bottom: 50 }, { top: 50, bottom: 80 }], 0))
      .toEqual([{ top: 0, height: 50 }, { top: 50, height: 30 }])
  })

  it('按页面尺寸组装 PDF，写完就收回挂在页面里的正文', async () => {
    const blob = await notePdfBlob('周报', '# 周报\n\n一段正文')
    expect(blob.type).toBe('application/pdf')
    expect(pdfStub.titles).toEqual(['周报'])
    expect(pdfStub.sizes).toEqual([[595.28, 841.89]])
    expect(pdfStub.images).toEqual(['data:image/png;base64,iVBORw0KGgo='])
    // 版心从 20mm 页边距开始，宽度铺满版心，高度按像素换算。
    const [draw] = pdfStub.draws[0] ?? []
    expect(draw?.x).toBeCloseTo(56.69, 2)
    expect(draw?.width).toBeCloseTo(481.9, 1)
    expect(draw?.height).toBeLessThanOrEqual(728.5)
    expect((draw?.y ?? 0) + (draw?.height ?? 0)).toBeCloseTo(841.89 - 56.69, 1)
    expect(document.querySelector('.note')).toBeNull()
  })

  it('正文超过一页时逐页截取、逐页落版', async () => {
    stubOffsetHeight(2000)
    await notePdfBlob('长文', '# 标题\n\n正文')
    expect(rasterize.toPng).toHaveBeenCalledTimes(2)
    expect(pdfStub.sizes).toHaveLength(2)
    expect(pdfStub.draws[0]?.[0]?.height).toBeCloseTo(728, 0)
    expect(pdfStub.draws[0]?.[1]?.height).toBeCloseTo(540, 0)
  })

  it('导出 PDF 触发下载并带上 .pdf 后缀', async () => {
    const captured = captureDownload()
    await exportPdf('周报', '# 周报')
    expect(captured.names).toEqual(['周报.pdf'])
    expect(captured.blobs[0]?.type).toBe('application/pdf')
  })
})

describe('图片导出', () => {
  it('整页编码成 PNG 并下载', async () => {
    const captured = captureDownload()
    await exportImage('周报', '# 周报')
    await vi.waitFor(() => { expect(captured.names).toEqual(['周报.png']) })
    expect(rasterize.toPng).toHaveBeenCalledOnce()
    expect(document.querySelector('.note')).toBeNull()
    expect(captured.blobs[0]?.type).toBe('image/png')
  })

  it('渲染失败时抛出，交给页面提示，并收回挂在页面里的正文', async () => {
    captureDownload()
    rasterize.toPng.mockImplementationOnce(async () => { throw new Error('note image render failed') })
    await expect(exportImage('周报', '# 周报')).rejects.toThrow(/note image render failed/u)
    expect(document.querySelector('.note')).toBeNull()
  })
})
