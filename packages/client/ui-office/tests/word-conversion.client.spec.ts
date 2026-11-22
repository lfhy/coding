/** 固定可保存的 Word 语义和编辑器快照的边界。 */
import type { IDocumentBody, IDocumentData, IParagraphStyle, ITextStyle } from '@univerjs/presets'
import { describe, expect, it } from 'vitest'
import type { WordDocument } from '../src/client/office-document.ts'
import { fromUniverDocument, toUniverDocument } from '../src/client/word-conversion.ts'

function snapshot(body: Partial<IDocumentBody> = {}, overrides: Partial<IDocumentData> = {}): IDocumentData {
  return { id: 'note', documentStyle: {}, body: { dataStream: '正文\r\n', ...body }, ...overrides }
}

function word(paragraphs: WordDocument['paragraphs']): WordDocument {
  return { version: 1, kind: 'word', paragraphs }
}

describe('Word 快照转换', () => {
  it('往返保留标题层级、对齐、字符格式、段内换行和空段', () => {
    const document = word([
      { style: 'title', align: 'center', runs: [{ text: '标题😀', bold: true, color: '#1a2B3c', fontSize: 20.5 }] },
      { style: 'normal', runs: [] },
      {
        style: 'heading1',
        align: 'left',
        runs: [
          { text: '甲\n乙', italic: true, underline: true, strike: true },
          { text: '\t丙', bold: false, italic: false, strike: false, underline: false },
        ],
      },
      { style: 'heading2', align: 'right', runs: [{ text: 'Heading' }] },
      { style: 'heading3', align: 'justify', runs: [] },
    ])
    const encoded = toUniverDocument(document, 'unit-1', '笔记标题')

    expect(encoded).toMatchObject({
      id: 'unit-1',
      title: '笔记标题',
      body: {
        dataStream: '标题😀\r\r甲\u2028乙\t丙\rHeading\r\r\n',
        paragraphs: [
          { startIndex: 4, paragraphStyle: { namedStyleType: 2, horizontalAlign: 2 } },
          { startIndex: 5, paragraphStyle: { namedStyleType: 1 } },
          { startIndex: 11, paragraphStyle: { namedStyleType: 4, horizontalAlign: 1, outlineLevel: 0 } },
          { startIndex: 19, paragraphStyle: { namedStyleType: 5, horizontalAlign: 3, outlineLevel: 1 } },
          { startIndex: 20, paragraphStyle: { namedStyleType: 6, horizontalAlign: 4, outlineLevel: 2 } },
        ],
        sectionBreaks: [{ startIndex: 21 }],
        textRuns: [
          { st: 0, ed: 4, ts: { bl: 1, cl: { rgb: '#1a2B3c' }, fs: 20.5 } },
          { st: 6, ed: 9, ts: { it: 1, ul: { s: 1 }, st: { s: 1 } } },
          { st: 9, ed: 11, ts: { bl: 0, it: 0, ul: { s: 0 }, st: { s: 0 } } },
          { st: 12, ed: 19, ts: {} },
        ],
      },
    })
    expect(new Set(encoded.body?.paragraphs?.map(paragraph => paragraph.paragraphId)).size).toBe(5)
    expect(fromUniverDocument(encoded)).toEqual(document)
  })

  it('空白文档留一个普通空段，不把终结符或空文本 run 当成正文', () => {
    for (const input of [word([]), word([{ style: 'normal', runs: [{ text: '', bold: true }] }])]) {
      const encoded = toUniverDocument(input, 'empty', '空白')
      expect(encoded.body).toMatchObject({
        dataStream: '\r\n',
        paragraphs: [{ startIndex: 0 }],
        textRuns: [],
        sectionBreaks: [{ startIndex: 1 }],
      })
      expect(fromUniverDocument(encoded)).toEqual(word([{ style: 'normal', runs: [] }]))
    }
    expect(fromUniverDocument(snapshot({ dataStream: '\r\n' }))).toEqual(word([{ style: 'normal', runs: [] }]))
  })

  it('统一常见换行写法且不增加段落', () => {
    const input = word([{ style: 'normal', runs: [{ text: '\r\n甲\r\n\n乙\r', bold: true }] }])
    const encoded = toUniverDocument(input, 'mixed', '换行')
    expect(encoded.body?.dataStream).toBe('\u2028甲\u2028\u2028乙\u2028\r\n')
    expect(fromUniverDocument(encoded)).toEqual(word([
      { style: 'normal', runs: [{ text: '\n甲\n\n乙\n', bold: true }] },
    ]))
  })

  it('按段尾切分跨段格式区间，保留间隙纯文本且不改变输入', () => {
    const ranges = [
      { st: 7, ed: 9, ts: { fs: 11 } },
      { st: 1, ed: 6, ts: { bl: 1 } as const },
    ]
    const input = snapshot({
      dataStream: '甲乙\r\r丙丁戊\r\n',
      paragraphs: [{ startIndex: 7, paragraphId: 'renumbered', paragraphStyle: { horizontalAlign: 0 } }],
      textRuns: ranges,
    })
    expect(fromUniverDocument(input)).toEqual(word([
      { style: 'normal', runs: [{ text: '甲' }, { text: '乙', bold: true }] },
      { style: 'normal', runs: [] },
      { style: 'normal', runs: [{ text: '丙丁', bold: true }, { text: '戊' }] },
    ]))
    expect(ranges.map(range => range.st)).toEqual([7, 1])
  })

  it('不把零宽格式标记当成一个 run，且无损规范化等价对齐和颜色', () => {
    const result = fromUniverDocument(snapshot({
      paragraphs: [{ startIndex: 2, paragraphId: 'rendered', paragraphStyle: { namedStyleType: 0, horizontalAlign: 5 } }],
      textRuns: [
        { st: 0, ed: 2, ts: { cl: { rgb: '#aB2' } } },
        { st: 1, ed: 1, ts: { bl: 1 } },
      ],
    }))
    expect(result).toEqual(word([{ style: 'normal', align: 'justify', runs: [{ text: '正文', color: '#aaBB22' }] }]))
  })

  it('接受编辑器补齐的布局、标题标识和格式重置值', () => {
    const result = fromUniverDocument(snapshot({
      dataStream: '标题\r正文\r\n',
      paragraphs: [
        {
          startIndex: 2, paragraphId: 'heading', headingCollapsed: true,
          paragraphStyle: { namedStyleType: 4, headingId: 'generated', outlineLevel: 0, spaceAbove: { v: 20 }, spaceBelow: { v: 10 } },
        },
        {
          startIndex: 5, paragraphId: 'new',
          paragraphStyle: { outlineLevel: 0, lineSpacing: 1.5, paragraphMarkTextStyle: { bl: 1 } },
        },
      ],
      textRuns: [
        { st: 0, ed: 2, ts: { ff: 'Arial', va: 1, cl: { rgb: null } } },
        { st: 3, ed: 5, ts: { ul: { s: 1, c: 1, t: 12 }, cl: { rgb: 'rgb(17, 24, 39)' } } },
      ],
      tables: [],
      customRanges: [],
      sectionBreaks: [{ startIndex: 6, sectionId: 'generated' }],
    }, {
      rev: 7,
      tableSource: {},
      drawings: {},
      resources: [
        { name: 'DOC_OBJECT_PERMISSION_PLUGIN', data: '[]' },
        { name: 'DOC_WORD_STYLES_PLUGIN', data: '' },
        { name: 'DOC_NOTE_PLUGIN', data: '' },
      ],
      settings: { zoomRatio: 1.25 },
      documentStyle: {
        documentFlavor: 2,
        pageSize: { width: 960, height: 842 / .75 },
        marginTop: 50,
        defaultParagraphStyle: { lineSpacing: 1.5 },
        renderConfig: { background: { rgb: '#ccc' }, zeroWidthParagraphBreak: 0 },
      },
    }))
    expect(result).toEqual(word([
      { style: 'heading1', runs: [{ text: '标题' }] },
      { style: 'normal', runs: [{ text: '正文', underline: true, color: '#111827' }] },
    ]))
  })

  it('拆分超过 Word 长度上限的同格式区间而不切开代理对', () => {
    const text = `${'a'.repeat(32_766)}😀字`
    const result = fromUniverDocument(snapshot({
      dataStream: `${text}\r\n`,
      textRuns: [{ st: 0, ed: text.length, ts: { fs: 13 } }],
    }))
    expect(result).toEqual(word([{ style: 'normal', runs: [
      { text: 'a'.repeat(32_766), fontSize: 13 },
      { text: '😀字', fontSize: 13 },
    ] }]))
  })

  it.each<Partial<IDocumentBody>>([
    { customRanges: [{ startIndex: 0, endIndex: 1, rangeId: 'link', rangeType: 0, properties: { url: 'https://example.com' } }] },
    { tables: [{ startIndex: 0, endIndex: 2, tableId: 'table' }] },
    { paragraphs: [{ startIndex: 2, paragraphId: 'list', bullet: { listId: 'list', listType: 'BULLET', nestingLevel: 0 } }] },
    { customBlocks: [{ startIndex: 0, blockId: 'chart' }] },
    { dataStream: '插入\f分页\r\n' },
    { dataStream: '多\r\n节\r\n' },
    { sectionBreaks: [{ startIndex: 3, sectionId: 'section', marginLeft: 40 }] },
    { dataStream: '无终结符\r' },
  ])('拒绝不支持的正文结构：%j', (body) => {
    expect(() => fromUniverDocument(snapshot(body))).toThrow('无法保存当前文字文档')
  })

  it.each<IParagraphStyle>([
    { namedStyleType: 3 },
    { namedStyleType: 7 },
    { namedStyleType: 5, outlineLevel: 0 },
    { horizontalAlign: 6 },
    { lineSpacing: 2 },
    { indentStart: { v: 12 } },
  ])('拒绝不支持的段落样式：%j', (paragraphStyle) => {
    const input = snapshot({ paragraphs: [{ paragraphId: 'p1', startIndex: 2, paragraphStyle }] })
    expect(() => fromUniverDocument(input)).toThrow('无法保存当前文字文档')
  })

  it.each<ITextStyle>([
    { ff: 'Verdana' },
    { fs: Number.NaN },
    { va: 3 },
    { bg: { rgb: '#ff0000' } },
    { cl: { rgb: 'rgba(0,0,0,0.5)' } },
    { ul: { s: 1, t: 10 } },
    { st: { s: 1, c: 0, cl: { rgb: '#00ff00' } } },
  ])('拒绝不支持的字符格式：%j', (ts) => {
    const input = snapshot({ textRuns: [{ st: 0, ed: 1, ts }] })
    expect(() => fromUniverDocument(input)).toThrow('无法保存当前文字文档')
  })

  it('拒绝损坏的索引和不能保存的页面设置', () => {
    expect(() => fromUniverDocument(snapshot({
      textRuns: [{ st: 0, ed: 2 }, { st: 1, ed: 2 }],
    }))).toThrow('无法保存当前文字文档')
    expect(() => fromUniverDocument(snapshot({
      paragraphs: [{ startIndex: 1, paragraphId: 'wrong' }],
    }))).toThrow('无法保存当前文字文档')
    expect(() => fromUniverDocument(snapshot({
      dataStream: '😀\r\n',
      textRuns: [{ st: 0, ed: 1, ts: { bl: 1 } }],
    }))).toThrow('无法保存当前文字文档')
    expect(() => fromUniverDocument(snapshot({}, { documentStyle: { marginTop: 80 } }))).toThrow('无法保存当前文字文档')
    expect(() => toUniverDocument(word([
      { style: 'normal', runs: [{ text: '错误\u001f标记' }] },
    ]), 'reserved', '控制字符')).toThrow('无法保存当前文字文档')
  })

  it('拒绝非空的内置资源和未知插件资源', () => {
    for (const resource of [
      { name: 'DOC_OBJECT_PERMISSION_PLUGIN', data: '[{"permission":true}]' },
      { name: 'UNSUPPORTED_RESOURCE', data: '[]' },
    ]) {
      expect(() => fromUniverDocument(snapshot({}, { resources: [resource] }))).toThrow('无法保存当前文字文档')
    }
  })
})
