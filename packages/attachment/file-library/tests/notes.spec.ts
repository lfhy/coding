import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from 'coding-storage'
import { DomainFacility } from 'coding-storage-domain'
import { SqliteStorageBackend } from 'coding-storage-sqlite'
import FileLibrary, { NoteConflictError, NoteNotFoundError, StaleNoteError } from '../src/index.ts'

/** 测试用二进制字节；文件库只处理路径，不解析或改写演示文稿内容。 */
const pptxBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe])

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
  it('扫描目录树：幻灯片工程目录占一行，其余扩展名与符号链接都不入树', async () => {
    const { library } = await harness()
    await library.notesTree()
    const notesDir = library.notesRootPath()
    await mkdir(join(notesDir, 'ideas', 'deep'), { recursive: true, mode: 0o700 })
    const deck = join(notesDir, '演示.codingppt')
    await mkdir(deck, { mode: 0o700 })
    await writeFile(join(deck, 'deck.json'), '{}')
    await mkdir(join(notesDir, 'ideas', 'PLAN.CODINGPPT'), { mode: 0o700 })
    await writeFile(join(notesDir, 'top.md'), '顶层笔记')
    await writeFile(join(notesDir, 'slides.pptx'), pptxBytes)
    await writeFile(join(notesDir, 'ideas', 'one.md'), '一级笔记')
    await writeFile(join(notesDir, 'ideas', 'deep', 'two.markdown'), '二级笔记')
    await writeFile(join(notesDir, 'ideas', 'deep', 'three.pptx'), pptxBytes)
    await writeFile(join(notesDir, 'ideas', 'data.txt'), '不是笔记')
    await symlink(join(notesDir, 'top.md'), join(notesDir, 'link.md'))
    await symlink(deck, join(notesDir, 'link.codingppt'), process.platform === 'win32' ? 'junction' : 'dir')
    const tree = await library.notesTree()
    expect(tree.map(node => `${node.kind}:${node.path}`).sort()).toEqual([
      'deck:演示.codingppt',
      'dir:ideas',
      'file:top.md',
    ])
    const ideas = tree.find(node => node.kind === 'dir')
    expect(ideas?.children?.map(node => `${node.kind}:${node.path}`).sort()).toEqual([
      'deck:ideas/PLAN.CODINGPPT',
      'dir:ideas/deep',
      'file:ideas/one.md',
    ])
    const deep = ideas?.children?.find(node => node.path === 'ideas/deep')
    expect(deep?.children?.map(node => node.path)).toEqual(['ideas/deep/two.markdown'])
    const entry = tree.find(node => node.path === '演示.codingppt')
    expect(entry).toMatchObject({ name: '演示.codingppt', kind: 'deck', path: '演示.codingppt' })
    // 工程目录内部的文件不进入树，幻灯片因此只占一个条目。
    expect(entry?.children).toBeUndefined()
    expect(entry?.mtimeMs).toBe((await lstat(deck)).mtimeMs)
    expect(tree.some(node => node.path.endsWith('deck.json'))).toBe(false)
  })

  it('混合目录与幻灯片工程仍受原有深度和全部条目预算限制', async () => {
    const { library } = await harness()
    await library.notesTree()
    const notesDir = library.notesRootPath()
    let path = notesDir
    for (let depth = 1; depth <= 8; depth += 1) {
      path = join(path, `level-${depth}`)
      await mkdir(path)
    }
    await writeFile(join(path, 'deep.pptx'), pptxBytes)
    await expect(library.notesTree()).resolves.toHaveLength(1)
    await mkdir(join(path, 'level-9'))
    await expect(library.notesTree()).rejects.toThrow(/笔记目录层级过深/)

    const { library: budgetLibrary } = await harness()
    await budgetLibrary.notesTree()
    const budgetDir = budgetLibrary.notesRootPath()
    await mkdir(join(budgetDir, 'slides.codingppt'), { mode: 0o700 })
    // 不展示的 .txt 也占用预算：只增加第 4097 个条目才必须拒绝整棵树。
    for (let start = 0; start < 4095; start += 128) {
      await Promise.all(Array.from({ length: Math.min(128, 4095 - start) }, (_, index) =>
        writeFile(join(budgetDir, `hidden-${start + index}.txt`), '')))
    }
    await expect(budgetLibrary.notesTree()).resolves.toMatchObject([{ kind: 'deck', path: 'slides.codingppt' }])
    await writeFile(join(budgetDir, 'extra.txt'), '')
    await expect(budgetLibrary.notesTree()).rejects.toThrow(/笔记条目过多/)
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
    await writeFile(join(notesDir, 'deck.pptx'), pptxBytes)
    await expect(library.readNote('deck.pptx')).rejects.toThrow(/笔记扩展名无效/)
    await expect(library.saveNote('deck.pptx', '不能覆盖源稿')).rejects.toThrow(/笔记必须使用 Markdown 扩展名/)
    await expect(library.saveNote('new.pptx', '不能创建源稿')).rejects.toThrow(/笔记必须使用 Markdown 扩展名/)
    await expect(readFile(join(notesDir, 'deck.pptx'))).resolves.toEqual(pptxBytes)
    await expect(readdir(notesDir)).resolves.not.toContain('new.pptx')
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

  it('改名和删除单篇笔记与空目录', async () => {
    const { library } = await harness()
    await library.saveNote('draft.md', '草稿')
    expect(await library.renameNote('draft.md', 'published')).toEqual({ path: 'published.md' })
    await expect(library.renameNote('published.md', 'published')).resolves.toEqual({ path: 'published.md' })
    await expect(library.saveNote('published.md', '更新')).resolves.toMatchObject({ path: 'published.md' })
    await expect(library.renameNote('published.md', 'published.markdown')).rejects.toThrow(/文件扩展名不可更改/)
    await expect(library.renameNote('published.md', 'published.pptx')).rejects.toThrow(/文件扩展名不可更改/)
    await library.saveNote('source.markdown', '另一篇笔记')
    await expect(library.renameNote('source.markdown', 'review')).resolves.toEqual({ path: 'review.markdown' })

    await library.createNoteDirectory('empty')
    expect(await library.renameNote('empty', 'renamed')).toEqual({ path: 'renamed' })
    await library.deleteNote('renamed')
    await library.deleteNote('published.md')
    await library.deleteNote('review.markdown')
    await expect(readdir(library.notesRootPath())).resolves.toEqual([])
    await expect(library.deleteNote('published.md')).rejects.toThrow(NoteNotFoundError)
  })

  it('幻灯片工程目录改名保留后缀，同名目标与非单段名称都拒绝', async () => {
    const { library } = await harness()
    await library.notesTree()
    const notesDir = library.notesRootPath()
    await mkdir(join(notesDir, 'projects'), { mode: 0o700 })
    await mkdir(join(notesDir, 'projects', 'source.codingppt'), { mode: 0o700 })
    await writeFile(join(notesDir, 'projects', 'source.codingppt', 'deck.json'), '{"pages":[]}')
    await mkdir(join(notesDir, 'projects', 'existing.codingppt'), { mode: 0o700 })

    await expect(library.renameNote('projects/source.codingppt', 'existing')).rejects.toThrow(NoteConflictError)
    await expect(library.renameNote('projects/source.codingppt', 'project/from')).rejects.toThrow(TypeError)
    expect(await library.renameNote('projects/source.codingppt', 'review')).toEqual({ path: 'projects/review.codingppt' })
    expect(await library.renameNote('projects/review.codingppt', 'final')).toEqual({ path: 'projects/final.codingppt' })
    await expect(library.renameNote('projects/final.codingppt', 'final')).resolves.toEqual({ path: 'projects/final.codingppt' })
    await expect(readFile(join(notesDir, 'projects', 'final.codingppt', 'deck.json'), 'utf8')).resolves.toBe('{"pages":[]}')
    await expect(lstat(join(notesDir, 'projects', 'source.codingppt'))).rejects.toMatchObject({ code: 'ENOENT' })
    const tree = await library.notesTree()
    expect(tree[0]).toMatchObject({ kind: 'dir', path: 'projects' })
    expect(tree[0]?.children?.map(node => `${node.kind}:${node.path}`).sort()).toEqual([
      'deck:projects/existing.codingppt',
      'deck:projects/final.codingppt',
    ])
    await library.deleteNote('projects/final.codingppt')
    await expect(lstat(join(notesDir, 'projects', 'final.codingppt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(notesDir, 'projects', 'existing.codingppt'))).resolves.toBeDefined()
  })

  it('同一队列先改名再删除幻灯片目录，后续操作观察到已发布路径', async () => {
    const { library } = await harness()
    await library.notesTree()
    const notesDir = library.notesRootPath()
    await mkdir(join(notesDir, 'source.codingppt'), { mode: 0o700 })
    await writeFile(join(notesDir, 'source.codingppt', 'deck.json'), '{}')
    const renamed = library.renameNote('source.codingppt', 'renamed')
    const removed = library.deleteNote('renamed.codingppt')
    await expect(renamed).resolves.toEqual({ path: 'renamed.codingppt' })
    await expect(removed).resolves.toBeUndefined()
    await expect(readdir(notesDir)).resolves.toEqual([])
    await expect(library.deleteNote('renamed.codingppt')).rejects.toThrow(NoteNotFoundError)
  })

  it('递归删除多层笔记、其他文件和隐藏条目，保留相邻目录', async () => {
    const { library } = await harness()
    await library.saveNote('archive/deep/note.markdown', '二级笔记')
    await library.saveNote('archive-keep/keep.md', '相邻笔记')
    const notesDir = library.notesRootPath()
    const target = join(notesDir, 'archive')
    const data = join(target, 'deep', 'data.txt')
    await writeFile(data, '非 Markdown 文件')
    await writeFile(join(target, '.DS_Store'), '隐藏文件')
    await mkdir(join(target, '.git'))
    await writeFile(join(target, '.git', 'HEAD'), 'ref: refs/heads/main\n')

    await expect(library.deleteNote('archive/deep/data.txt')).rejects.toThrow(TypeError)
    await expect(readFile(data, 'utf8')).resolves.toBe('非 Markdown 文件')
    await library.deleteNote('archive')
    await expect(readdir(notesDir)).resolves.toEqual(['archive-keep'])
    await expect(library.readNote('archive-keep/keep.md')).resolves.toMatchObject({ content: '相邻笔记' })
  })

  it('删除包含 PPTX 的目录时不越界，不允许对非支持文件单独改名或删除', async () => {
    const { library } = await harness()
    await library.saveNote('archive/deep/draft.md', '内部笔记')
    await library.saveNote('neighbor/keep.md', '邻近笔记')
    const notesDir = library.notesRootPath()
    await writeFile(join(notesDir, 'archive', 'deep', 'source.pptx'), pptxBytes)
    await writeFile(join(notesDir, 'archive', 'deep', 'data.txt'), '内部数据')
    await expect(library.renameNote('archive/deep/data.txt', 'new')).rejects.toThrow(/笔记扩展名无效/)
    await expect(library.deleteNote('archive/deep/data.txt')).rejects.toThrow(/笔记扩展名无效/)
    await library.deleteNote('archive')
    await expect(lstat(join(notesDir, 'archive'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(library.readNote('neighbor/keep.md')).resolves.toMatchObject({ content: '邻近笔记' })
  })

  it('拒绝删除笔记根目录、越界路径和链接目标，递归时不跟随内部链接', async () => {
    const { library } = await harness()
    await library.saveNote('archive/child.md', '内部笔记')
    const notesDir = library.notesRootPath()
    const outside = join(notesDir, '..', 'notes-outside')
    const outsideNote = join(outside, 'sub', 'keep.md')
    await mkdir(join(outside, 'sub'), { recursive: true })
    await writeFile(outsideNote, '外部笔记')
    const link = join(notesDir, 'archive', 'linked')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')

    for (const path of ['', '.', '../notes-outside', outside, 'archive/linked', 'archive/linked/sub']) {
      await expect(library.deleteNote(path), JSON.stringify(path)).rejects.toThrow(TypeError)
    }
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    await expect(library.readNote('archive/child.md')).resolves.toMatchObject({ content: '内部笔记' })
    await library.deleteNote('archive')
    await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(outsideNote, 'utf8')).resolves.toBe('外部笔记')
  })

  it('幻灯片目录拒绝外部父链、条目链接和越界路径；父目录递归删除也不跟随链接', async () => {
    const { library } = await harness()
    await library.notesTree()
    const notesDir = library.notesRootPath()
    const outside = join(notesDir, '..', 'deck-outside')
    await mkdir(join(outside, 'keep.codingppt'), { recursive: true })
    await writeFile(join(outside, 'keep.codingppt', 'deck.json'), '{}')
    await mkdir(join(notesDir, 'folder'))
    const linkedDeck = join(notesDir, 'folder', 'linked.codingppt')
    const linkedFolder = join(notesDir, 'folder', 'linked-folder')
    await symlink(join(outside, 'keep.codingppt'), linkedDeck, process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(outside, linkedFolder, process.platform === 'win32' ? 'junction' : 'dir')
    for (const path of ['folder/linked.codingppt', 'folder/linked-folder/keep.codingppt', '../deck-outside/keep.codingppt']) {
      await expect(library.renameNote(path, 'changed'), path).rejects.toThrow(TypeError)
      await expect(library.deleteNote(path), path).rejects.toThrow(TypeError)
    }
    await library.deleteNote('folder')
    await expect(readFile(join(outside, 'keep.codingppt', 'deck.json'), 'utf8')).resolves.toBe('{}')
  })

  it('带修改时间的迟到保存不会在改名或删除后复活旧路径', async () => {
    const { library } = await harness()
    const created = await library.saveNote('old.md', '旧内容')
    expect(await library.renameNote('old.md', 'new')).toEqual({ path: 'new.md' })
    await expect(library.saveNote('old.md', '迟到内容', created.mtimeMs)).rejects.toThrow(NoteNotFoundError)
    await expect(library.readNote('old.md')).rejects.toThrow(/笔记不存在/)

    const nested = await library.saveNote('stale/note.md', '嵌套内容')
    await library.deleteNote('stale')
    await expect(library.saveNote('stale/note.md', '迟到内容', nested.mtimeMs)).rejects.toThrow(NoteNotFoundError)
    await expect(library.notesTree()).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'stale' }),
    ]))
  })

  it('重命名含 PPTX 的目录后，排队的 Markdown 保存不能重建旧目录', async () => {
    const { library } = await harness()
    const first = await library.saveNote('project/draft.md', '草稿')
    await writeFile(join(library.notesRootPath(), 'project', 'slides.pptx'), pptxBytes)
    const renamed = library.renameNote('project', 'renamed')
    const stale = library.saveNote('project/draft.md', '迟到内容', first.mtimeMs)
    await expect(renamed).resolves.toEqual({ path: 'renamed' })
    await expect(stale).rejects.toThrow(NoteNotFoundError)
    await expect(readFile(join(library.notesRootPath(), 'renamed', 'slides.pptx'))).resolves.toEqual(pptxBytes)
    await expect(lstat(join(library.notesRootPath(), 'project'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('新建笔记补 Markdown 扩展名，同名拒绝', async () => {
    const { library } = await harness()
    expect((await library.createNote('会议纪要')).path).toBe('会议纪要.md')
    expect((await library.createNote('周报.markdown')).path).toBe('周报.markdown')
    expect((await library.createNote('源稿.pptx')).path).toBe('源稿.pptx.md')
    await expect(library.createNote('会议纪要.md')).rejects.toThrow(/笔记已存在/)
    const tree = await library.notesTree()
    expect(tree.map(node => node.path)).toEqual(['会议纪要.md', '周报.markdown', '源稿.pptx.md'])
    await expect(lstat(join(library.notesRootPath(), '源稿.pptx'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(library.readNote('源稿.pptx.md')).resolves.toMatchObject({ content: '' })
  })

  it('新建笔记可带初始原文，超限与非法内容不落盘', async () => {
    const { library } = await harness()
    const notesDir = library.notesRootPath()
    expect((await library.createNote('会议记录', '', '# 会议记录')).path).toBe('会议记录.md')
    await expect(readFile(join(notesDir, '会议记录.md'), 'utf8')).resolves.toBe('# 会议记录')
    expect((await lstat(join(notesDir, '会议记录.md'))).mode & 0o777).toBe(0o600)
    expect((await library.createNote('空稿.md', '', '')).path).toBe('空稿.md')
    await expect(readFile(join(notesDir, '空稿.md'), 'utf8')).resolves.toBe('')
    // 导入超过单篇笔记上限的原文直接拒绝，不留下空文件。
    await expect(library.createNote('大稿', '', 'x'.repeat(1024 * 1024 + 1))).rejects.toThrow(/大小上限/)
    await expect(lstat(join(notesDir, '大稿.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(library.createNote('重复稿', '', '第一版')).resolves.toMatchObject({ path: '重复稿.md' })
    await expect(library.createNote('重复稿', '', '第二版')).rejects.toThrow(/笔记已存在/)
    await expect(readFile(join(notesDir, '重复稿.md'), 'utf8')).resolves.toBe('第一版')
  })

  it('Host-only 幻灯片目录 seam 独占创建并拒绝错误名称、重复与链接路径', async () => {
    const { library } = await harness()
    await library.notesTree()
    const notesDir = library.notesRootPath()
    const created = await library.createNoteDeck('演示稿')
    expect(created).toMatchObject({ path: '演示稿.codingppt' })
    const info = await lstat(join(notesDir, '演示稿.codingppt'))
    expect(info.isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o700)
    await expect(library.createNoteDeck('演示稿', '')).rejects.toThrow(/幻灯片已存在/)
    await expect(library.createNoteDeck('演示稿.codingppt')).rejects.toThrow(/幻灯片已存在/)
    await expect(library.createNoteDeck('   ')).rejects.toThrow(/文件名无效/)

    await library.createNoteDirectory('project')
    await expect(library.createNoteDeck('nested', 'project')).resolves.toMatchObject({ path: 'project/nested.codingppt' })
    await expect(library.createNoteDeck('越界', '../')).rejects.toThrow(TypeError)

    const outside = join(notesDir, '..', 'deck-seam-outside')
    await mkdir(outside)
    const linkedDirectory = join(notesDir, 'linked')
    await symlink(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(library.createNoteDeck('escape', 'linked')).rejects.toThrow(TypeError)
    await expect(lstat(join(outside, 'escape.codingppt'))).rejects.toMatchObject({ code: 'ENOENT' })

    // 清理句柄删除的是本次创建的目录本身，包含随后写入的工程文件。
    await writeFile(join(notesDir, '演示稿.codingppt', 'deck.json'), '{}')
    await created.remove()
    await expect(lstat(join(notesDir, '演示稿.codingppt'))).rejects.toMatchObject({ code: 'ENOENT' })
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
    await mkdir(join(notesDir, 'archive', 'other.codingppt'), { recursive: true, mode: 0o700 })
    await writeFile(join(notesDir, 'root.pptx'), pptxBytes)
    // 幻灯片工程目录只作为一行 deck 出现，单文件幻灯片根本不入树；两者都不进入文件管理的笔记列表。
    const archive = (await library.notesTree()).find(node => node.path === 'archive')
    expect(archive?.children?.map(node => `${node.kind}:${node.path}`).sort()).toEqual([
      'deck:archive/other.codingppt',
      'file:archive/old.md',
    ])
    expect((await library.noteRecords()).map(row => row.name)).toEqual(['root.md'])
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
    await writeFile(join(notesDir, 'serve.pptx'), pptxBytes)
    expect(await library.noteRecords()).toHaveLength(1)
    const record = (await library.noteRecords())[0]
    expect(record!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    const served = await library.read(record!.id)
    expect(served!.record).toEqual(record)
    expect(Buffer.from(served!.data).toString('utf8')).toBe('可服务的内容')
    // 同一相对路径重复调用仍映射同一 id，且登记后不重复出现在实时记录。
    expect((await library.noteRecords()).map(row => row.id)).toEqual([record!.id])
  })
})
