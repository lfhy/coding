import * as zlib from 'node:zlib'
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildPptx } from '../src/export/pptx.ts'
import { chartSvg, renderPageHtml } from '../src/render-html.ts'
import { renderPages } from '../src/render.ts'
import { buildPdf, decodePng } from '../src/export/pdf.ts'
import type { PptDeck } from 'coding-ppt-model'

const deck: PptDeck = {
  format: 1,
  title: '汇报',
  size: '16:9',
  theme: 'ink',
  pages: [
    {
      id: 'p1',
      name: '封面',
      background: null,
      transition: 'fade',
      elements: [
        {
          id: 't1', kind: 'text', x: 96, y: 260, w: 1088, h: 120,
          text: { content: '增长 <32%> & 稳定', size: 64, color: '#f5f7fa', bold: true, align: 'left', valign: 'middle', font: '' },
        },
        { id: 'r1', kind: 'rect', x: 96, y: 400, w: 160, h: 8, fill: '#4f8cff' },
      ],
    },
    {
      id: 'p2',
      name: '图形',
      background: '#faf7f1',
      transition: 'none',
      elements: [
        { id: 'e1', kind: 'ellipse', x: 100, y: 100, w: 200, h: 200, fill: '#b5652c' },
        { id: 'l1', kind: 'line', x: 400, y: 100, w: 300, h: 200, color: '#23201b', width: 3 },
      ],
    },
  ],
}

interface Entry {
  readonly path: string
  readonly data: Buffer
}

/** 读取中央目录，按名称取回每个成员并校验 CRC。 */
function readZip(bytes: Uint8Array): Entry[] {
  const buffer = Buffer.from(bytes)
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0) throw new Error('end of central directory not found')
  const count = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  const entries: Entry[] = []
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central header')
    const method = buffer.readUInt16LE(offset + 10)
    const crc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const path = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const localName = buffer.readUInt16LE(localOffset + 26)
    const localExtra = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localName + localExtra
    const raw = buffer.subarray(start, start + compressedSize)
    const data = method === 8 ? inflateRawSync(raw) : raw
    if (crc32(data) !== crc) throw new Error(`crc mismatch for ${path}`)
    entries.push({ path, data })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

