import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createProject, editProject, listProjects, loadProject, redoProject, resolveProjectDir,
  undoProject, PptStoreError,
} from '../src/store.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ppt-store-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('工程存储', () => {
  it('新建工程写入标题页并可再次读取', async () => {
    const dir = join(root, 'ppt', 'quarterly')
    const created = await createProject(dir, { title: '季度汇报' })
    expect(created.revision).toBe(1)
    expect(created.deck.pages).toHaveLength(1)
    expect(created.deck.pages[0]?.elements[0]).toMatchObject({ kind: 'text' })
    expect(created.canUndo).toBe(false)

    const loaded = await loadProject(dir)
    expect(loaded.title).toBe('季度汇报')
    expect(loaded.revision).toBe(1)
    expect(loaded.deck.size).toBe('16:9')
  })

  it('拒绝覆盖已有工程', async () => {
    const dir = join(root, 'ppt', 'deck')
    await createProject(dir, { title: '一版' })
    await expect(createProject(dir, { title: '二版' })).rejects.toBeInstanceOf(PptStoreError)
  })

  it('编辑递增版本并保留撤销历史', async () => {
    const dir = join(root, 'ppt', 'deck')
    await createProject(dir, { title: '版本' })
    const page = (await loadProject(dir)).deck.pages[0]?.id ?? ''

    const second = await editProject(dir, [{ op: 'add_page' }])
    expect(second.revision).toBe(2)
    expect(second.deck.pages).toHaveLength(2)
    expect(second.canUndo).toBe(true)

    const third = await editProject(dir, [{
      op: 'update_page', page, name: '封面页',
    }], 2)
    expect(third.revision).toBe(3)
    expect(third.deck.pages[0]?.name).toBe('封面页')

    const undone = await undoProject(dir, 1)
    expect(undone.revision).toBe(2)
    expect(undone.deck.pages[0]?.name).toBe('封面')

    const redone = await redoProject(dir, 1)
    expect(redone.revision).toBe(3)
    expect(redone.deck.pages[0]?.name).toBe('封面页')
  })

  it('撤销到底与重做到顶都明确报错', async () => {
    const dir = join(root, 'ppt', 'deck')
    await createProject(dir, { title: '边界' })
    await expect(undoProject(dir, 1)).rejects.toMatchObject({ code: 'conflict' })
    await expect(redoProject(dir, 1)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('基准版本过期时拒绝写入且不改动工程', async () => {
    const dir = join(root, 'ppt', 'deck')
    await createProject(dir, { title: '冲突' })
    await editProject(dir, [{ op: 'add_page' }])
    await expect(editProject(dir, [{ op: 'add_page' }], 1)).rejects.toMatchObject({ code: 'conflict' })
    expect((await loadProject(dir)).revision).toBe(2)
  })

  it('非法 ops 不产生新版本', async () => {
    const dir = join(root, 'ppt', 'deck')
    await createProject(dir, { title: '校验' })
    await editProject(dir, [{ op: 'add_page' }])
    await expect(editProject(dir, [{ op: 'remove_page', page: 'missing' }]))
      .rejects.toThrow(/找不到页面/u)
    expect((await loadProject(dir)).revision).toBe(2)
  })

  it('列表只返回工作区内的合法工程', async () => {
    await createProject(join(root, 'ppt', 'a'), { title: '甲' })
    await createProject(join(root, 'ppt', 'b'), { title: '乙' })
    const broken = join(root, 'ppt', 'broken')
    await createProject(broken, { title: '坏' })
    await writeFile(join(broken, 'deck.json'), '{oops', 'utf8')

    const projects = await listProjects(root)
    expect(projects.map(project => project.title).sort()).toEqual(['乙', '甲'])
    expect(projects[0]?.dir.startsWith('ppt/')).toBe(true)
  })

  it('工程目录不能越出工作区', () => {
    expect(() => resolveProjectDir(root, '../outside')).toThrow(PptStoreError)
    expect(resolveProjectDir(root, 'ppt/demo')).toBe(join(root, 'ppt', 'demo'))
  })

  it('历史裁剪后仍可撤销最近一步', async () => {
    const dir = join(root, 'ppt', 'deck')
    await createProject(dir, { title: '长历史' })
    for (let index = 0; index < 70; index += 1) await editProject(dir, [{ op: 'add_page' }])
    const snapshot = await loadProject(dir)
    expect(snapshot.revision).toBe(71)
    const undone = await undoProject(dir, 1)
    expect(undone.deck.pages.length).toBe(snapshot.deck.pages.length - 1)
  })
})
