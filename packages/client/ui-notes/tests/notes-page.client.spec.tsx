// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { NotesPageProps } from '../src/client/NotesPage.tsx'
import { NotesPage } from '../src/client/NotesPage.tsx'
import { zh } from '../src/client/locales.ts'

interface ServerNote { content: string; mtimeMs: number }
interface TreeNode { name: string; kind: 'dir' | 'file'; path: string; mtimeMs: number; children?: TreeNode[] }

function requestJson(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') throw new Error('预期请求包含 JSON 正文')
  return JSON.parse(init.body) as unknown
}

function makeServer() {
  const state = {
    tree: [
      { name: 'a.md', kind: 'file', path: 'a.md', mtimeMs: 1000 },
      { name: 'd', kind: 'dir', path: 'd', mtimeMs: 900, children: [{ name: 'b.md', kind: 'file', path: 'd/b.md', mtimeMs: 800 }] },
    ] as TreeNode[],
    files: new Map<string, ServerNote>([
      ['a.md', { content: 'hello a', mtimeMs: 1000 }],
      ['d/b.md', { content: 'hello b', mtimeMs: 800 }],
    ]),
    saveCalls: [] as { path: string; content: string; baseMtimeMs?: number }[],
    conflictNext: false,
    failSave: false,
    saveDelay: undefined as Promise<undefined> | undefined,
    createFail: false,
    treeVersions: [] as TreeNode[][],
  }
  const route = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/notes/tree') {
      const next = state.treeVersions.shift() ?? state.tree
      return Response.json({ children: next })
    }
    if (url.pathname === '/api/notes/read') {
      const path = url.searchParams.get('path') ?? ''
      const entry = state.files.get(path)
      if (entry === undefined) return new Response('missing', { status: 404 })
      return Response.json({ path, content: entry.content, mtimeMs: entry.mtimeMs })
    }
    if (url.pathname === '/api/notes/save') {
      const body = requestJson(init) as { path: string; content: string; baseMtimeMs?: number }
      state.saveCalls.push(body)
      await state.saveDelay
      if (state.conflictNext) { state.conflictNext = false; return new Response('stale', { status: 409 }) }
      if (state.failSave) return new Response('boom', { status: 500 })
      const entry = state.files.get(body.path)
      if (entry === undefined) return new Response('missing', { status: 404 })
      if (body.baseMtimeMs !== entry.mtimeMs) return new Response('stale', { status: 409 })
      entry.content = body.content
      entry.mtimeMs = 2000
      const node = state.tree.find(item => item.path === body.path)
      if (node !== undefined) node.mtimeMs = 2000
      return Response.json({ path: body.path, mtimeMs: 2000 })
    }
    if (url.pathname === '/api/notes/create') {
      if (state.createFail) return new Response('boom', { status: 500 })
      const body = requestJson(init) as { name: string }
      const path = `${body.name}.md`
      state.files.set(path, { content: '', mtimeMs: 3000 })
      state.tree.unshift({ name: body.name, kind: 'file', path, mtimeMs: 3000 })
      return Response.json({ path })
    }
    if (url.pathname === '/api/notes/rename') {
      const body = requestJson(init) as { path: string; name: string }
      const entry = state.files.get(body.path)
      if (entry === undefined) return new Response('missing', { status: 404 })
      const path = body.name.includes('.') ? body.name : `${body.name}.md`
      state.files.set(path, entry)
      state.files.delete(body.path)
      state.tree = state.tree.map(node => node.path === body.path
        ? { ...node, name: body.name, path } : node)
      return Response.json({ path })
    }
    if (url.pathname === '/api/notes/delete') {
      const body = requestJson(init) as { path: string }
      state.files.delete(body.path)
      state.tree = state.tree.filter(node => node.path !== body.path)
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }
  vi.stubGlobal('fetch', vi.fn(route))
  return state
}

const closePage = vi.fn()
const toggleAssistant = vi.fn()
const props = {
  closePage,
  t: (key: keyof typeof zh) => zh[key],
  sidebarCollapsed: false,
  sidebarWidth: 280,
  assistantOpen: false,
  assistantPanelId: 'note-assistant',
  toggleAssistant,
} as unknown as NotesPageProps