describe('.pptx 导出', () => {
  it('产出结构完整的 OPC 包', () => {
    const entries = readZip(buildPptx(deck))
    const paths = entries.map(entry => entry.path)
    expect(paths).toContain('[Content_Types].xml')
    expect(paths).toContain('ppt/presentation.xml')
    expect(paths).toContain('ppt/slideMasters/slideMaster1.xml')
    expect(paths).toContain('ppt/slideLayouts/slideLayout1.xml')
    expect(paths).toContain('ppt/theme/theme1.xml')
    expect(paths).toContain('ppt/slides/slide1.xml')
    expect(paths).toContain('ppt/slides/slide2.xml')

    const types = entries.find(entry => entry.path === '[Content_Types].xml')?.data.toString('utf8') ?? ''
    expect(types).toContain('presentationml.slide+xml')
    const presentation = entries.find(entry => entry.path === 'ppt/presentation.xml')?.data.toString('utf8') ?? ''
    expect(presentation).toContain('<p:sldId id="256" r:id="rId2"/>')
    expect(presentation).toContain('cx="12192000"')
  })

  it('每页元素转成对应形状并转义文本', () => {
    const entries = readZip(buildPptx(deck))
    const first = entries.find(entry => entry.path === 'ppt/slides/slide1.xml')?.data.toString('utf8') ?? ''
    expect(first).toContain('<a:t>增长 &lt;32%&gt; &amp; 稳定</a:t>')
    expect(first).toContain('<a:srgbClr val="101418"/>')
    expect(first).toContain('<a:srgbClr val="4F8CFF"/>')
    expect(first).toContain('sz="4800"')
    expect(first).toContain('b="1"')

    const second = entries.find(entry => entry.path === 'ppt/slides/slide2.xml')?.data.toString('utf8') ?? ''
    expect(second).toContain('<a:srgbClr val="FAF7F1"/>')
    expect(second).toContain('prst="ellipse"')
    expect(second).toContain('<p:cxnSp>')
  })

  it('4:3 画布写出对应尺寸', () => {
    const wide = buildPptx({ ...deck, size: '4:3' })
    const presentation = readZip(wide)
      .find(entry => entry.path === 'ppt/presentation.xml')?.data.toString('utf8') ?? ''
    expect(presentation).toContain('cx="9144000"')
  })

  it('同样的输入得到同样的字节', () => {
    expect(Buffer.from(buildPptx(deck)).equals(Buffer.from(buildPptx(deck)))).toBe(true)
  })

  it('图片写入 media 部件并在 slide 里引用', () => {
    const withImage: PptDeck = {
      ...deck,
      pages: [{
        ...deck.pages[0]!,
        elements: [
          ...deck.pages[0]!.elements,
          { id: 'i1', kind: 'image', x: 800, y: 400, w: 320, h: 180, source: 'media/logo.png', fit: 'contain' },
        ],
      }],
    }
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const entries = readZip(buildPptx(withImage, { media: source => source === 'media/logo.png' ? png : undefined }))
    const paths = entries.map(entry => entry.path)
    expect(paths).toContain('ppt/media/image1.png')
    const types = entries.find(entry => entry.path === '[Content_Types].xml')?.data.toString('utf8') ?? ''
    expect(types).toContain('<Default Extension="png" ContentType="image/png"/>')
    const slide = entries.find(entry => entry.path === 'ppt/slides/slide1.xml')?.data.toString('utf8') ?? ''
    expect(slide).toContain('<p:pic>')
    expect(slide).toContain('r:embed="rId2"')
    const slideRels = entries.find(entry => entry.path === 'ppt/slides/_rels/slide1.xml.rels')
      ?.data.toString('utf8') ?? ''
    expect(slideRels).toContain('../media/image1.png')
    expect(Buffer.from(entries.find(entry => entry.path === 'ppt/media/image1.png')?.data ?? []).equals(png)).toBe(true)
  })

  it('表格写成 graphicFrame，转场写成 p:transition', () => {
    const withTable: PptDeck = {
      ...deck,
      pages: [{
        id: 'p1', name: '表', background: null, transition: 'fade',
        elements: [{
          id: 'tb', kind: 'table', x: 100, y: 100, w: 600, h: 200,
          rows: 2, columns: 2, columnWeights: [2, 1], header: true,
          headerFill: '#4f8cff', borderColor: '#9aa7b4',
          text: { size: 20, color: '#101418', bold: false, align: 'left', font: '' },
          cells: [[{ content: '指标' }, { content: '数值' }], [{ content: '增长' }, { content: '32%' }]],
        }],
      }],
    }
    const entries = readZip(buildPptx(withTable))
    const slide = entries.find(entry => entry.path === 'ppt/slides/slide1.xml')?.data.toString('utf8') ?? ''
    expect(slide).toContain('drawingml/2006/table')
    expect(slide).toContain('<a:tbl>')
    expect(slide).toContain('<a:t>增长</a:t>')
    expect(slide).toContain('<p:transition><p:fade/></p:transition>')
  })

  it('图表写成 chart 部件与 graphicFrame', () => {
    const withChart: PptDeck = {
      ...deck,
      pages: [{
        id: 'p1', name: '图', background: null, transition: 'none',
        elements: [{
          id: 'c1', kind: 'chart', x: 100, y: 100, w: 720, h: 360, chart: 'bar', stacked: false,
          categories: ['一季度', '二季度'], showValues: true, textColor: '#9aa7b4',
          series: [{ name: '本期', values: [32, 45], color: '#4f8cff' }],
        }],
      }],
    }
    const entries = readZip(buildPptx(withChart))
    const paths = entries.map(entry => entry.path)
    expect(paths).toContain('ppt/charts/chart1.xml')
    const chart = entries.find(entry => entry.path === 'ppt/charts/chart1.xml')?.data.toString('utf8') ?? ''
    expect(chart).toContain('<c:barChart>')
    expect(chart).toContain('<c:v>45</c:v>')
    const slide = entries.find(entry => entry.path === 'ppt/slides/slide1.xml')?.data.toString('utf8') ?? ''
    expect(slide).toContain('drawingml/2006/chart')
    const types = entries.find(entry => entry.path === '[Content_Types].xml')?.data.toString('utf8') ?? ''
    expect(types).toContain('.drawingml.chart+xml')
  })

  it('堆叠、次坐标轴与组合图写成对应的图表属性', () => {
    const stacked: PptDeck = {
      ...deck,
      pages: [{
        id: 'p1', name: '堆叠', background: null, transition: 'none',
        elements: [{
          id: 'c1', kind: 'chart', x: 0, y: 0, w: 720, h: 360, chart: 'bar', stacked: true,
          categories: ['A', 'B'], showValues: false, textColor: '#9aa7b4',
          series: [
            { name: '甲', values: [1, 2], color: '#4f8cff' },
            { name: '乙', values: [3, 4], color: '#b5652c', axis: 'secondary', as: 'line' },
          ],
        }],
      }],
    }
    const chart = readZip(buildPptx(stacked))
      .find(entry => entry.path === 'ppt/charts/chart1.xml')?.data.toString('utf8') ?? ''
    expect(chart).toContain('<c:grouping val="stacked"/>')
    expect(chart).toContain('<c:overlap val="100"/>')
    expect(chart).toContain('<c:lineChart>')
    expect(chart).toContain('<c:axPos val="r"/>')
    expect(chart).toContain('<c:axId val="3"/>')
  })

  it('元素动画写出 p:timing，字体嵌入写出 fntdata 与 embeddedFontLst', () => {
    const animated: PptDeck = {
      ...deck,
      pages: [{
        id: 'p1', name: '动画', background: null, transition: 'fade',
        elements: [{
          id: 't1', kind: 'text', x: 96, y: 100, w: 400, h: 80, animation: 'fade',
          text: { content: '淡入', size: 32, color: '#f5f7fa', bold: false, align: 'left', valign: 'top', font: 'Inter' },
        }],
      }],
    }
    const entries = readZip(buildPptx(animated, {
      fonts: [{ family: 'Inter', part: 'ppt/fonts/font1.fntdata', bytes: new Uint8Array([1, 2, 3]) }],
    }))
    const slide = entries.find(entry => entry.path === 'ppt/slides/slide1.xml')?.data.toString('utf8') ?? ''
    expect(slide).toContain('<p:timing>')
    expect(slide).toContain('animEffect')
    const presentation = entries.find(entry => entry.path === 'ppt/presentation.xml')?.data.toString('utf8') ?? ''
    expect(presentation).toContain('<p:embeddedFontLst>')
    expect(presentation).toContain('typeface="Inter"')
    const rels = entries.find(entry => entry.path === 'ppt/_rels/presentation.xml.rels')
      ?.data.toString('utf8') ?? ''
    expect(rels).toContain('fonts/font1.fntdata')
    const types = entries.find(entry => entry.path === '[Content_Types].xml')?.data.toString('utf8') ?? ''
    expect(types).toContain('application/x-fontdata')
  })

  it('强调、退场与路径动画都写进 timing', () => {
    const animated: PptDeck = {
      ...deck,
      pages: [{
        id: 'p1', name: '动画', background: null, transition: 'none',
        elements: [{
          id: 'r1', kind: 'rect', x: 100, y: 100, w: 200, h: 100, fill: '#4f8cff',
          animation: 'fade', emphasis: 'pulse', exitAnimation: 'fade', pathAnimation: 'right',
        }],
      }],
    }
    const slide = readZip(buildPptx(animated))
      .find(entry => entry.path === 'ppt/slides/slide1.xml')?.data.toString('utf8') ?? ''
    expect(slide).toContain('presetClass="entr"')
    expect(slide).toContain('presetClass="emph"')
    expect(slide).toContain('presetClass="exit"')
    expect(slide).toContain('animMotion')
    expect(slide).toContain('M 0 0 L 0.25 0 E')
  })

  it('缺图时退化成占位形状，导出仍然成立', () => {
    const withImage: PptDeck = {
      ...deck,
      pages: [{
        ...deck.pages[0]!,
        elements: [{ id: 'i1', kind: 'image', x: 10, y: 10, w: 100, h: 100, source: 'media/missing.png', fit: 'cover' }],
      }],
    }
    const entries = readZip(buildPptx(withImage))
    const slide = entries.find(entry => entry.path === 'ppt/slides/slide1.xml')?.data.toString('utf8') ?? ''
    expect(slide).toContain('<p:sp>')
    expect(slide).not.toContain('<p:pic>')
  })
})

