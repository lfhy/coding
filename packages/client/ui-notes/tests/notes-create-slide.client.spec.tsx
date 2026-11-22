// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector } from 'coding-client-test-runtime'
import type { NotesPageProps } from '../src/client/NotesPage.tsx'
import { NotesPage } from '../src/client/NotesPage.tsx'
import { zh } from '../src/client/locales.ts'
import { createNotesUiStore } from '../src/client/notes-ui-store.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

/** 直接挂载笔记页，保留真实的菜单组件和会话内标签状态。 */
async function mountNotes() {
  vi.useFakeTimers()
  const store = createNotesUiStore().create('s-notes')
  const closePage = vi.fn()
  const props = {
    closePage,
    t: (key: keyof typeof zh, params?: { name: string }) => params === undefined ? zh[key] : zh[key].replace('{name}', params.name),
    sidebarCollapsed: false,
    sidebarWidth: 280,
    assistantOpen: false,
    assistantPanelId: 'note-assistant',
    toggleAssistant: vi.fn(),
    sessionId: 's-notes',
    renderSlot: (_key: string, owner: { path: string }) => <div>演示文稿 {owner.path}</div>,
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
  } as unknown as NotesPageProps
  const { container } = render(<NotesPage {...props} />)
  await act(async () => {})
  return { closePage, container, store }
}

/** 打开页头加号，调用者可继续操作一级菜单项。 */
function openLauncher() {
  const directory = screen.getByRole('complementary', { name: '笔记目录' })
  const trigger = within(directory).getByRole('button', { name: '新建' })
  fireEvent.click(trigger)
  return { trigger, menu: screen.getByRole('menu') }
}

/** 通过指定分组选择同名类型，区分新建和导入的「幻灯片」。 */
function chooseLauncherType(group: '新建' | '导入', name: '幻灯片' | '文本') {
  const { trigger, menu } = openLauncher()
  fireEvent.click(within(menu).getByRole('menuitem', { name: group }), { detail: 1 })
  const submenu = screen.getByRole('menu', { name: group })
  fireEvent.click(within(submenu).getByRole('menuitem', { name }), { detail: 1 })
  return trigger
}