async function mount(overrides?: Partial<NotesPageProps>) {
  const view = render(<NotesPage {...props} {...overrides} />)
  await act(async () => {})
  return view
}

const saveState = () => screen.getByRole('status')
const directory = () => screen.getByRole('complementary', { name: '笔记目录' })
const treeRow = (name: string) => within(directory()).getByTitle(name)
const createTrigger = () => within(directory()).getByRole('button', { name: '新建笔记' })
const confirmReload = async () => {
  fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '舍弃并重新加载' })) })
}

describe('NotesPage', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks() })

  it('加载目录树并选中第一篇笔记，编辑与预览同源', async () => {
    makeServer()
    await mount()
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    expect((editor as HTMLTextAreaElement).value).toBe('hello a')
    const preview = screen.getByRole('region', { name: '预览' })
    expect(preview.textContent).toContain('hello a')
    expect(screen.getByRole('heading', { name: 'a' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '预览' })).toBeNull()
    expect(saveState().textContent).toBe('已保存')
    expect(screen.getByRole('button', { name: '并排' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('右键笔记可重命名和删除，目录行不显示类型副标题', async () => {
    makeServer()
    await mount()
    const row = treeRow('a')
    fireEvent.contextMenu(row)
    expect(screen.getByRole('menuitem', { name: '重命名' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const input = screen.getByRole('textbox', { name: '笔记名称' })
    fireEvent.change(input, { target: { value: 'renamed' } })
    await act(async () => { fireEvent.submit(input.closest('form')!) })
    expect(treeRow('renamed')).toBeTruthy()
    expect(within(directory()).queryByText('目录')).toBeNull()
    fireEvent.contextMenu(treeRow('renamed'))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await act(async () => {})
    expect(within(directory()).queryByTitle('renamed')).toBeNull()
  })

  it('以中央宽度而非窗口宽度切换默认视图，保留手动预览和草稿', async () => {
    let reportWidth = (_width: number) => {}
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target instanceof HTMLTextAreaElement) return
        reportWidth = (width) => {
          this.callback([{ target, contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver)
        }
        reportWidth(760)
      }
      disconnect = disconnect
    })
    makeServer()
    const { unmount } = await mount()
    const edit = screen.getByRole('button', { name: '编辑' })
    const split = screen.getByRole('button', { name: '并排' })
    const preview = screen.getByRole('button', { name: '预览' })
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '原始文本' })
    fireEvent.input(editor, { target: { value: '**最新草稿**' } })
    expect(within(screen.getByRole('region', { name: '预览' })).getByText('最新草稿').tagName).toBe('STRONG')
    split.focus()
    act(() => { reportWidth(639) })
    expect(screen.queryByRole('button', { name: '并排' })).toBeNull()
    expect(screen.queryByRole('region', { name: '预览' })).toBeNull()
    expect(edit.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(edit)
    expect(editor.value).toBe('**最新草稿**')
    fireEvent.click(preview)
    expect(screen.queryByRole('textbox', { name: '原始文本' })).toBeNull()
    expect(screen.queryByRole('group', { name: '文本格式' })).toBeNull()
    act(() => { reportWidth(640) })
    expect(screen.getByRole('button', { name: '并排' })).toBeTruthy()
    expect(preview.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '并排' }))
    expect(screen.getByRole('textbox', { name: '原始文本' })).toBe(editor)
    expect(screen.getByRole('region', { name: '预览' })).toBeTruthy()
    unmount()
    expect(disconnect).toHaveBeenCalledTimes(2)
  })

  it('按名称搜索子目录中的笔记，按 Escape 清除查询并归还焦点', async () => {
    makeServer()
    await mount()
    const search = screen.getByRole('button', { name: '搜索笔记' })
    fireEvent.click(search)
    const input = screen.getByRole('textbox', { name: '搜索笔记' })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'not-found' } })
    expect(within(directory()).getByText('找不到匹配的笔记')).toBeTruthy()
    fireEvent.change(input, { target: { value: 'B' } })
    expect(within(directory()).queryByTitle('a')).toBeNull()
    await act(async () => { fireEvent.click(treeRow('b')) })
    expect(screen.getByRole('heading', { name: 'b' })).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: '搜索笔记' })).toBeNull()
    expect(document.activeElement).toBe(search)
    expect(treeRow('a')).toBeTruthy()
  })

  it('格式动作处理当前选区，同时刷新预览并自动保存', async () => {
    const state = makeServer()
    await mount()
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '原始文本' })
    editor.setSelectionRange(0, 5)
    fireEvent.click(screen.getByRole('button', { name: '行内代码' }))
    expect(editor.value).toBe('`hello` a')
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([1, 6])
    expect(document.activeElement).toBe(editor)
    expect(within(screen.getByRole('region', { name: '预览' })).getByText('hello').tagName).toBe('CODE')
    editor.setSelectionRange(0, editor.value.length)
    fireEvent.click(screen.getByRole('button', { name: '待办列表' }))
    expect(editor.value).toBe('- [ ] `hello` a')
    expect(within(screen.getByRole('region', { name: '预览' })).getByRole('checkbox')).toHaveProperty('checked', false)
    await act(async () => { vi.advanceTimersByTime(900) })
    expect(state.saveCalls).toEqual([{ path: 'a.md', content: '- [ ] `hello` a', baseMtimeMs: 1000 }])
  })

  it('工具栏插入标题、粗体与链接，行号不写入笔记', async () => {
    makeServer()
    await mount()
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '原始文本' })
    editor.setSelectionRange(0, 5)
    fireEvent.click(screen.getByRole('button', { name: '粗体' }))
    expect(editor.value).toBe('**hello** a')
    fireEvent.click(screen.getByRole('button', { name: '二级标题' }))
    expect(editor.value).toBe('## **hello** a')
    expect(within(screen.getByRole('region', { name: '预览' })).getByRole('heading', { name: 'hello a' })).toBeTruthy()
    expect(document.querySelector('[data-line="1"][data-heading]')?.textContent).toBe(editor.value)
    editor.setSelectionRange(editor.value.length - 1, editor.value.length)
    fireEvent.click(screen.getByRole('button', { name: '链接' }))
    expect(editor.value).toBe('## **hello** [a]()')
    expect(editor.selectionStart).toBe(editor.value.length - 1)
  })

  it('页头助手入口透传显隐与控制关系，打开的非模态抽屉优先处理 Escape', async () => {
    makeServer()
    const { rerender } = await mount()
    const button = screen.getByRole('button', { name: 'AI 助手' })
    expect(button.getAttribute('aria-controls')).toBe('note-assistant')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(toggleAssistant).toHaveBeenCalledOnce()
    rerender(<>
      <NotesPage {...props} assistantOpen />
      <div id="note-assistant" role="dialog" aria-label="AI 助手" />
    </>)
    expect(screen.getByRole('button', { name: 'AI 助手' }).getAttribute('aria-expanded')).toBe('true')
    await act(async () => { fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }) })
    expect(closePage).not.toHaveBeenCalled()
  })

  it('仅有子目录笔记时展开父链并打开第一篇', async () => {
    const state = makeServer()
    state.tree.shift()
    await mount()
    expect(screen.getByRole('heading', { name: 'b' })).toBeTruthy()
    expect(treeRow('d').closest('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(treeRow('b').closest('button')?.getAttribute('aria-current')).toBe('true')
  })

  it('停顿 900ms 自动保存，Cmd+S 立即保存，未改动失焦不落盘', async () => {
    const state = makeServer()
    await mount()
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    act(() => { fireEvent.input(editor, { target: { value: 'hello a2' } }) })
    await act(async () => { vi.advanceTimersByTime(900) })
    expect(state.saveCalls).toEqual([{ path: 'a.md', content: 'hello a2', baseMtimeMs: 1000 }])
    expect(saveState().textContent).toContain('已保存')
    act(() => { fireEvent.input(editor, { target: { value: 'hello a3' } }) })
    act(() => { fireEvent.keyDown(editor, { key: 's', metaKey: true }) })
    await act(async () => {})
    expect(state.saveCalls.at(-1)).toEqual({ path: 'a.md', content: 'hello a3', baseMtimeMs: 2000 })
    act(() => { fireEvent.blur(editor) })
    await act(async () => {})
    expect(state.saveCalls.length).toBe(2)
  })

  it('Ctrl+S 与 Cmd+S 走同一保存路径', async () => {
    const state = makeServer()
    await mount()
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    act(() => { fireEvent.input(editor, { target: { value: 'ctrl saved' } }) })
    act(() => { fireEvent.keyDown(editor, { key: 's', ctrlKey: true }) })
    await act(async () => {})
    expect(state.saveCalls.at(-1)?.content).toBe('ctrl saved')
  })

  it('保存期间输入的新内容不会被旧响应标为已保存', async () => {
    const state = makeServer()
    const delay = Promise.withResolvers<undefined>()
    state.saveDelay = delay.promise
    await mount()
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    fireEvent.input(editor, { target: { value: 'first version' } })
    await act(async () => { vi.advanceTimersByTime(900) })
    expect(saveState().textContent).toBe('正在保存…')
    fireEvent.input(editor, { target: { value: 'second version' } })
    fireEvent.keyDown(editor, { key: 's', metaKey: true })
    expect(state.saveCalls).toHaveLength(1)
    await act(async () => { delay.resolve(undefined) })
    expect(editor).toHaveProperty('value', 'second version')
    expect(saveState().textContent).toBe('未保存')
    await act(async () => { vi.advanceTimersByTime(900) })
    expect(state.saveCalls).toEqual([
      { path: 'a.md', content: 'first version', baseMtimeMs: 1000 },
      { path: 'a.md', content: 'second version', baseMtimeMs: 2000 },
    ])
    expect(saveState().textContent).toBe('已保存')
  })

  it('未保存改动期间轮询不覆盖本地内容', async () => {
    const state = makeServer()
    await mount()
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    act(() => { fireEvent.input(editor, { target: { value: 'local stays' } }) })
    state.files.get('a.md')!.content = 'server copy'
    state.files.get('a.md')!.mtimeMs = 4000
    state.tree[0]!.mtimeMs = 4000
    await act(async () => { vi.advanceTimersByTime(4000) })
    await act(async () => {})
    expect((editor as HTMLTextAreaElement).value).toBe('local stays')
  })

  it('未选中笔记时显示纯欢迎页；新建入口只在目录中，折叠后仍可用', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input), 'http://localhost')
      return url.pathname === '/api/notes/tree'
        ? Response.json({ children: [{ name: '想法', kind: 'dir', path: '想法', mtimeMs: 1000, children: [] }] })
        : new Response('not found', { status: 404 })
    }))
    const { rerender } = await mount()
    expect(screen.queryByRole('textbox', { name: '原始文本' })).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: /好呀/u })).toBeTruthy()
    expect(screen.getByText('在这里记录你的想法、灵感与工作内容')).toBeTruthy()
    expect(screen.queryByText('在目录中选择一篇笔记')).toBeNull()
    expect(screen.getAllByRole('button', { name: '新建笔记' })).toEqual([createTrigger()])
    rerender(<NotesPage {...props} sidebarCollapsed sidebarWidth={56} />)
    await act(async () => { vi.advanceTimersByTime(150) })
    fireEvent.click(createTrigger())
    await act(async () => {})
    fireEvent.click(screen.getByRole('menuitem', { name: '新建笔记' }))
    expect(document.activeElement).toBe(screen.getByLabelText('笔记名称'))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(document.activeElement).toBe(createTrigger())
  })

  it('新建弹窗：非回车键忽略，创建中 Escape 不关闭，取消按钮可关，创建按钮可提交', async () => {
    const state = makeServer()
    let resolveCreate: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/notes/create') {
        const body = requestJson(init) as { name: string }
        return await new Promise<Response>((resolve) => {
          resolveCreate = () => {
            const path = `${body.name}.md`
            state.files.set(path, { content: '', mtimeMs: 3000 })
            state.tree.unshift({ name: body.name, kind: 'file', path, mtimeMs: 3000 })
            resolve(Response.json({ path }))
          }
        })
      }
      if (url.pathname === '/api/notes/tree') return Response.json({ children: state.tree })
      const path = url.searchParams.get('path') ?? ''
      const entry = state.files.get(path)
      if (entry === undefined) return new Response('missing', { status: 404 })
      return Response.json({ path, content: entry.content, mtimeMs: entry.mtimeMs })
    }))
    await mount()
    act(() => { fireEvent.click(treeRow('d')) })
    act(() => { fireEvent.click(screen.getByRole('button', { name: '新建笔记' })) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '新建笔记' })) })
    await act(async () => {})
    const input = screen.getByLabelText('笔记名称')
    act(() => { fireEvent.keyDown(input, { key: 'a' }) })
    await act(async () => {})
    act(() => { fireEvent.change(input, { target: { value: '挂起' } }) })
    act(() => { fireEvent.click(screen.getByRole('button', { name: '创建' })) })
    await act(async () => {})
    // 创建请求挂起中：Escape 走模态框 onClose，被创建中守护拦住。
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await act(async () => {})
    expect(screen.queryByLabelText('笔记名称')).toBeTruthy()
    resolveCreate?.(Response.json({ path: '挂起.md' }))
    await act(async () => { vi.advanceTimersByTime(50) })
    await act(async () => {})
    expect(screen.getByRole('heading', { name: '挂起' })).toBeTruthy()
    act(() => { fireEvent.click(treeRow('d')) })
    act(() => { fireEvent.click(screen.getByRole('button', { name: '新建笔记' })) })
    await act(async () => {})
    fireEvent.click(screen.getByRole('menuitem', { name: '新建笔记' }))
    await act(async () => {})
    act(() => { fireEvent.click(screen.getByText('取消').closest('button')!) })
    await act(async () => {})
    expect(screen.queryByLabelText('笔记名称')).toBeNull()
  })

  it('保存冲突时给出重新加载入口，采用磁盘内容', async () => {
    const state = makeServer()
    state.conflictNext = true
    await mount()
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    act(() => { fireEvent.input(editor, { target: { value: 'local edit' } }) })
    await act(async () => { vi.advanceTimersByTime(900) })
    expect(saveState().textContent).toContain('已被外部修改')
    state.files.get('a.md')!.content = 'disk version'
    state.files.get('a.md')!.mtimeMs = 5000
    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(screen.getByRole('dialog', { name: '重新加载' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(editor).toHaveProperty('value', 'local edit')
    await confirmReload()
    expect((editor as HTMLTextAreaElement).value).toBe('disk version')
    expect(screen.getByRole('region', { name: '预览' }).textContent).toBe('disk version')
    expect(saveState().textContent).toContain('已保存')
    // 重新加载再次遇到读取失败时保留冲突状态，不把磁盘之外的内容当已保存。
    state.conflictNext = true
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    act(() => { fireEvent.input(editor, { target: { value: 'again' } }) })
    await act(async () => { vi.advanceTimersByTime(900) })
    state.files.delete('a.md')
    await confirmReload()
    expect(saveState().textContent).toContain('已被外部修改')
    expect((editor as HTMLTextAreaElement).value).toBe('again')
    expect(screen.getByRole('alert').textContent).toBe('无法读取笔记')
  })

  it('切换笔记先落盘，读取失败保留原笔记并提示', async () => {
    const state = makeServer()
    await mount()
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    act(() => { fireEvent.input(editor, { target: { value: 'before switch' } }) })
    state.files.delete('d/b.md')
    await act(async () => { fireEvent.click(treeRow('d')) })
    await act(async () => { fireEvent.click(treeRow('b')) })
    await act(async () => {})
    expect(state.saveCalls).toEqual([{ path: 'a.md', content: 'before switch', baseMtimeMs: 1000 }])
    expect((editor as HTMLTextAreaElement).value).toBe('before switch')
    expect(screen.getByRole('alert').textContent).toContain('无法读取笔记')
  })

  it('切换时冲突保留当前笔记和未保存的草稿', async () => {
    const state = makeServer()
    await mount()
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    act(() => { fireEvent.input(editor, { target: { value: 'local draft' } }) })
    state.conflictNext = true
    await act(async () => { fireEvent.click(treeRow('d')) })
    await act(async () => { fireEvent.click(treeRow('b')) })
    await act(async () => {})
    expect((editor as HTMLTextAreaElement).value).toBe('local draft')
    expect(saveState().textContent).toBe('笔记已被外部修改')
    expect(screen.getByRole('heading', { name: 'a' })).toBeTruthy()
  })

  it('目录轮询采用无未保存改动时的外部修改', async () => {
    const state = makeServer()
    await mount()
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    state.files.get('a.md')!.content = 'ai edited'
    state.files.get('a.md')!.mtimeMs = 4000
    state.tree[0]!.mtimeMs = 4000
    await act(async () => { vi.advanceTimersByTime(4000) })
    await act(async () => {})
    expect((editor as HTMLTextAreaElement).value).toBe('ai edited')
  })

  it('未打开文档时打开助手刚写入的笔记，显示写入后的内容', async () => {
    const state = makeServer()
    state.tree = []
    state.files.clear()
    await mount()
    expect(screen.queryByRole('textbox', { name: '原始文本' })).toBeNull()
    // 助手在笔记目录里新建并写入一篇笔记：下一次目录轮询打开它并读取最新内容。
    state.tree.push({ name: '助手写入', kind: 'file', path: '助手写入.md', mtimeMs: 5000 })
    state.files.set('助手写入.md', { content: '助手写入的内容', mtimeMs: 5000 })
    await act(async () => { vi.advanceTimersByTime(4000) })
    await act(async () => {})
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    expect((editor as HTMLTextAreaElement).value).toBe('助手写入的内容')
  })

  it('没有新写入时轮询保持未打开文档的欢迎页', async () => {
    const state = makeServer()
    state.tree = []
    state.files.clear()
    await mount()
    expect(screen.queryByRole('textbox', { name: '原始文本' })).toBeNull()
    // 只有目录、没有新增笔记的轮询不应把正文拽到任何文档。
    state.tree.push({ name: '想法', kind: 'dir', path: '想法', mtimeMs: 900 })
    await act(async () => { vi.advanceTimersByTime(4000) })
    await act(async () => {})
    expect(screen.queryByRole('textbox', { name: '原始文本' })).toBeNull()
  })

  it('创建请求进行中时轮询不抢先打开别的笔记，创建完成后打开新篇', async () => {
    const state = makeServer()
    state.tree = []
    state.files.clear()
    let resolveCreate: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/notes/create') {
        const body = requestJson(init) as { name: string }
        return await new Promise<Response>((resolve) => {
          resolveCreate = () => {
            const path = `${body.name}.md`
            state.files.set(path, { content: '', mtimeMs: 3000 })
            state.tree.unshift({ name: body.name, kind: 'file', path, mtimeMs: 3000 })
            resolve(Response.json({ path }))
          }
        })
      }
      if (url.pathname === '/api/notes/tree') return Response.json({ children: state.tree })
      const path = url.searchParams.get('path') ?? ''
      const entry = state.files.get(path)
      if (entry === undefined) return new Response('missing', { status: 404 })
      return Response.json({ path, content: entry.content, mtimeMs: entry.mtimeMs })
    }))
    await mount()
    act(() => { fireEvent.click(screen.getByRole('button', { name: '新建笔记' })) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '新建笔记' })) })
    await act(async () => {})
    act(() => { fireEvent.change(screen.getByLabelText('笔记名称'), { target: { value: '待建' } }) })
    act(() => { fireEvent.click(screen.getByRole('button', { name: '创建' })) })
    await act(async () => {})
    // 创建请求挂起期间的轮询不插入另一篇笔记，避免和创建结果抢同一个正文。
    await act(async () => { vi.advanceTimersByTime(4000) })
    await act(async () => {})
    expect(screen.queryByRole('textbox', { name: '原始文本' })).toBeNull()
    resolveCreate?.(Response.json({ path: '待建.md' }))
    await act(async () => { vi.advanceTimersByTime(50) })
    await act(async () => {})
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    expect((editor as HTMLTextAreaElement).value).toBe('')
  })

  it('笔记被移除后标题回退文件名，编辑内容保留', async () => {
    const state = makeServer()
    state.treeVersions.push(structuredClone(state.tree), [{ name: 'd', kind: 'dir', path: 'd', mtimeMs: 900, children: [] }])
    await mount()
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    expect((editor as HTMLTextAreaElement).value).toBe('hello a')
    await act(async () => { vi.advanceTimersByTime(4000) })
    await act(async () => {})
    expect(screen.getByRole('heading', { name: 'a' })).toBeTruthy()
    expect((editor as HTMLTextAreaElement).value).toBe('hello a')
  })

  it('Escape 关闭页面；新建弹窗打开时只关闭弹窗', async () => {
    makeServer()
    await mount()
    act(() => { fireEvent.click(screen.getByRole('button', { name: '新建笔记' })) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '新建笔记' })) })
    await act(async () => {})
    const input = screen.getByLabelText('笔记名称')
    act(() => { fireEvent.change(input, { target: { value: '新篇' } }) })
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await act(async () => {})
    expect(closePage).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('笔记名称')).toBeNull()
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await act(async () => {})
    expect(closePage).toHaveBeenCalledOnce()
  })

  it('新建笔记落盘后选中新篇；空名称不可提交', async () => {
    makeServer()
    await mount()
    act(() => { fireEvent.click(screen.getByRole('button', { name: '新建笔记' })) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '新建笔记' })) })
    await act(async () => {})
    const input = screen.getByLabelText('笔记名称')
    const createButton = screen.getByRole('button', { name: '创建' })
    expect((createButton as HTMLButtonElement).disabled).toBe(true)
    act(() => { fireEvent.change(input, { target: { value: '想法' } }) })
    act(() => { fireEvent.submit(input.closest('form')!) })
    await act(async () => {})
    expect(screen.getByRole('heading', { name: '想法' })).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '原始文本' }).value).toBe('')
  })

  it('再次点选当前笔记无副作用，目录可以重新收起', async () => {
    const state = makeServer()
    await mount()
    await act(async () => { fireEvent.click(treeRow('d')) })
    expect(screen.getByText('b')).toBeTruthy()
    await act(async () => { fireEvent.click(treeRow('a')) })
    await act(async () => { vi.advanceTimersByTime(100) })
    expect(state.saveCalls.length).toBe(0)
    await act(async () => { fireEvent.click(treeRow('d')) })
    expect(screen.queryByText('b')).toBeNull()
  })

  it('预览中的链接走 onOpenUrl 新窗口打开', async () => {
    const state = makeServer()
    state.files.set('a.md', { content: '看[这里](https://example.com/page)', mtimeMs: 1000 })
    const open = vi.spyOn(window, 'open').mockImplementation(() => 'about:blank' as unknown as Window)
    await mount()
    const link = screen.getByRole('region', { name: '预览' }).querySelector('a')!
    act(() => { fireEvent.click(link) })
    expect(open).toHaveBeenCalledWith('https://example.com/page', '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })

  it('空名称不能提交，创建失败给出提示并保留表单', async () => {
    const state = makeServer()
    await mount()
    act(() => { fireEvent.click(screen.getByRole('button', { name: '新建笔记' })) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '新建笔记' })) })
    await act(async () => {})
    const input = screen.getByLabelText('笔记名称')
    act(() => { fireEvent.submit(input.closest('form')!) })
    await act(async () => {})
    expect(screen.queryByLabelText('笔记名称')).toBeTruthy()
    act(() => { fireEvent.change(input, { target: { value: '坏名字' } }) })
    state.createFail = true
    act(() => { fireEvent.submit(input.closest('form')!) })
    await act(async () => {})
    expect(screen.getByRole('alert').textContent).toContain('无法创建笔记')
    expect(screen.getByLabelText('笔记名称')).toHaveProperty('value', '坏名字')
  })

  it('目录读取失败显示提示，无选中笔记时 Cmd+S 不落盘', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
    await mount()
    expect(screen.getByRole('alert').textContent).toContain('无法读取笔记目录')
    act(() => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 's', metaKey: true }) })
    await act(async () => {})
    expect(screen.queryByRole('textbox', { name: '原始文本' })).toBeNull()
    // 提示 4 秒后自行消失。
    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('服务器错误时保留编辑内容并标记保存失败', async () => {
    const state = makeServer()
    state.failSave = true
    await mount()
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    act(() => { fireEvent.input(editor, { target: { value: 'kept' } }) })
    await act(async () => { vi.advanceTimersByTime(900) })
    expect((editor as HTMLTextAreaElement).value).toBe('kept')
    expect(saveState().textContent).toContain('保存失败')
    state.failSave = false
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试保存' })) })
    expect(saveState().textContent).toBe('已保存')
    expect(state.files.get('a.md')?.content).toBe('kept')
  })
})
