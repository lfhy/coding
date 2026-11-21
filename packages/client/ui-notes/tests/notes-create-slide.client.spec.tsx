// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector } from 'coding-client-test-runtime'
import type { NotesPageProps } from '../src/client/NotesPage.tsx'
import { NotesPage } from '../src/client/NotesPage.tsx'
import { zh } from '../src/client/locales.ts'
import { createNotesUiStore } from '../src/client/notes-ui-store.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('NotesPage 新建幻灯片', () => {
  it('从页头新建菜单创建幻灯片工程目录，并选中新文件标签', async () => {
    vi.useFakeTimers()
    const store = createNotesUiStore().create('s-notes')
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
    const props = {
      closePage: vi.fn(),
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
    render(<NotesPage {...props} />)
    await act(async () => {})

    const directory = screen.getByRole('complementary', { name: '笔记目录' })
    const trigger = within(directory).getByRole('button', { name: '新建笔记' })
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: '新建幻灯片' })).toBeTruthy()
    fireEvent.click(within(menu).getByRole('menuitem', { name: '新建幻灯片' }))

    const dialog = screen.getByRole('dialog', { name: '新建幻灯片' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '幻灯片名称' }), { target: { value: '季度汇报' } })
    await act(async () => { fireEvent.submit(dialog.querySelector('form')!) })

    expect(store.getSnapshot().activePath).toBe('季度汇报.codingppt')
    expect(within(screen.getByRole('tablist', { name: '打开的笔记' })).getByRole('tab', { name: '季度汇报' })
      .getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe('幻灯片已创建')
    expect(document.activeElement).toBe(trigger)
  })

  it('从页头菜单导入本机 pptx，成功后打开同名工程目录', async () => {
    vi.useFakeTimers()
    const store = createNotesUiStore().create('s-notes')
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
    const props = {
      closePage: vi.fn(),
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

    const directory = screen.getByRole('complementary', { name: '笔记目录' })
    fireEvent.click(within(directory).getByRole('button', { name: '新建笔记' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '导入文件' }))

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    if (input === null) throw new Error('缺少导入文件选择器')
    const file = new File([new Uint8Array([0x50, 0x4b])], '外部稿.pptx')
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })

    expect(uploads).toEqual([{ query: '?sessionId=s-notes&name=%E5%A4%96%E9%83%A8%E7%A8%BF', body: file }])
    expect(store.getSnapshot().activePath).toBe('外部稿.codingppt')
    expect(screen.getByText('演示文稿 外部稿.codingppt')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('幻灯片已导入')
  })

  it('导入失败时保留欢迎页并提示原因', async () => {
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

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    if (input === null) throw new Error('缺少导入文件选择器')
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], '坏稿.pptx')] } })
    })
    expect(store.getSnapshot().activePath ?? null).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('无法导入该文件。请确认是有效的 Markdown（不超过 1 MiB）或 .pptx。')
  })

  it('导入 Markdown 时把原文一起写入笔记目录并打开新笔记', async () => {
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
        bodies.push(JSON.parse(init.body))
        tree = [{ name: '会议记录.md', kind: 'file', path: '会议记录.md', mtimeMs: 2_000 }]
        return Response.json({ path: '会议记录.md' })
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

    const directory = screen.getByRole('complementary', { name: '笔记目录' })
    fireEvent.click(within(directory).getByRole('button', { name: '新建笔记' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '导入文件' }))
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    if (input === null) throw new Error('缺少导入文件选择器')
    expect(input.accept).toBe('.md,.markdown,.pptx')
    const file = new File(['# 会议记录'], '会议记录.md', { type: 'text/markdown' })
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })

    expect(bodies).toEqual([{ name: '会议记录', content: '# 会议记录' }])
    expect(store.getSnapshot().activePath).toBe('会议记录.md')
    expect(screen.getByRole('alert').textContent).toBe('笔记已导入')
  })

  it('拒绝不支持的扩展名与超限的 Markdown，不发出导入请求', async () => {
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

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    if (input === null) throw new Error('缺少导入文件选择器')
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['data'], '表格.csv')] } })
    })
    expect(screen.getByRole('alert').textContent).toBe('无法导入该文件。请确认是有效的 Markdown（不超过 1 MiB）或 .pptx。')
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([new Uint8Array(1024 * 1024 + 1)], '大稿.md')] } })
    })
    expect(requests.filter(path => path === '/api/notes/create')).toHaveLength(0)
  })
})