describe('NotesPage 加号菜单', () => {
  it('只显示新建和导入两组，悬停显示各自有序的子项', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ children: [] })))
    await mountNotes()
    const { trigger, menu } = openLauncher()
    expect(trigger.getAttribute('aria-label')).toBe('新建')
    expect(trigger.getAttribute('title')).toBe('新建')
    const create = within(menu).getByRole('menuitem', { name: '新建' })
    const importEntry = within(menu).getByRole('menuitem', { name: '导入' })
    expect(within(menu).getAllByRole('menuitem')).toEqual([create, importEntry])
    expect(screen.getAllByRole('menu')).toEqual([menu])
    expect(create.getAttribute('aria-expanded')).toBe('false')
    expect(importEntry.getAttribute('aria-expanded')).toBe('false')

    fireEvent.mouseEnter(importEntry)
    const importMenu = within(screen.getByRole('menu', { name: '导入' }))
    expect(importMenu.getAllByRole('menuitem')).toEqual(['文本', '幻灯片'].map(name =>
      importMenu.getByRole('menuitem', { name })))

    fireEvent.mouseEnter(create)
    expect(screen.queryByRole('menu', { name: '导入' })).toBeNull()
    const submenu = screen.getByRole('menu', { name: '新建' })
    expect(create.getAttribute('aria-expanded')).toBe('true')
    expect(submenu.getAttribute('aria-labelledby')).toBe(create.id)
    const types = within(submenu)
    const folder = types.getByRole('menuitem', { name: '目录' })
    expect(types.getAllByRole('menuitem')).toEqual([
      folder,
      types.getByRole('menuitem', { name: '笔记' }),
      types.getByRole('menuitem', { name: '幻灯片' }),
    ])
    fireEvent.click(folder, { detail: 1 })
    const dialog = screen.getByRole('dialog', { name: '新建目录' })
    expect(within(dialog).getByRole('button', { name: '保存到 全部笔记' })).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('方向键在同一级移动；左键或 Escape 返回，第二次 Escape 关闭菜单', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ children: [] })))
    const { closePage } = await mountNotes()
    const { trigger, menu } = openLauncher()
    const create = within(menu).getByRole('menuitem', { name: '新建' })
    const importEntry = within(menu).getByRole('menuitem', { name: '导入' })
    expect(document.activeElement).toBe(create)
    fireEvent.keyDown(create, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(importEntry)
    fireEvent.keyDown(importEntry, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(create)
    expect(screen.getAllByRole('menu')).toEqual([menu])

    fireEvent.keyDown(create, { key: 'ArrowRight' })
    const submenu = screen.getByRole('menu', { name: '新建' })
    const folder = within(submenu).getByRole('menuitem', { name: '目录' })
    const note = within(submenu).getByRole('menuitem', { name: '笔记' })
    const presentation = within(submenu).getByRole('menuitem', { name: '幻灯片' })
    expect(document.activeElement).toBe(folder)
    fireEvent.keyDown(folder, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(note)
    fireEvent.keyDown(note, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(presentation)
    fireEvent.keyDown(presentation, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(note)
    fireEvent.keyDown(note, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(create)
    expect(screen.getAllByRole('menu')).toEqual([menu])

    fireEvent.keyDown(create, { key: 'ArrowRight' })
    const firstItem = within(screen.getByRole('menu', { name: '新建' })).getByRole('menuitem', { name: '目录' })
    expect(document.activeElement).toBe(firstItem)
    fireEvent.keyDown(firstItem, { key: 'Escape' })
    expect(document.activeElement).toBe(create)
    expect(screen.getAllByRole('menu')).toEqual([menu])
    await act(async () => { fireEvent.keyDown(create, { key: 'Escape' }) })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(closePage).not.toHaveBeenCalled()
  })
})

describe('NotesPage 幻灯片和文本导入', () => {
  it('从页头新建菜单创建幻灯片工程目录，并选中新文件标签', async () => {
    let tree: { name: string; kind: 'deck'; path: string; mtimeMs: number }[] = []
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/notes/tree') return Response.json({ children: tree })
      if (url.pathname === '/api/notes/tabs') return Response.json({ ok: true })
      if (url.pathname === '/api/ppt/notes/create') {
        expect(init?.method).toBe('POST')
        if (typeof init?.body !== 'string') throw new Error('预期新建幻灯片请求包含 JSON 正文')
        expect(JSON.parse(init.body)).toEqual({ sessionId: 's-notes', name: '季度汇报' })
        tree = [{ name: '季度汇报.codingppt', kind: 'deck', path: '季度汇报.codingppt', mtimeMs: 2_000 }]
        return Response.json({ ok: true, dir: '季度汇报.codingppt' })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { store } = await mountNotes()
    const trigger = chooseLauncherType('新建', '幻灯片')

    const dialog = screen.getByRole('dialog', { name: '新建幻灯片' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '幻灯片名称' }), { target: { value: '季度汇报' } })
    await act(async () => { fireEvent.submit(dialog.querySelector('form')!) })

    expect(store.getSnapshot().activePath).toBe('季度汇报.codingppt')
    expect(within(screen.getByRole('tablist', { name: '打开的笔记' })).getByRole('tab', { name: '季度汇报' })
      .getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe('幻灯片已创建')
    expect(document.activeElement).toBe(trigger)
  })

  it('导入子菜单选「幻灯片」后上传 .pptx，成功后打开同名工程目录', async () => {
    let tree: { name: string; kind: 'deck'; path: string; mtimeMs: number }[] = []
    const uploads: unknown[] = []
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/notes/tree') return Response.json({ children: tree })
      if (url.pathname === '/api/notes/tabs') return Response.json({ ok: true })
      if (url.pathname === '/api/ppt/notes/import') {
        // 幻灯片按原始字节上传；名称走 query，不经过 JSON 或 base64。
        uploads.push({ query: url.search, body: init?.body })
        tree = [{ name: '外部稿.codingppt', kind: 'deck', path: '外部稿.codingppt', mtimeMs: 2_000 }]
        return Response.json({ ok: true, dir: '外部稿.codingppt' })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container, store } = await mountNotes()
    chooseLauncherType('导入', '幻灯片')

    const input = container.querySelector<HTMLInputElement>('input[accept=".pptx"]')
    if (input === null) throw new Error('缺少幻灯片导入选择器')
    const file = new File([new Uint8Array([0x50, 0x4b])], '外部稿.pptx')
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })

    expect(uploads).toEqual([{ query: '?sessionId=s-notes&name=%E5%A4%96%E9%83%A8%E7%A8%BF', body: file }])
    expect(store.getSnapshot().activePath).toBe('外部稿.codingppt')
    expect(screen.getByText('演示文稿 外部稿.codingppt')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('幻灯片已导入')
  })

  it('幻灯片导入失败时保留欢迎页并提示', async () => {
    vi.useFakeTimers()
    const store = createNotesUiStore().create('s-notes')
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/notes/tree') return Response.json({ children: [] })
      if (url.pathname === '/api/notes/tabs') return Response.json({ ok: true })
      if (url.pathname === '/api/ppt/notes/import') return new Response('bad', { status: 400 })
      throw new Error(`unexpected request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const props = {
      closePage: vi.fn(),
      t: (key: keyof typeof zh, params?: { name: string }) => params === undefined ? zh[key] : zh[key].replace('{name}', params.name),
      sidebarCollapsed: false,
      sidebarWidth: 280,
      assistantOpen: false,
      assistantPanelId: 'note-assistant',
      toggleAssistant: vi.fn(),
      sessionId: 's-notes',
      renderSlot: () => <div>演示文稿</div>,
      useStore: bindSnapshotSelector(store),
      actions: store.actions,
    } as unknown as NotesPageProps
    const { container } = render(<NotesPage {...props} />)
    await act(async () => {})

    const input = container.querySelector<HTMLInputElement>('input[accept=".pptx"]')
    if (input === null) throw new Error('缺少幻灯片导入选择器')
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], '坏稿.pptx')] } })
    })
    expect(store.getSnapshot().activePath ?? null).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('无法导入该幻灯片。请确认文件是有效的 .pptx。')
  })

  it('导入子菜单选「文本」时 Markdown 与 TXT 都写成带原文的笔记', async () => {
    vi.useFakeTimers()
    const store = createNotesUiStore().create('s-notes')
    let tree: { name: string; kind: 'file'; path: string; mtimeMs: number }[] = []
    const bodies: unknown[] = []
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/notes/tree') return Response.json({ children: tree })
      if (url.pathname === '/api/notes/tabs') return Response.json({ ok: true })
      if (url.pathname === '/api/notes/create') {
        if (typeof init?.body !== 'string') throw new Error('预期新建请求包含 JSON 正文')
        const body = JSON.parse(init.body) as { name: string; content: string }
        bodies.push(body)
        const path = `${body.name}.md`
        tree = [{ name: path, kind: 'file', path, mtimeMs: 2_000 }]
        return Response.json({ path })
      }
      if (url.pathname === '/api/notes/read') {
        return Response.json({ path: '会议记录.md', content: '# 会议记录', mtimeMs: 2_000 })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const props = {
      closePage: vi.fn(),
      t: (key: keyof typeof zh, params?: { name: string }) => params === undefined ? zh[key] : zh[key].replace('{name}', params.name),
      sidebarCollapsed: false,
      sidebarWidth: 280,
      assistantOpen: false,
      assistantPanelId: 'note-assistant',
      toggleAssistant: vi.fn(),
      sessionId: 's-notes',
      renderSlot: () => <div>演示文稿</div>,
      useStore: bindSnapshotSelector(store),
      actions: store.actions,
    } as unknown as NotesPageProps
    const { container } = render(<NotesPage {...props} />)
    await act(async () => {})

    chooseLauncherType('导入', '文本')
    const input = container.querySelector<HTMLInputElement>('input[accept=".md,.markdown,.txt"]')
    if (input === null) throw new Error('缺少文本导入选择器')
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['# 会议记录'], '会议记录.md', { type: 'text/markdown' })] } })
    })
    expect(store.getSnapshot().activePath).toBe('会议记录.md')
    expect(screen.getByRole('alert').textContent).toBe('笔记已导入')

    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['纯文本内容'], '随手记.txt', { type: 'text/plain' })] } })
    })
    expect(bodies).toEqual([
      { name: '会议记录', content: '# 会议记录' },
      { name: '随手记', content: '纯文本内容' },
    ])
  })

  it('文本导入拒绝不支持的扩展名与超限文件，不发请求', async () => {
    vi.useFakeTimers()
    const store = createNotesUiStore().create('s-notes')
    const requests: string[] = []
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input), 'http://localhost')
      requests.push(url.pathname)
      if (url.pathname === '/api/notes/tree') return Response.json({ children: [] })
      if (url.pathname === '/api/notes/tabs') return Response.json({ ok: true })
      throw new Error(`unexpected request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const props = {
      closePage: vi.fn(),
      t: (key: keyof typeof zh, params?: { name: string }) => params === undefined ? zh[key] : zh[key].replace('{name}', params.name),
      sidebarCollapsed: false,
      sidebarWidth: 280,
      assistantOpen: false,
      assistantPanelId: 'note-assistant',
      toggleAssistant: vi.fn(),
      sessionId: 's-notes',
      renderSlot: () => <div>演示文稿</div>,
      useStore: bindSnapshotSelector(store),
      actions: store.actions,
    } as unknown as NotesPageProps
    const { container } = render(<NotesPage {...props} />)
    await act(async () => {})

    const input = container.querySelector<HTMLInputElement>('input[accept=".md,.markdown,.txt"]')
    if (input === null) throw new Error('缺少文本导入选择器')
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['data'], '表格.csv')] } })
    })
    expect(screen.getByRole('alert').textContent).toBe('无法导入该文本。请确认是 UTF-8 编码的 Markdown 或 TXT，且不超过 1 MiB。')
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([new Uint8Array(1024 * 1024 + 1)], '大稿.md')] } })
    })
    expect(requests.filter(path => path === '/api/notes/create')).toHaveLength(0)
  })
})
