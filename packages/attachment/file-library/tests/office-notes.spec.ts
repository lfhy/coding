/** Office 笔记文件的真实磁盘、版本和队列语义。 */
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NOTE_EXCEL_SUFFIX, NOTE_WORD_SUFFIX, NoteConflictError, NoteNotFoundError, type OfficeDocument } from '../src/index.ts'
import { NoteStore } from '../src/notes.ts'
import { buildWordSnapshot } from '../src/office/word-snapshot.ts'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'coding-office-notes-'))
  directories.push(root)
  return { root, store: new NoteStore(root, async () => root) }
}

const paragraph = (text: string) => ({ style: 'normal' as const, runs: [{ text }] })
const words = (texts: string[]): OfficeDocument => ({ version: 2, kind: 'word', snapshot: buildWordSnapshot(texts.map(paragraph)) })

function rejectionOf(result: PromiseSettledResult<unknown>): unknown {
  if (result.status !== 'rejected') throw new Error('操作应被拒绝')
  return result.reason as unknown
}

describe('Office 笔记存取', () => {
  it('原生正文与 Markdown 隔离，改名保留源后缀并可删除', async () => {
    const { root, store } = await setup()
    const { path } = await store.office.create('word', '周报')
    const excel = await store.office.create('excel', '周报')
    expect(path).toBe(`周报${NOTE_WORD_SUFFIX}`)
    expect(excel.path).toBe(`周报${NOTE_EXCEL_SUFFIX}`)
    expect((await store.office.read(path)).document).toEqual({ version: 2, kind: 'word', snapshot: buildWordSnapshot([{ style: 'normal', runs: [] }]) })
    if (process.platform !== 'win32') expect((await lstat(join(root, path))).mode & 0o777).toBe(0o600)
    await expect(store.readNote(path)).rejects.toThrow(TypeError)
    await expect(store.saveNote(path, '不要覆盖')).rejects.toThrow(TypeError)
    await expect(store.renameNote(path, '会议.xlsx')).rejects.toThrow(TypeError)
    const uppercase = '周报.CODINGWORD'
    // 模拟来自磁盘的原生文件：树只按真实文件类型与后缀分类，不改写大小写。
    await rename(join(root, path), join(root, uppercase))
    await mkdir(join(root, '目录.codingword'))
    const tree = await store.notesTree()
    expect(tree).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'word', path: uppercase }),
      expect.objectContaining({ kind: 'excel', path: excel.path }),
      expect.objectContaining({ kind: 'dir', path: '目录.codingword' }),
    ]))
    const changed = await store.renameNote(uppercase, '新名.codingword')
    expect(changed.path).toBe('新名.CODINGWORD')
    await expect(store.office.export(changed.path)).resolves.toMatchObject({ name: '新名.docx' })
    await store.deleteNote(changed.path)
    await expect(store.office.read(changed.path)).rejects.toBeInstanceOf(NoteNotFoundError)
  })

  it('新建独占，保存和编辑共享版本队列，并拒绝改名或删除后的迟到写入', async () => {
    const { root, store } = await setup()
    const created = await Promise.allSettled([store.office.create('word', '同一文件'), store.office.create('word', '同一文件')])
    expect(created.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(rejectionOf(created[1])).toBeInstanceOf(NoteConflictError)
    const path = `同一文件${NOTE_WORD_SUFFIX}`
    const first = await store.office.read(path)
    const races = await Promise.allSettled([
      store.office.save(path, first.revision, words(['保存'])),
      store.office.edit(path, first.revision, [{ op: 'replace_paragraph', index: 0, paragraph: paragraph('并发编辑') }]),
    ])
    expect(races[0]).toMatchObject({ status: 'fulfilled', value: { document: words(['保存']) } })
    expect(rejectionOf(races[1])).toBeInstanceOf(NoteConflictError)
    const current = await store.office.read(path)
    const [moved, lateSave] = await Promise.allSettled([
      store.renameNote(path, '换名字'), store.office.save(path, current.revision, words(['迟到保存'])),
    ])
    expect(rejectionOf(lateSave)).toBeInstanceOf(NoteNotFoundError)
    if (moved.status !== 'fulfilled') throw new Error('应成功改名')
    const target = moved.value.path
    const [dropped, lateEdit] = await Promise.allSettled([
      store.deleteNote(target), store.office.edit(target, current.revision, [{ op: 'delete_paragraph', index: 0 }]),
    ])
    expect(dropped.status).toBe('fulfilled')
    expect(rejectionOf(lateEdit)).toBeInstanceOf(NoteNotFoundError)
    await expect(readdir(root)).resolves.toEqual([])
  })

  it('Word 批次按当前段落索引顺序应用，无效操作或外部替换均不会覆盖文件', async () => {
    const { root, store } = await setup()
    const { path } = await store.office.create('word', '会议')
    const first = await store.office.read(path)
    const staged = { op: 'insert_paragraph', index: 0, paragraph: paragraph('第一段') }
    await expect(store.office.edit(path, first.revision, [staged, { op: 'delete_paragraph', index: 9 }])).rejects.toThrow(TypeError)
    expect(await store.office.read(path)).toEqual(first)
    const edited = await store.office.edit(path, first.revision, [staged,
      { op: 'replace_paragraph', index: 1, paragraph: paragraph('第二段') }, { op: 'delete_paragraph', index: 0 }])
    expect(edited.document).toEqual(words(['第二段']))
    const changed = words(['另一进程写入'])
    await writeFile(join(root, path), JSON.stringify(changed))
    await expect(store.office.save(path, edited.revision, words(['不能覆盖']))).rejects.toBeInstanceOf(NoteConflictError)
    await expect(store.office.export(path, edited.revision)).rejects.toBeInstanceOf(NoteConflictError)
    const external = await store.office.read(path)
    expect(external.document).toEqual(changed)
    const tooManyBreaks = words(Array<string>(4).fill('\n'.repeat(30_000)))
    await expect(store.office.save(path, external.revision, tooManyBreaks)).rejects.toThrow(/换行和制表符过多/u)
    const result = await store.office.edit(path, external.revision, [{ op: 'delete_paragraph', index: 0 }])
    expect(result.document).toEqual(first.document)
    expect((await readdir(root)).sort()).toEqual([path])
  })

  it('含表格与图片的快照也能按段落编辑，结构原样保留', async () => {
    const { store } = await setup()
    const { path } = await store.office.create('word', '带结构')
    const base = await store.office.read(path)
    if (base.document.kind !== 'word') throw new Error('类型不符')
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    // 一张图片 + 一个 1×2 表格，中间夹一个普通段落。
    const snapshot = {
      ...base.document.snapshot,
      drawings: { d1: { drawingId: 'd1', source: png, imageSourceType: 'BASE64', docTransform: { width: 20, height: 20 } } },
      tableSource: { t1: { tableRows: [{ tableCells: [{}, {}] }] } },
      body: {
        dataStream: '\u0008\r\u001a\u001b\u001c甲\r\u001d\u001c乙\r\u001d\u000e\u001f\r\n',
        paragraphs: [{ startIndex: 1, paragraphId: 'p1', paragraphStyle: { namedStyleType: 1 } }],
        textRuns: [],
        sectionBreaks: [{ startIndex: 18, sectionId: 's1' }],
        tables: [{ startIndex: 2, endIndex: 18, tableId: 't1' }],
      },
    }
    const saved = await store.office.save(path, base.revision, { version: 2, kind: 'word', snapshot })
    const edited = await store.office.edit(path, saved.revision, [
      { op: 'replace_paragraph', index: 0, paragraph: { style: 'normal', runs: [{ text: '新的正文' }] } },
    ])
    expect(edited.document.kind).toBe('word')
    if (edited.document.kind !== 'word') throw new Error('类型不符')
    const result = edited.document.snapshot
    expect(result.drawings).toEqual(snapshot.drawings)
    expect(result.tableSource).toEqual(snapshot.tableSource)
    expect(result.body.tables).toHaveLength(1)
    expect(result.body.dataStream).toContain('\u001a\u001b\u001c甲\r\u001d')
    expect(result.body.dataStream).toContain('新的正文')
    expect(result.body.dataStream.startsWith('\u0008')).toBe(true)
  })

  it('按表格标识写入单元格文字，结构与其它内容不受影响', async () => {
    const { store } = await setup()
    const { path } = await store.office.create('word', '表格编辑')
    const base = await store.office.read(path)
    if (base.document.kind !== 'word') throw new Error('类型不符')
    const snapshot = {
      ...base.document.snapshot,
      tableSource: { t1: { tableRows: [{ tableCells: [{}, {}] }] } },
      body: {
        dataStream: '\r\u001a\u001b\u001c甲\r\u001d\u001c乙\r\u001d\u000e\u001f\r\n',
        paragraphs: [{ startIndex: 0, paragraphId: 'p1', paragraphStyle: { namedStyleType: 1 } }],
        textRuns: [],
        sectionBreaks: [{ startIndex: 17, sectionId: 's1' }],
        tables: [{ startIndex: 1, endIndex: 17, tableId: 't1' }],
      },
    }
    const saved = await store.office.save(path, base.revision, { version: 2, kind: 'word', snapshot })
    const edited = await store.office.edit(path, saved.revision, [
      { op: 'set_table_cells', tableId: 't1', cells: [{ row: 0, column: 1, text: '新乙' }] },
    ])
    if (edited.document.kind !== 'word') throw new Error('类型不符')
    expect(edited.document.snapshot.body.dataStream).toContain('\u001c甲\r\u001d')
    expect(edited.document.snapshot.body.dataStream).toContain('\u001c新乙\r\u001d')
    expect(edited.document.snapshot.tableSource).toEqual(snapshot.tableSource)
    await expect(store.office.edit(path, edited.revision, [
      { op: 'set_table_cells', tableId: 't1', cells: [{ row: 3, column: 0, text: '越界' }] },
    ])).rejects.toThrow(/行坐标/u)
    await expect(store.office.edit(path, edited.revision, [
      { op: 'set_table_cells', tableId: '缺失', cells: [{ row: 0, column: 0, text: 'x' }] },
    ])).rejects.toThrow(/表格不存在/u)
  })

  it('Excel 编辑整格替换、按规则清空并保持工作表 ID，失败批次保留整个快照', async () => {
    const { store } = await setup()
    const { path } = await store.office.create('excel', '统计')
    const first = await store.office.read(path)
    if (first.document.kind !== 'excel' || first.document.sheets[0] === undefined) throw new Error('缺少初始工作表')
    const { id } = first.document.sheets[0]
    const saved = await store.office.edit(path, first.revision, [
      { op: 'add_sheet', name: '库存' }, { op: 'rename_sheet', sheetId: id, name: '总计' },
      { op: 'set_cells', sheetId: id, cells: [{ row: 0, column: 0, value: 2, style: { bold: true } }, { row: 1, column: 0, value: true }] },
    ])
    if (saved.document.kind !== 'excel' || saved.document.sheets[1] === undefined) throw new Error('缺少新增工作表')
    const other = saved.document.sheets[1].id
    const change = { op: 'set_cells', sheetId: id, cells: [
      { row: 0, column: 0, value: '替换' }, { row: 1, column: 0, value: null },
      { row: 2, column: 0, value: null, formula: '=SUM(1,2)' }, { row: 3, column: 0, value: null, style: { bold: true } },
    ] }
    await expect(store.office.edit(path, saved.revision, [change, { op: 'rename_sheet', sheetId: id, name: '库存' }])).rejects.toThrow(TypeError)
    await expect(store.office.edit(path, saved.revision, [change, { op: 'delete_sheet', sheetId: '不存在的表' }])).rejects.toThrow(TypeError)
    await expect(store.office.read(path)).resolves.toEqual(saved)
    const result = await store.office.edit(path, saved.revision, [change, { op: 'delete_sheet', sheetId: other }])
    expect(result.document).toEqual({ version: 1, kind: 'excel', sheets: [{ id, name: '总计', cells: [
      { row: 0, column: 0, value: '替换' }, { row: 2, column: 0, value: null, formula: '=SUM(1,2)' },
      { row: 3, column: 0, value: null, style: { bold: true } },
    ] }] })
    await expect(store.office.edit(path, result.revision, [{ op: 'delete_sheet', sheetId: id }])).rejects.toThrow(/至少保留/u)
  })

  it('拒绝非原生文档、错误类型、超限结构及越界坐标，不留下临时文件', async () => {
    const { root, store } = await setup()
    const { path } = await store.office.create('excel', '限额')
    const first = await store.office.read(path)
    if (first.document.kind !== 'excel' || first.document.sheets[0] === undefined) throw new Error('缺少工作表')
    const { id } = first.document.sheets[0]
    const spreadsheet = (cells: unknown[], merges: unknown[] = []) => ({ version: 1, kind: 'excel', sheets: [{ id, name: '表', cells, merges }] })
    for (const document of [
      words(['错误类型']), { ...first.document, version: 2 }, { ...first.document, extra: true },
      spreadsheet([{ row: 100_000, column: 0, value: 1 }]), spreadsheet([{ row: 0, column: 1024, value: 1 }]),
      spreadsheet([{ row: 0, column: 0, value: null, formula: '=WEBSERVICE("外部")' }]),
      spreadsheet([{ row: 0, column: 0, value: 'a'.repeat(32768) }]),
      spreadsheet([{ row: 0, column: 0, value: 1 }, { row: 0, column: 0, value: 2 }]),
      spreadsheet([], [{ startRow: 0, startColumn: 0, endRow: 2, endColumn: 2 }, { startRow: 2, startColumn: 2, endRow: 3, endColumn: 3 }]),
    ]) await expect(store.office.save(path, first.revision, document)).rejects.toThrow(TypeError)
    for (const batch of [[], Array.from({ length: 33 }, () => ({ op: 'add_sheet', name: '多余' })),
      [{ op: 'set_cells', sheetId: id, cells: Array.from({ length: 257 }, (_, row) => ({ row, column: 0, value: 1 })) }]]) {
      await expect(store.office.edit(path, first.revision, batch)).rejects.toThrow(TypeError)
    }
    await expect(store.office.read(path)).resolves.toEqual(first)
    // 原生笔记不再限制文件大小：超大文件按内容判定，而不是按字节数直接拒绝。
    const raw = join(root, 'big.codingword')
    await writeFile(raw, new Uint8Array(9 * 1024 * 1024))
    await expect(store.office.read('big.codingword')).rejects.toThrow(/不是有效的原生文档/u)
    await expect(store.office.import('word', '非法.docx', new Uint8Array([1, 0, 0]))).rejects.toThrow(TypeError)
    expect((await readdir(root)).sort()).toEqual(['big.codingword', path].sort())
  })

  it('每一级父路径和文件均拒绝符号链接，不能把幻灯片工程用作 Office 容器', async () => {
    const { root, store } = await setup()
    await mkdir(join(root, '真实', '子目录'), { recursive: true })
    const { path } = await store.office.create('word', '原件', '真实/子目录')
    const base = await store.office.read(path)
    const target = join(root, path)
    const realData = await readFile(target)
    const linkedFile = '文件链接.codingword'
    await symlink(target, join(root, linkedFile))
    await symlink(join(root, '真实'), join(root, '目录链接'), process.platform === 'win32' ? 'junction' : 'dir')
    const parentAlias = '目录链接/子目录/原件.codingword'
    for (const alias of [parentAlias, linkedFile]) {
      await expect(store.office.read(alias)).rejects.toThrow(TypeError)
      await expect(store.office.save(alias, base.revision, words(['越界']))).rejects.toThrow(TypeError)
      await expect(store.office.export(alias)).rejects.toThrow(TypeError)
      await expect(store.renameNote(alias, '越界改名')).rejects.toThrow(TypeError)
      await expect(store.deleteNote(alias)).rejects.toThrow(TypeError)
    }
    await expect(store.office.create('word', '不应创建', '目录链接/子目录')).rejects.toThrow(TypeError)
    await expect(store.office.create('word', '不应创建', '../外部')).rejects.toThrow(TypeError)
    await expect(store.office.create('word', '不应创建', '缺失')).rejects.toBeInstanceOf(NoteNotFoundError)
    await mkdir(join(root, '演示.codingppt'))
    await expect(store.office.create('excel', '不应创建', '演示.codingppt')).rejects.toThrow(TypeError)
    expect((await store.notesTree()).map(node => node.path).sort()).toEqual(['演示.codingppt', '真实'].sort())
    expect(await readFile(target)).toEqual(realData)
    expect(await readdir(join(root, '真实', '子目录'))).toEqual(['原件.codingword'])
  })
})
