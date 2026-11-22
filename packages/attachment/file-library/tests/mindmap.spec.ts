/** 思维导图在实际私有笔记目录中的准入、事务、格式与字节预算。 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from 'coding-storage'
import { DomainFacility } from 'coding-storage-domain'
import { SqliteStorageBackend } from 'coding-storage-sqlite'
import FileLibrary, { NOTE_MINDMAP_SUFFIX, NoteConflictError, NoteNotFoundError } from '../src/index.ts'
import type { MindMapDocument, MindMapEdit, MindMapNode } from '../src/index.ts'
import { xmindArchive } from './xmind-fixture.ts'

const contexts: Context[] = []
const homes: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

async function harness() {
  const home = await mkdtemp(join(tmpdir(), 'coding-file-library-mindmap-'))
  homes.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('sqlite', new SqliteStorageBackend({ path: join(home, 'files.sqlite'), journalMode: 'wal' }))
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'sqlite' }))
  await ctx.plugin(FileLibrary, { root: join(home, 'files') })
  return { library: ctx.fileLibrary, root: ctx.fileLibrary.notesRootPath(), home }
}

function node(id: string, text = id, children: MindMapNode[] = []): MindMapNode { return { id, text, children } }
function native(root = node('root', '中心')): MindMapDocument { return { version: 1, root } }
function bytes(value: unknown): Buffer { return Buffer.from(JSON.stringify(value)) }

const modern = bytes([
  { title: '画布名称', rootTopic: { id: '重复', title: '中心', style: { fill: 'red' }, children: {
    attached: [{ id: '重复', title: '甲', children: { attached: [{ title: '细节', image: 'xap:resources/secret.png' }] } }],
    detached: [{ title: '乙', href: 'https://example.com/' }],
  } } },
  { rootTopic: { title: '不导入第二张图' } },
])

describe('思维导图笔记文件', () => {
  it('私有新建由最终文件名生成中心主题，进入目录树但不进入 Markdown 入口或索引', async () => {
    const { library, root } = await harness()
    expect(NOTE_MINDMAP_SUFFIX).toBe('.codingmindmap')
    await library.createNoteDirectory('项目')
    await chmod(join(root, '项目'), 0o755)
    const { path } = await library.createNoteMindmap(' 计划.CODINGMINDMAP ', '项目')
    expect(path).toBe('项目/计划.codingmindmap')
    await library.createNoteMindmap('不进索引')
    await library.createNote('真实 Markdown')
    await writeFile(join(root, '外部稿.xmind'), modern)
    await mkdir(join(root, '同扩展名.codingmindmap'))
    const snapshot = await library.readNoteMindmap('项目\\计划.codingmindmap')
    expect(snapshot).toMatchObject({ path, document: { version: 1, root: { text: '计划', children: [] } } })
    expect(snapshot.document.root.id).not.toBe('')
    const disk = await readFile(join(root, path))
    expect(JSON.parse(disk.toString('utf8'))).toEqual(snapshot.document)
    expect(snapshot.revision).toBe(createHash('sha256').update(disk).digest('hex'))
    if (process.platform !== 'win32') {
      expect((await lstat(join(root, path))).mode & 0o777).toBe(0o600)
      expect((await lstat(join(root, '项目'))).mode & 0o777).toBe(0o700)
    }
    const tree = await library.notesTree()
    expect(tree.map(entry => `${entry.kind}:${entry.path}`).sort()).toEqual([
      'dir:同扩展名.codingmindmap', 'dir:项目', 'file:真实 Markdown.md', 'mindmap:不进索引.codingmindmap',
    ])
    const entry = tree.find(entry => entry.path === '项目')?.children?.[0]
    expect(entry).toMatchObject({ kind: 'mindmap', path })
    expect(entry?.children).toBeUndefined()
    expect((await library.listWithNotes(0, 50, { unscoped: true })).items.map(item => item.name)).toEqual(['真实 Markdown.md'])
    await expect(library.readNote(path)).rejects.toThrow(TypeError)
    await expect(library.saveNote(path, '不能覆盖')).rejects.toThrow(TypeError)
    await expect(library.readNoteMindmap('真实 Markdown.md')).rejects.toThrow(TypeError)
    await expect(library.readNoteMindmap('同扩展名.codingmindmap')).rejects.toThrow(TypeError)
    await expect(readFile(join(root, path))).resolves.toEqual(disk)
  })

  it('原生导入保留主题标识；改名保留来源后缀及大小写，且只删除文件本身', async () => {
    const { library, root } = await harness()
    await library.createNoteDirectory('科目')
    const document = native(node('主干', '外部中心', [node('细节', '内容')]))
    const { path } = await library.importNoteMindmap('C:\\原稿\\章节.CODINGMINDMAP', bytes(document), '科目')
    expect(path).toBe('科目/章节.codingmindmap')
    const initial = await library.readNoteMindmap(path)
    expect(initial.document).toEqual(document)
    await expect(library.createNoteMindmap('章节', '科目')).rejects.toThrow(NoteConflictError)
    await expect(library.importNoteMindmap('章节.codingmindmap', bytes(native()), '科目')).rejects.toThrow(NoteConflictError)
    await expect(library.renameNote(path, '章节.md')).rejects.toThrow(/扩展名不可更改/u)
    await library.createNoteMindmap('占用', '科目')
    await expect(library.renameNote(path, '占用')).rejects.toThrow(NoteConflictError)
    await library.deleteNote('科目/占用.codingmindmap')
    await writeFile(join(root, '科目', '副本.CODINGMINDMAP'), bytes(document))
    const renamed = await library.renameNote('科目/副本.CODINGMINDMAP', '新名称.codingmindmap')
    expect(renamed).toEqual({ path: '科目/新名称.CODINGMINDMAP' })
    await expect(library.readNoteMindmap(renamed.path)).resolves.toMatchObject({ document })
    await expect(library.renameNote(path, '修订')).resolves.toEqual({ path: '科目/修订.codingmindmap' })
    await expect(library.readNoteMindmap('科目/修订.codingmindmap')).resolves.toMatchObject({ revision: initial.revision, document })
    await library.deleteNote('科目/修订.codingmindmap')
    await expect(library.readNoteMindmap(path)).rejects.toThrow(NoteNotFoundError)
    await expect(readdir(join(root, '科目'))).resolves.toEqual(['新名称.CODINGMINDMAP'])
  })

  it('拒绝越界、内外部符号链接与幻灯片工程内部的读写、改名和删除', async () => {
    const { library, root, home } = await harness()
    const { path } = await library.createNoteMindmap('真实')
    const snapshot = await library.readNoteMindmap(path)
    const edits = [{ op: 'rename', id: snapshot.document.root.id, text: '禁止' }]
    await mkdir(join(home, 'outside', 'inner'), { recursive: true })
    const original = bytes(native())
    await writeFile(join(home, 'outside', 'inner', '真稿.codingmindmap'), original)
    const directoryType = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(join(home, 'outside'), join(root, '外链'), directoryType)
    await symlink(root, join(root, '内链'), directoryType)
    await symlink(join(root, path), join(root, '文件链接.codingmindmap'))
    await mkdir(join(root, '不透明.codingppt'))
    await writeFile(join(root, '不透明.codingppt', '工程资产.codingmindmap'), original)
    for (const denied of [
      '../outside/inner/真稿.codingmindmap', join(root, path), '外链/inner/真稿.codingmindmap',
      `内链/${path}`, '文件链接.codingmindmap', '不透明.codingppt/工程资产.codingmindmap',
    ]) {
      await expect(library.readNoteMindmap(denied), denied).rejects.toThrow(TypeError)
      await expect(library.editNoteMindmap(denied, snapshot.revision, edits), denied).rejects.toThrow(TypeError)
      await expect(library.renameNote(denied, '另名'), denied).rejects.toThrow(TypeError)
      await expect(library.deleteNote(denied), denied).rejects.toThrow(TypeError)
    }
    for (const directory of ['../outside', '外链/inner', '内链', '不透明.codingppt']) {
      await expect(library.createNoteMindmap('逃逸', directory), directory).rejects.toThrow(TypeError)
      await expect(library.importNoteMindmap('逃逸.codingmindmap', original, directory), directory).rejects.toThrow(TypeError)
    }
    await expect(library.readNoteMindmap(path)).resolves.toEqual(snapshot)
    await expect(readFile(join(home, 'outside', 'inner', '真稿.codingmindmap'))).resolves.toEqual(original)
    await expect(readdir(join(home, 'outside', 'inner'))).resolves.toEqual(['真稿.codingmindmap'])
    expect((await library.notesTree()).map(entry => entry.path).sort()).toEqual(['不透明.codingppt', path].sort())
  })
})

describe('思维导图编辑事务', () => {
  it('顺序应用编辑，移动位置基于移除后的目标数组，主题标识稳定', async () => {
    const { library, root } = await harness()
    const { path } = await library.importNoteMindmap('主题图.codingmindmap', bytes(native(node('root', '中心', [
      node('a', '甲', [node('only', '细节')]), node('b', '乙'), node('c', '丙'),
    ]))))
    const before = await library.readNoteMindmap(path)
    const edits: MindMapEdit[] = [
      { op: 'move', id: 'a', parentId: 'root', index: 2 },
      { op: 'move', id: 'b', parentId: 'a' },
      { op: 'add', parentId: 'root', text: '待办' },
      { op: 'rename', id: 'b', text: '乙的新名称' },
      { op: 'delete', id: 'only' },
      { op: 'rename', id: 'root', text: '主主题' },
    ]
    const after = await library.editNoteMindmap(path, before.revision, edits)
    expect(after.revision).not.toBe(before.revision)
    const addedId = after.document.root.children[2]?.id ?? ''
    expect(after.document.root).toEqual(node('root', '主主题', [
      node('c', '丙'), node('a', '甲', [node('b', '乙的新名称')]), node(addedId, '待办'),
    ]))
    expect(['root', 'a', 'b', 'c', 'only']).not.toContain(addedId)
    expect(addedId).toMatch(/^[0-9a-f-]{36}$/u)
    await expect(library.readNoteMindmap(path)).resolves.toEqual(after)
    await expect(readdir(root)).resolves.toEqual([path])
  })

  it('任一无效操作都不提交，包括未知字段、循环、动根和错误插入位置', async () => {
    const { library, root } = await harness()
    const { path } = await library.importNoteMindmap('整批.codingmindmap', bytes(native(node('root', '中心', [
      node('a', '甲', [node('child')]), node('b'),
    ]))))
    const before = await library.readNoteMindmap(path)
    const disk = await readFile(join(root, path))
    const ok = { op: 'rename', id: 'root', text: '未提交' }
    const invalid: unknown[] = [
      { op: 'not-an-op' }, { op: 'rename', id: 'a', text: '新名', extra: true },
      JSON.parse('{"op":"delete","id":"a","__proto__":{}}'),
      { op: 'rename', id: 'a', text: 123 }, { op: 'rename', id: 'a', text: '\ud800' },
      { op: 'add', parentId: 'a', text: '🧭'.repeat(257) },
      { op: 'add', parentId: '不存在', text: '目标不存在' },
      { op: 'delete', id: 'root' }, { op: 'move', id: 'root', parentId: 'a' },
      { op: 'move', id: 'a', parentId: 'a' }, { op: 'move', id: 'a', parentId: 'child' },
      { op: 'move', id: 'a', parentId: 'root', index: 2 }, { op: 'move', id: 'a', parentId: 'root', index: 0.5 },
      { op: 'move', id: 'a', parentId: 'root', index: undefined },
    ]
    for (const batch of [undefined, {}, [], Array.from({ length: 33 }, () => ok), ...invalid.map(edit => [ok, edit])]) {
      await expect(library.editNoteMindmap(path, before.revision, batch)).rejects.toThrow(TypeError)
      await expect(readFile(join(root, path))).resolves.toEqual(disk)
    }
    const exact = Array.from({ length: 32 }, () => ({ op: 'rename', id: 'a', text: '🧭'.repeat(256) }))
    await expect(library.editNoteMindmap(path, before.revision, exact)).resolves.toMatchObject({ path })
    await expect(readdir(root)).resolves.toEqual([path])
  })

  it('拒绝并发旧版本和相同 mtime 的外部改写；改名或删除后不复活原路径', async () => {
    const { library, root } = await harness()
    await library.createNoteDirectory('目录')
    const { path } = await library.createNoteMindmap('图', '目录')
    const target = join(root, path)
    const before = await library.readNoteMindmap(path)
    const edits = (text: string): MindMapEdit[] => [{ op: 'rename', id: before.document.root.id, text }]
    const first = library.editNoteMindmap(path, before.revision, edits('胜出'))
    const second = library.editNoteMindmap(path, before.revision, edits('过期'))
    await Promise.all([
      expect(first).resolves.toMatchObject({ document: { root: { text: '胜出' } } }),
      expect(second).rejects.toThrow(NoteConflictError),
    ])
    const fixedTime = new Date(1700000000000)
    await utimes(target, fixedTime, fixedTime)
    const changed = await library.readNoteMindmap(path)
    await writeFile(target, bytes(native(node(before.document.root.id, '外部写入'))))
    await utimes(target, fixedTime, fixedTime)
    expect((await lstat(target)).mtimeMs).toBe(fixedTime.getTime())
    await expect(library.editNoteMindmap(path, changed.revision, edits('不能覆盖'))).rejects.toThrow(NoteConflictError)
    const external = await library.readNoteMindmap(path)
    expect(external.document.root.text).toBe('外部写入')
    const rename = library.renameNote(path, '新位置')
    const late = library.editNoteMindmap(path, external.revision, edits('不能复活'))
    await expect(rename).resolves.toEqual({ path: '目录/新位置.codingmindmap' })
    await expect(late).rejects.toThrow(NoteNotFoundError)
    const gone = library.deleteNote('目录')
    const later = library.editNoteMindmap('目录/新位置.codingmindmap', external.revision, edits('不能重建目录'))
    await expect(gone).resolves.toBeUndefined()
    await expect(later).rejects.toThrow(NoteNotFoundError)
    await expect(readdir(root)).resolves.toEqual([])
  })

  it('在导入和整批编辑的各操作限制总节点、深度和实际原生字节', async () => {
    const { library, root } = await harness()
    const wide = native(node('root', '中心', Array.from({ length: 399 }, (_, i) => node(`child-${i}`))))
    const deep = native(Array.from({ length: 19 }, (_, i) => `level-${i}`).reduceRight(
      (child, key) => node(key, key, [child]), node('last'),
    ))
    const widePath = (await library.importNoteMindmap('宽.codingmindmap', bytes(wide))).path
    const deepPath = (await library.importNoteMindmap('深.codingmindmap', bytes(deep))).path
    const wideBase = await library.readNoteMindmap(widePath)
    const deepBase = await library.readNoteMindmap(deepPath)
    await expect(library.editNoteMindmap(widePath, wideBase.revision, [{ op: 'add', parentId: 'root', text: '第 401 个' }])).rejects.toThrow(/400/u)
    await expect(library.editNoteMindmap(deepPath, deepBase.revision, [{ op: 'add', parentId: 'last', text: '第 21 层' }])).rejects.toThrow(/层级/u)
    await expect(library.readNoteMindmap(widePath)).resolves.toEqual(wideBase)
    await expect(library.readNoteMindmap(deepPath)).resolves.toEqual(deepBase)
    const valid = bytes(native())
    const padded = Buffer.concat([valid, Buffer.alloc(1024 * 1024 - valid.length, 0x20)])
    await expect(library.importNoteMindmap('一兆.codingmindmap', padded)).resolves.toMatchObject({ path: '一兆.codingmindmap' })
    const oversized = Buffer.concat([padded, Buffer.from(' ')])
    await expect(library.importNoteMindmap('过大.codingmindmap', oversized)).rejects.toThrow(/1 MiB/u)
    await expect(lstat(join(root, '过大.codingmindmap'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(root, deepPath), oversized)
    await expect(library.readNoteMindmap(deepPath)).rejects.toThrow(/1 MiB/u)
  })
})

describe('思维导图导入', () => {
  it('只读取现代 XMind 首张图主题，跳过附带成员并丢弃格式和附件', async () => {
    const { library, root, home } = await harness()
    const data = xmindArchive([
      { name: 'content.json', data: modern, descriptor: true },
      { name: '../越界.txt', data: Buffer.alloc(3 * 1024 * 1024, 97) },
      { name: 'resources/secret.png', data: Buffer.from('不能落盘') },
    ])
    const { path } = await library.importNoteMindmap('专业题纲.XMIND', data)
    expect(path).toBe('专业题纲.codingmindmap')
    const { document } = await library.readNoteMindmap(path)
    const hierarchy = ({ text, children }: MindMapNode): object => ({ text, children: children.map(hierarchy) })
    expect(hierarchy(document.root)).toEqual({ text: '中心', children: [
      { text: '甲', children: [{ text: '细节', children: [] }] }, { text: '乙', children: [] },
    ] })
    const [first, second] = document.root.children
    expect(new Set([document.root.id, first?.id, first?.children[0]?.id, second?.id]).size).toBe(4)
    await expect(readFile(join(root, path), 'utf8')).resolves.not.toMatch(/resources|style|example\.com|第二张/u)
    await expect(readdir(root)).resolves.toEqual([path])
    await expect(lstat(join(home, '越界.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('拒绝无效原生格式、损坏或重复 XMind 主题和实际无界解包，不写任何文件', async () => {
    const { library, root } = await harness()
    await library.notesTree()
    const invalidNative = [
      Buffer.from('{'), Buffer.from([0xff]), bytes({ ...native(), version: 2 }),
      bytes({ ...native(), style: {} }), bytes(native(node('root', '中心', [node('root')]))),
      bytes({ version: 1, root: { ...node('root'), metadata: {} } }),
      bytes({ version: 1, root: { ...node('root'), children: null } }),
      bytes(native(node('root', '🧭'.repeat(257)))),
    ]
    for (const data of invalidNative) await expect(library.importNoteMindmap('无效.codingmindmap', data)).rejects.toThrow(TypeError)
    const member = { name: 'content.json', data: modern }
    const invalidArchives = [
      Buffer.from('PK'), xmindArchive([{ name: 'content.xml', data: modern }]),
      xmindArchive([{ name: 'nested/content.json', data: modern }]), xmindArchive([member, member]),
      xmindArchive([{ ...member, data: bytes([{ rootTopic: { title: 1 } }]) }]),
      xmindArchive([{ ...member, stored: true, declaredCrc: 0 }]),
    ]
    for (const data of invalidArchives) await expect(library.importNoteMindmap('坏稿.xmind', data)).rejects.toThrow(TypeError)
    const tooLarge = Buffer.concat([modern, Buffer.alloc(2 * 1024 * 1024, 0x20)])
    await expect(library.importNoteMindmap('超限.xmind', xmindArchive([{ ...member, data: tooLarge }]))).rejects.toThrow(/2 MiB/u)
    // 声明长度伪装成正常主题文件；必须在实际解压达到预算时停止。
    const lied = xmindArchive([{ ...member, data: tooLarge, declaredSize: modern.length }])
    await expect(library.importNoteMindmap('伪造大小.xmind', lied)).rejects.toThrow(/解压失败或超出/u)
    await expect(library.importNoteMindmap('超限.xmind', Buffer.alloc(16 * 1024 * 1024 + 1))).rejects.toThrow(/16 MiB/u)
    await expect(library.importNoteMindmap('其他.pptx', modern)).rejects.toThrow(TypeError)
    await expect(readdir(root)).resolves.toEqual([])
  })
})
