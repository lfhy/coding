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
  it('从页头新建菜单创建 PPTX，并选中新文件标签', async () => {
    vi.useFakeTimers()
    const store = createNotesUiStore().create('s-notes')
    let tree: { name: string; kind: 'file'; path: string; mtimeMs: number }[] = []
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/notes/tree') return Response.json({ children: tree })
      if (url.pathname === '/api/notes/tabs') return Response.json({ ok: true })
      if (url.pathname === '/api/ppt/notes/create') {
        expect(init?.method).toBe('POST')
        if (typeof init?.body !== 'string') throw new Error('预期新建幻灯片请求包含 JSON 正文')
        expect(JSON.parse(init.body)).toEqual({ sessionId: 's-notes', name: '季度汇报' })
        tree = [{ name: '季度汇报.pptx', kind: 'file', path: '季度汇报.pptx', mtimeMs: 2_000 }]
        return Response.json({ ok: true, source: '季度汇报.pptx' })
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

    expect(store.getSnapshot().activePath).toBe('季度汇报.pptx')
    expect(within(screen.getByRole('tablist', { name: '打开的笔记' })).getByRole('tab', { name: '季度汇报' })
      .getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe('幻灯片已创建')
    expect(document.activeElement).toBe(trigger)
  })
})
