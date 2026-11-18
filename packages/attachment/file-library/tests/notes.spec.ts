import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from 'coding-storage'
import { DomainFacility } from 'coding-storage-domain'
import { SqliteStorageBackend } from 'coding-storage-sqlite'
import FileLibrary, { StaleNoteError } from '../src/index.ts'

const homes: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

async function harness(home?: string) {
  const dir = home ?? await mkdtemp(join(tmpdir(), 'coding-file-library-notes-'))
  if (!home) homes.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: join(dir, 'files.sqlite'), journalMode: 'wal' })
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite' })
  ctx.provide('storageDomain', facility)
  await ctx.plugin(FileLibrary, { root: join(dir, 'files') })
  return { ctx, library: ctx.fileLibrary, dir, backend }
}

describe('无目录笔记域', () => {
  it('扫描目录树：目录与 Markdown 文件入树，其他扩展名与符号链接不入树', async () => {
    const { library } = await harness()
    await library.notesTree()
    const notesDir = library.notesRootPath()
    await mkdir(join(notesDir, 'ideas', 'deep'), { recursive: true, mode: 0o700 })
    await writeFile(join(notesDir, 'top.md'), '顶层笔记')
    await writeFile(join(notesDir, 'ideas', 'one.md'), '一级笔记')
    await writeFile(join(notesDir, 'ideas', 'deep', 'two.markdown'), '二级笔记')
    await writeFile(join(notesDir, 'ideas', 'data.txt'), '不是笔记')
    await symlink(join(notesDir, 'top.md'), join(notesDir, 'link.md'))
    const tree = await library.notesTree()
    expect(tree.map(node => `${node.kind}:${node.path}`)).toEqual([
      'dir:ideas',
      'file:top.md',
    ])
    const ideas = tree.find(node => node.kind === 'dir')
    expect(ideas?.children?.map(node => node.path)).toEqual(['ideas/deep', 'ideas/one.md'])
    const deep = ideas?.children?.find(node => node.path === 'ideas/deep')
    expect(deep?.children?.map(node => node.path)).toEqual(['ideas/deep/two.markdown'])
  })

  it('笔记根目录被会话初始化放宽权限后会重新收紧', async () => {
    const { library } = await harness()
    await library.notesTree()
    const notesDir = library.notesRootPath()
    await chmod(notesDir, 0o755)
    await library.notesTree()
    if (process.platform !== 'win32') expect((await lstat(notesDir)).mode & 0o777).toBe(0o700)
  })

  it('读取笔记返回全文与修改时间；越界路径与非 Markdown 文件被拒绝', async () => {
    const { library } = await harness()
    await library.notesTree()
    const notesDir = library.notesRootPath()
    await writeFile(join(notesDir, 'a.md'), '内容 A')
    await writeFile(join(notesDir, '..', 'evil.md'), '越界')
    const read = await library.readNote('a.md')
    expect(read.content).toBe('内容 A')
    expect(read.path).toBe('a.md')
    expect(read.mtimeMs).toBeGreaterThan(0)
    await expect(library.readNote('../evil.md')).rejects.toThrow(TypeError)
    await expect(library.readNote('notes/a.md')).rejects.toThrow(/笔记不存在/)
    await writeFile(join(notesDir, 'a.txt'), '不是笔记')
    await expect(library.readNote('a.txt')).rejects.toThrow(/笔记扩展名无效/)
  })

  it('写入经临时文件原子落盘，按需收紧中间目录权限', async () => {
    const { library } = await harness()
    const notesDir = library.notesRootPath()
    const saved = await library.saveNote('ideas/draft.md', '草稿', undefined)
    expect(saved.path).toBe('ideas/draft.md')
    expect(saved.mtimeMs).toBeGreaterThan(0)
    const info = await lstat(join(notesDir, 'ideas', 'draft.md'))
    expect(info.mode & 0o777).toBe(0o600)
    if (process.platform !== 'win32') expect((await lstat(join(notesDir, 'ideas'))).mode & 0o777).toBe(0o700)
    const listed = await readdir(notesDir)
    expect(listed).toEqual(['ideas'])
  })

  it('读后外部修改时按基准时间拒绝覆盖', async () => {
    const { library } = await harness()
    const notesDir = library.notesRootPath()
    const first = await library.saveNote('conflict.md', '第一版')
    await utimes(join(notesDir, 'conflict.md'), new Date(first.mtimeMs - 1000), new Date(first.mtimeMs - 1000))
    await expect(library.saveNote('conflict.md', '第二版', first.mtimeMs)).rejects.toThrow(StaleNoteError)
    await expect(library.readNote('conflict.md')).resolves.toMatchObject({ content: '第一版' })
    await expect(library.saveNote('conflict.md', '第二版', undefined)).resolves.toMatchObject({ path: 'conflict.md' })
  })

  it('新建笔记补 Markdown 扩展名，同名拒绝', async () => {
    const { library } = await harness()
    expect((await library.createNote('会议纪要')).path).toBe('会议纪要.md')
    expect((await library.createNote('周报.markdown')).path).toBe('周报.markdown')
    await expect(library.createNote('会议纪要.md')).rejects.toThrow(/笔记已存在/)
    const tree = await library.notesTree()
    expect(tree.map(node => node.path)).toEqual(['会议纪要.md', '周报.markdown'])
  })

  it('在指定目录新建笔记和子目录，并拒绝目录逃逸与同名覆盖', async () => {
    const { library } = await harness()
    await library.notesTree()
    expect((await library.createNoteDirectory('项目资料')).path).toBe('项目资料')
    expect((await library.createNote('会议纪要', '项目资料')).path).toBe('项目资料/会议纪要.md')
    await expect(library.createNoteDirectory('项目资料')).rejects.toThrow(/目录已存在/)
    await expect(library.createNote('越界', '../')).rejects.toThrow(TypeError)
    await expect(library.createNoteDirectory('越界', '../')).rejects.toThrow(TypeError)
    await expect(library.notesTree()).resolves.toEqual([
      expect.objectContaining({ kind: 'dir', path: '项目资料' }),
    ])
  })

  it('无目录笔记并入未分组列表与 note 过滤，子目录笔记不出现', async () => {
    const { library } = await harness()
    await library.notesTree()
    const notesDir = library.notesRootPath()
    await mkdir(join(notesDir, 'archive'), { recursive: true, mode: 0o700 })
    await writeFile(join(notesDir, 'root.md'), '无目录笔记')
    await writeFile(join(notesDir, 'archive', 'old.md'), '有目录笔记')
    const unscoped = await library.listWithNotes(0, 50, { unscoped: true })
    expect(unscoped.items).toMatchObject([{ kind: 'note', name: 'root.md', relativePath: 'notes/root.md', mediaType: 'text/markdown' }])
    const notesOnly = await library.listWithNotes(0, 50, { kind: 'note' })
    expect(notesOnly.items.map(row => row.name)).toEqual(['root.md'])
    const uploadsOnly = await library.listWithNotes(0, 50, { unscoped: true, kind: 'upload' })
    expect(uploadsOnly.items).toEqual([])
  })

  it('按实时 id 读取无目录笔记字节，登记记录不重复', async () => {
    const { library } = await harness()
    await library.notesTree()
    const notesDir = library.notesRootPath()
    await writeFile(join(notesDir, 'serve.md'), '可服务的内容')
    const record = (await library.noteRecords())[0]
    expect(record!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    const served = await library.read(record!.id)
    expect(served!.record).toEqual(record)
    expect(Buffer.from(served!.data).toString('utf8')).toBe('可服务的内容')
    // 同一相对路径重复调用仍映射同一 id，且登记后不重复出现在实时记录。
    expect((await library.noteRecords()).map(row => row.id)).toEqual([record!.id])
  })
})
