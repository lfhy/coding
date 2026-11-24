import { expect, it, vi } from 'vitest'
import { isOfficeDocument, type OfficeDocument } from '../src/client/office-document.ts'
import { createOfficeIo } from '../src/client/wire.ts'

const word: OfficeDocument = { version: 2, kind: 'word', snapshot: { body: { dataStream: '文字\r\n', textRuns: [{ st: 0, ed: 2, ts: { bl: 1 } }], paragraphs: [{ startIndex: 2, paragraphId: 'p1', paragraphStyle: { namedStyleType: 2 } }] } } }
const path = '自用/文档 & 表.codingword'
const snapshot = { path, revision: 'first', document: word }
const signal = new AbortController().signal

it('只采纳当前路径和类型的完整 Host 快照', async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(Response.json({ ...snapshot, path: '另一篇.codingword' }))
    .mockResolvedValueOnce(Response.json({ ...snapshot, document: { version: 1, kind: 'excel', sheets: [] } }))
    .mockResolvedValueOnce(Response.json({ ...snapshot, diagnostic: 'not part of the response' }))
  const io = createOfficeIo(path, 'word', request)
  await expect(io.read(signal)).resolves.toEqual({ kind: 'ready', value: snapshot })
  expect(request).toHaveBeenCalledWith(`/api/notes/office/read?${new URLSearchParams({ path })}`, {
    signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error',
  })
  for (let i = 0; i < 3; i++) await expect(io.read(signal)).resolves.toEqual({ kind: 'failed' })
})

it('使用绑定的路径和修订号提交并分类冲突，不向上暴露响应正文', async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ error: 'diagnostic' }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ error: 'diagnostic' }, { status: 400 }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
  const io = createOfficeIo(path, 'word', request)
  await expect(io.save('first', word, signal)).resolves.toEqual({ kind: 'conflict' })
  expect(request).toHaveBeenCalledWith('/api/notes/office/save', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ path, revision: 'first', document: word }),
  }))
  await expect(io.save('first', word, signal)).resolves.toEqual({ kind: 'unsupported' })
  await expect(io.read(signal)).resolves.toEqual({ kind: 'missing' })
  await expect(createOfficeIo(path, 'excel', request).read(signal)).resolves.toEqual({ kind: 'failed' })
  expect(request).toHaveBeenCalledTimes(3)
})

it('只接收文件附件并用笔记名称生成相应的扩展名', async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('test', { headers: {
      'Content-Disposition': 'attachment; filename=\"not-a-product-file.docx\"',
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    } }))
    .mockResolvedValueOnce(new Response('<html>') )
    .mockResolvedValueOnce(new Response('test', { headers: {
      'Content-Disposition': 'attachment; filename=\"x.xlsx\"',
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    } }))
  const io = createOfficeIo(path, 'word', request)
  const result = await io.export('next', signal)
  expect(result).toMatchObject({ kind: 'ready', value: { filename: '文档 & 表.docx', blob: { size: 4 } } })
  expect(request).toHaveBeenCalledWith(`/api/notes/office/export?${new URLSearchParams({ path, revision: 'next' })}`, expect.anything())
  await expect(io.export('next', signal)).resolves.toEqual({ kind: 'failed' })
  await expect(createOfficeIo('表.codingexcel', 'excel', request).export('next', signal))
    .resolves.toMatchObject({ kind: 'ready', value: { filename: '表.xlsx' } })
})

it('拒绝不能写回的结构、无效内容和重复工作表', () => {
  expect(isOfficeDocument(word, 'word')).toBe(true)
  const snapshotOf = (snapshot: object) => isOfficeDocument({ version: 2, kind: 'word', snapshot }, 'word')
  expect(snapshotOf({ body: { dataStream: '甲\r\n', tables: [] } })).toBe(true)
  expect(snapshotOf({ body: {} })).toBe(false)
  expect(snapshotOf({ body: { dataStream: '' } })).toBe(false)
  expect(isOfficeDocument({ version: 1, kind: 'word', paragraphs: [] }, 'word')).toBe(false)
  const sheet = { id: 'one', name: 'Sheet1', cells: [{ row: 99_999, column: 1023, value: null, formula: '=1+2' }] }
  const excel = (sheets: readonly unknown[]) => isOfficeDocument({ version: 1, kind: 'excel', sheets }, 'excel')
  expect(excel([sheet])).toBe(true)
  expect(excel([sheet, { ...sheet, id: 'two', name: 'SHEET1' }])).toBe(false)
  expect(excel([{ ...sheet, cells: [{ row: 100_000, column: 0, value: true }] }])).toBe(false)
  expect(excel([{ ...sheet, cells: [...sheet.cells, ...sheet.cells] }])).toBe(false)
})