describe('页面渲染（截图前的 HTML）', () => {
  it('HTML 自带尺寸、主题底色与元素', () => {
    const html = renderPageHtml(deck, deck.pages[0]!)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('width:1280px;height:720px')
    expect(html).toContain('增长 &lt;32%&gt;')
    expect(html).toContain('#4f8cff')
    expect(html).toContain('font-family:-apple-system')
  })

  it('图表画成内联 SVG，图片缺字节时退化成占位块', () => {
    const svg = chartSvg({
      id: 'c1', kind: 'chart', x: 0, y: 0, w: 400, h: 200, chart: 'bar', stacked: false,
      categories: ['A', 'B'], showValues: false, textColor: '#999999',
      series: [{ name: 's', values: [1, 2], color: '#4f8cff' }],
    }, 400, 200)
    expect(svg).toContain('<svg')
    expect(svg).toContain('<rect')
    const page = {
      id: 'p1', name: '图', background: null, transition: 'none' as const,
      elements: [{
        id: 'i1', kind: 'image' as const, x: 0, y: 0, w: 100, h: 100,
        source: 'media/missing.png', fit: 'cover' as const,
      }],
    }
    expect(renderPageHtml(deck, page)).toContain('background:#333')
  })

  it('调用浏览器提供方逐页截图，并把页面写进它的空间', async () => {
    const calls: { htmlPath: string; width: number; height: number; outPath: string; sessionId: string }[] = []
    const rendered = await renderPages({
      sessionId: 'session-one',
      projectDir: '/tmp/ppt-unit',
      deck,
      media: {},
      revision: 3,
      capture: {
        captureSessionPage: async (options) => {
          calls.push(options)
          return true
        },
      },
    })
    expect(rendered).toHaveLength(deck.pages.length)
    expect(calls[0]?.sessionId).toBe('session-one')
    expect(calls[0]?.width).toBe(1280)
    expect(calls[0]?.outPath).toContain('render/slide-1-v3.png')
  })

  it('没有浏览器提供方时明确失败', async () => {
    await expect(renderPages({
      sessionId: 'session-one', projectDir: '/tmp/ppt-unit', deck, media: {}, revision: 1, capture: undefined,
    })).rejects.toThrow(/浏览器提供方/u)
  })
})

