/** 固定 Word 快照在笔记协议与编辑器之间的边界：快照原样往返，不裁剪引擎结构。 */
import type { IDocumentData } from '@univerjs/presets'
import { expect, it } from 'vitest'
import type { WordDocument } from '../src/client/office-document.ts'
import { fromUniverDocument, toUniverDocument } from '../src/client/word-conversion.ts'

const snapshot = {
  body: {
    dataStream: '甲\r\n',
    // 表格与链接都属于引擎结构，转换层不解释也不丢弃它们。
    tables: [{ startIndex: 0, endIndex: 1, tableId: 'table-1' }],
    customRanges: [{ startIndex: 0, endIndex: 1, rangeId: 'link-1', rangeType: 0 }],
  },
  documentStyle: { documentFlavor: 2 },
} as unknown as IDocumentData

const document: WordDocument = { version: 2, kind: 'word', snapshot: snapshot as unknown as WordDocument['snapshot'] }

it('打开时覆盖文档标识与标题，不修改原快照', () => {
  const opened = toUniverDocument(document, 'office-content', '会议纪要')
  expect(opened.id).toBe('office-content')
  expect(opened.title).toBe('会议纪要')
  expect(opened.body?.tables).toBeDefined()
  expect((document.snapshot as Record<string, unknown>).id).toBeUndefined()
})

it('打开时把版式统一成 A4 分页纸，旧快照不必迁移', () => {
  const opened = toUniverDocument(document, 'office-content', '')
  const style = opened.documentStyle as Record<string, unknown>
  expect(style.documentFlavor).toBe(1)
  expect(style.pageSize).toEqual({ width: 794, height: 1124 })
  expect([style.marginTop, style.marginBottom, style.marginLeft, style.marginRight]).toEqual([96, 96, 96, 96])
})

it('保存时原样带回引擎快照，表格与链接都留在文档里', () => {
  const saved = fromUniverDocument(snapshot)
  expect(saved.version).toBe(2)
  expect(saved.kind).toBe('word')
  expect((saved.snapshot.body as Record<string, unknown>).tables).toEqual([{ startIndex: 0, endIndex: 1, tableId: 'table-1' }])
  expect((saved.snapshot.body as Record<string, unknown>).customRanges).toBeDefined()
})

it('保存与打开的副本互不共享引用', () => {
  const saved = fromUniverDocument(snapshot)
  const opened = toUniverDocument(saved, 'office-content', '')
  expect(opened.body).not.toBe(saved.snapshot.body)
})
