import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildPptx } from '../src/export/pptx.ts'
import { crc32 } from '../src/export/zip.ts'
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
      elements: [
        {
          id: 't1', kind: 'text', x: 96, y: 260, w: 1088, h: 120,
          text: { content: '增长 <32%> & 稳定', size: 64, color: '#f5f7fa', bold: true, align: 'left', valign: 'middle' },
        },
        { id: 'r1', kind: 'rect', x: 96, y: 400, w: 160, h: 8, fill: '#4f8cff' },
      ],
    },
    {
      id: 'p2',
      name: '图形',
      background: '#faf7f1',
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
})