const crc32 = (bytes: Buffer): number => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe('PDF 导出', () => {
  /** 造一张 2×2 的 RGBA PNG（不压缩可行：zlib 级别 0 也合法）。 */
  function tinyPng(): Uint8Array {
    const { deflateSync } = zlib
    const width = 2
    const height = 2
    const raw = Buffer.from([
      0, 255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 0, 255, 255, 255, 255, 255, 255,
    ])
    const idat = deflateSync(raw)
    const chunk = (type: string, data: Uint8Array): Buffer => {
      const length = Buffer.alloc(4)
      length.writeUInt32BE(data.length, 0)
      const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
      const crc = Buffer.alloc(4)
      crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])), 0)
      return Buffer.concat([length, body, crc])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8
    ihdr[9] = 6
    return new Uint8Array(Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', new Uint8Array(idat)),
      chunk('IEND', new Uint8Array()),
    ]))
  }

  it('解码 RGBA PNG 得到 RGB 像素', () => {
    const decoded = decodePng(tinyPng())
    expect(decoded.width).toBe(2)
    expect(decoded.height).toBe(2)
    expect(Array.from(decoded.rgb.slice(0, 3))).toEqual([255, 0, 0])
    expect(decoded.rgb).toHaveLength(2 * 2 * 3)
  })

  it('拼出带 xref 与每页图片的 PDF', () => {
    const pdf = buildPdf([{ bytes: tinyPng() }, { bytes: tinyPng() }])
    const text = Buffer.from(pdf).toString('latin1')
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text).toContain('/Type /Catalog')
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(text.match(/\/Subtype \/Image/gu)).toHaveLength(2)
    expect(text).toContain('/MediaBox [0 0 1.50 1.50]')
    expect(text).toContain('xref')
  })

  it('没有页面时拒绝生成', () => {
    expect(() => buildPdf([])).toThrow(/至少需要一页/u)
  })
})
