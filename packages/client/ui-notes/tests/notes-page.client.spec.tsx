// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NotesPageProps } from '../src/client/NotesPage.tsx'
import { NotesPage } from '../src/client/NotesPage.tsx'
import { zh } from '../src/client/locales.ts'

interface ServerNote { content: string; mtimeMs: number }
interface TreeNode { name: string; kind: 'dir' | 'file'; path: string; mtimeMs: number; children?: TreeNode[] }

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
    createFail: false,
    treeVersions: [] as TreeNode[][] ,
  }
  const route = (input: string | URL, init?: RequestInit): Response => {
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
      const body = JSON.parse(String(init?.body)) as { path: string; content: string; baseMtimeMs?: number }
      state.saveCalls.push(body)
      if (state.conflictNext) { state.conflictNext = false; return new Response('stale', { status: 409 }) }
      if (state.failSave) return new Response('boom', { status: 500 })
      const entry = state.files.get(body.path)
      if (entry === undefined) return new Response('missing', { status: 404 })
      entry.content = body.content
      entry.mtimeMs = 2000
      const node = state.tree.find(item => item.path === body.path)
      if (node !== undefined) node.mtimeMs = 2000
      return Response.json({ path: body.path, mtimeMs: 2000 })
    }
    if (url.pathname === '/api/notes/create') {
      if (state.createFail) return new Response('boom', { status: 500 })
      const body = JSON.parse(String(init?.body)) as { name: string }
      const path = `${body.name}.md`
      state.files.set(path, { content: '', mtimeMs: 3000 })
      state.tree.unshift({ name: body.name, kind: 'file', path, mtimeMs: 3000 })
      return Response.json({ path })
    }
    return new Response('not found', { status: 404 })
  }
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => route(input, init)))
  return state
}

const closePage = vi.fn()
const props = {
  closePage,
  t: (key: keyof typeof zh) => zh[key],
  sidebarCollapsed: false,
  sidebarWidth: 280,
} as unknown as NotesPageProps

async function mount() {
  await act(async () => { render(<NotesPage {...props} />) })
  await act(async () => {})
}

const saveState = () => screen.getByText(/已保存|正在保存|已被外部修改|保存失败|有未保存的改动/)
const treeRow = (name: string) => screen.getAllByText(name).find(element => element.closest('aside'))!

describe('NotesPage', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); closePage.mockClear() })

  it('加载目录树并选中第一篇笔记，编辑与预览同源', async () => {
    makeServer()
    await mount()
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    expect((editor as HTMLTextAreaElement).value).toBe('hello a')
    const preview = screen.getByRole('region', { name: '预览' })
    expect((preview as HTMLElement).textContent).toContain('hello a')
    expect(screen.getByRole('heading', { name: 'a' })).toBeTruthy()
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

  it('目录树为空时不选中任何笔记', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input), 'http://localhost')
      return url.pathname === '/api/notes/tree'
        ? Response.json({ children: [] })
        : new Response('not found', { status: 404 })
    }))
    await mount()
    expect(screen.queryByRole('textbox', { name: '原始文本' })).toBeNull()
    expect(screen.getAllByText('还没有笔记').length).toBeGreaterThanOrEqual(1)
    // 源区的空态主按钮同样打开新建弹窗。
    const paneButton = screen.getByRole('region', { name: '原始文本' }).querySelector('button')!
    act(() => { fireEvent.click(paneButton) })
    await act(async () => {})
    expect(screen.queryByLabelText('笔记名称')).toBeTruthy()
  })

  it('新建弹窗：非回车键忽略，创建中 Escape 不关闭，取消按钮可关，创建按钮可提交', async () => {
    const state = makeServer()
    let resolveCreate: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/notes/create') {
        const body = JSON.parse(String(init?.body)) as { name: string }
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
    act(() => { fireEvent.click(screen.getByRole('button', { name: '重新加载' })) })
    await act(async () => {})
    expect((editor as HTMLTextAreaElement).value).toBe('disk version')
    expect(saveState().textContent).toContain('已保存')
    // 重新加载再次遇到读取失败时保留冲突状态，不把磁盘之外的内容当已保存。
    state.conflictNext = true
    act(() => { fireEvent.input(editor, { target: { value: 'again' } }) })
    await act(async () => { vi.advanceTimersByTime(900) })
    state.files.delete('a.md')
    act(() => { fireEvent.click(screen.getByRole('button', { name: '重新加载' })) })
    await act(async () => {})
    expect(saveState().textContent).toContain('已被外部修改')
    expect((editor as HTMLTextAreaElement).value).toBe('again')
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

  it('切换时冲突提示并继续切换', async () => {
    const state = makeServer()
    await mount()
    const editor = screen.getByRole('textbox', { name: '原始文本' })
    act(() => { fireEvent.input(editor, { target: { value: 'will lose' } }) })
    state.conflictNext = true
    await act(async () => { fireEvent.click(treeRow('d')) })
    await act(async () => { fireEvent.click(treeRow('b')) })
    await act(async () => {})
    expect((editor as HTMLTextAreaElement).value).toBe('hello b')
    expect(screen.getByRole('alert').textContent).toContain('笔记已被外部修改')
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

  it('笔记被移除后标题回退文件名，编辑内容保留', async () => {
    const state = makeServer()
    state.treeVersions.push(JSON.parse(JSON.stringify(state.tree)), [{ name: 'd', kind: 'dir', path: 'd', mtimeMs: 900, children: [] }])
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
    await act(async () => {})
    const input = screen.getByLabelText('笔记名称')
    const createButton = screen.getByRole('button', { name: '创建' })
    expect((createButton as HTMLButtonElement).disabled).toBe(true)
    act(() => { fireEvent.change(input, { target: { value: '想法' } }) })
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await act(async () => {})
    expect(screen.getByRole('heading', { name: '想法' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: '原始文本' }) as HTMLTextAreaElement).value).toBe('')
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

  it('空名称按回车不请求，创建失败给出提示', async () => {
    const state = makeServer()
    await mount()
    act(() => { fireEvent.click(screen.getByRole('button', { name: '新建笔记' })) })
    await act(async () => {})
    const input = screen.getByLabelText('笔记名称')
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await act(async () => {})
    expect(screen.queryByLabelText('笔记名称')).toBeTruthy()
    act(() => { fireEvent.change(input, { target: { value: '坏名字' } }) })
    state.createFail = true
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await act(async () => {})
    expect(screen.getByRole('alert').textContent).toContain('无法创建笔记')
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
  })
})
