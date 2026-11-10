import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createProject, editProject, listProjects, loadProject, redoProject, resolveProjectDir,
  undoProject, writeProjectMedia, PptStoreError,
} from '../src/store.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ppt-store-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('工程存储', () => {
  it('媒体仅写入存在工程且格式、签名与大小合规的图片', async () => {
    const dir = join(root, 'ppt', 'images')
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
    await expect(writeProjectMedia(root, dir, 'illustration.png', png)).rejects.toMatchObject({ code: 'not-found' })
    await createProject(dir, { title: '配图' })
    const source = await writeProjectMedia(root, dir, 'illustration.png', png)
    expect(source).toMatch(/^media\/up-[\w-]+\.png$/u)
    expect(await readFile(join(dir, source))).toEqual(Buffer.from(png))
    expect((await loadProject(dir)).revision).toBe(1)
    await expect(writeProjectMedia(root, dir, 'illustration.jpg', png)).rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeProjectMedia(root, dir, 'illustration.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))
      .rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeProjectMedia(root, dir, 'illustration.bin', png)).rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeProjectMedia(root, dir, 'illustration.png', new Uint8Array(0)))
      .rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeProjectMedia(root, dir, 'illustration.png', new Uint8Array(8 * 1024 * 1024 + 1)))
      .rejects.toMatchObject({ code: 'bad-request' })
  })

  it('媒体写入拒绝工作区外目录、链接工程和已有的链接媒体目录', async () => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
    const outside = await mkdtemp(join(tmpdir(), 'ppt-media-outside-'))
    try {
      const dir = join(root, 'ppt', 'images')
      await createProject(dir, { title: '配图' })
      await expect(writeProjectMedia(root, outside, 'image.png', png)).rejects.toMatchObject({ code: 'forbidden' })
      await symlink(outside, join(dir, 'media'))
      await expect(writeProjectMedia(root, dir, 'image.png', png)).rejects.toMatchObject({ code: 'forbidden' })
      await rm(join(dir, 'media'))
      await symlink(dir, join(root, 'ppt', 'linked'))
      await expect(writeProjectMedia(root, join(root, 'ppt', 'linked'), 'image.png', png))
        .rejects.toMatchObject({ code: 'forbidden' })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

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

  it('表格逐格编辑允许清空单元格，仍保留其它内容且按版本拒绝冲突', async () => {
    const dir = join(root, 'ppt', 'table-edit')
    const created = await createProject(dir, { title: '数据' })
    const page = created.deck.pages[0]?.id ?? ''
    const withTable = await editProject(dir, [{
      op: 'add_element', page, element: {
        kind: 'table', x: 100, y: 100, w: 400, h: 200, rows: 2, columns: 2,
        cells: [[{ content: '项目' }, { content: '状态' }], [{ content: '旧值' }, { content: '完成' }]],
      },
    }], created.revision)
    const table = withTable.deck.pages[0]?.elements.find(element => element.kind === 'table')
    if (table?.kind !== 'table') throw new Error('表格未创建')
    const edited = await editProject(dir, [{ op: 'update_element', page, element: table.id,
      cells: [[{ content: '项目' }, { content: '状态' }], [{ content: '' }, { content: '完成' }]],
    }], withTable.revision)
    expect(edited.deck.pages[0]?.elements.find(element => element.id === table.id))
      .toMatchObject({ cells: [[{ content: '项目' }, { content: '状态' }], [{ content: '' }, { content: '完成' }]] })
    await expect(editProject(dir, [{ op: 'update_element', page, element: table.id,
      cells: [[{ content: '项目' }, {}], [{ content: '' }, { content: '完成' }]],
    }], edited.revision)).rejects.toThrow(/content/u)
    expect((await loadProject(dir)).revision).toBe(edited.revision)
    await expect(editProject(dir, [{ op: 'update_element', page, element: table.id,
      cells: [[{ content: '覆盖' }, { content: '' }], [{ content: '' }, { content: '' }]],
    }], withTable.revision)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('一次替换截图占位框及覆盖文字，保留层级与几何并可撤销', async () => {
    const dir = join(root, 'ppt', 'image-placeholder')
    const created = await createProject(dir, { title: '占位图' })
    const page = created.deck.pages[0]!.id
    const seeded = await editProject(dir, [
      { op: 'add_element', page, element: { id: 'frame', kind: 'rect', x: 96, y: 188, w: 254, h: 143, fill: '#e8e5dc' } },
      { op: 'add_element', page, element: { id: 'label', kind: 'text', x: 96, y: 188, w: 254, h: 143,
        text: { content: '代码截图', size: 14, color: '#75736c', align: 'center', valign: 'middle' } } },
      { op: 'add_element', page, element: { id: 'footer', kind: 'text', x: 96, y: 500, w: 254, h: 30,
        text: { content: '保留的正文', size: 18, color: '#333333' } } },
    ], created.revision)
    const before = seeded.deck.pages[0]!.elements
    const index = before.findIndex(element => element.id === 'frame')
    await expect(editProject(dir, [{ op: 'replace_image', page, element: 'frame', label: 'footer',
      source: 'media/shot.png' }], seeded.revision)).rejects.toThrow(/占位文字/u)
    await expect(editProject(dir, [{ op: 'replace_image', page, element: 'footer',
      source: 'media/shot.png' }], seeded.revision)).rejects.toThrow(/只能替换/u)
    await expect(editProject(dir, [{ op: 'replace_image', page, element: 'frame',
      source: '../invalid.png' }], seeded.revision)).rejects.toThrow(/media\//u)
    expect((await loadProject(dir)).revision).toBe(seeded.revision)
    const replaced = await editProject(dir, [{ op: 'replace_image', page, element: 'frame', label: 'label',
      source: 'media/shot.png' }], seeded.revision)
    const elements = replaced.deck.pages[0]!.elements
    expect(elements[index]).toMatchObject({ id: 'frame', kind: 'image', x: 96, y: 188, w: 254, h: 143,
      source: 'media/shot.png', fit: 'cover' })
    expect(elements.map(element => element.id)).toEqual(before.filter(element => element.id !== 'label').map(element => element.id))
    const undone = await undoProject(dir, 1)
    expect(undone.revision).toBe(seeded.revision)
    expect(undone.deck.pages[0]!.elements).toEqual(before)
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

  it('按模板加页会铺好元素并写上页名', async () => {
    const dir = join(root, 'ppt', 'tpl')
    await createProject(dir, { title: '模板' })
    const edited = await editProject(dir, [{
      op: 'add_page', template: 'chart', title: '营收趋势',
    }])
    const page = edited.deck.pages[1]
    expect(page?.name).toBe('图表页')
    expect(page?.elements.some(element => element.kind === 'chart')).toBe(true)
    const bullets = await editProject(dir, [{
      op: 'add_page', template: 'bullets', bullets: ['甲', '乙'],
    }])
    const contents = (bullets.deck.pages[2]?.elements ?? [])
      .flatMap(element => (element.kind === 'text' ? [element.text.content] : []))
    expect(contents.some(content => content.includes('· 甲'))).toBe(true)
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
