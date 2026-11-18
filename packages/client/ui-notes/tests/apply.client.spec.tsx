// @vitest-environment jsdom
// 客户端接线测试：双半注册、不变量伴生与导航入口组件行为。
import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NotesNavigationEntryFace } from '../src/client/NavigationEntry.tsx'
import { NotesNavigationEntry } from '../src/client/NavigationEntry.tsx'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import { apply as nodeApply } from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import type { PageRoute } from 'coding-client-ui-layout/client'

function registration(): { entries: { options: Record<string, unknown>; inject: () => unknown; component: unknown }[] } {
  const entries: { options: Record<string, unknown>; inject: () => unknown; component: unknown }[] = []
  const ctx = {
    effect: (install: () => unknown) => { install() },
    locale: {
      register: vi.fn((_namespace: string, _dictionaries: unknown) => () => {}),
      bind: () => (key: string) => zh[key as keyof typeof zh],
    },
    layout: { page: { getSnapshot: () => null } },
    sessions: { list: { getSnapshot: () => ({ current: 's-cur', byId: {} }) }, create: vi.fn(async () => 's-new'), open: vi.fn() },
    slots: {
      inject: (_name: string, install: () => unknown) => { install() },
      register: (options: Record<string, unknown>, component: unknown) => {
        entries.push({ options, component, inject: (options.inject as () => unknown | undefined) ?? (() => ({})) })
        return () => { entries.pop() }
      },
    },
  }
  apply(ctx as never)
  return { entries }
}

describe('ui-notes registration', () => {
  it('注入声明只覆盖真实读到的服务', () => {
    expect(inject).toEqual(['slots', 'locale', 'layout', 'sessions', 'connection'])
  })

  it('注册文案、导航入口与主内容页，入口注入页面快照钩子', () => {
    const { entries } = registration()
    expect(entries).toHaveLength(2)
    const entry = entries[0]
    if (entry === undefined) throw new Error('导航入口未注册')
    expect(entry.options).toMatchObject({ name: 'shell.navigation.entry', id: 'notes', order: 15, locale: 'notes' })
    const face = entry.inject() as NotesNavigationEntryFace & { openNotes: () => Promise<void> }
    expect(typeof face.openNotes).toBe('function')
    expect(face.hooks.notesPage.getSnapshot()).toBeNull()
    const page = entries[1]
    if (page === undefined) throw new Error('主内容页未注册')
    expect(page.options).toMatchObject({ name: 'shell.page', key: 'notes', locale: 'notes' })
  })
})

describe('node half + invariant companion', () => {
  it('node apply 是刻意的空实现', () => {
    nodeApply()
  })

  it('不变量伴生以包名注册且空安装器可安全执行', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const dispose = await invariant.apply({ invariants: { register } } as never)
    expect(register).toHaveBeenCalledWith('coding-client-ui-notes', expect.any(Function))
    expect(() => { (register.mock.calls[0]?.[1] as (c: never) => void)(undefined as never) }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})

describe('NotesNavigationEntry', () => {
  type EntryProps = Parameters<typeof NotesNavigationEntry>[0]
  function mountEntry(page: PageRoute | null = { kind: 'notes', sessionId: 's-notes' } as PageRoute,
    openNotes: () => Promise<void> = vi.fn(async () => {})) {
    const props = {
      useNotesPage: ((selector: (p: PageRoute | null) => boolean) => selector(page)),
      openNotes,
      t: (key: keyof typeof zh) => zh[key],
    }
    return render(<NotesNavigationEntry {...(props as unknown as EntryProps)} />)
  }

  it('入口当前页时带 aria-current，点击触发打开流程', async () => {
    const openNotes = vi.fn(async () => {})
    const { unmount } = mountEntry(undefined, openNotes)
    const button = screen.getByRole('button', { name: '笔记' })
    expect(button.getAttribute('aria-current')).toBe('page')
    await act(async () => { fireEvent.click(button) })
    expect(openNotes).toHaveBeenCalledOnce()
    unmount()
  })

  it('打开失败弹出共享提示，按钮不被禁用，提示随后自行消失', async () => {
    vi.useFakeTimers()
    const fail = vi.fn(async () => { throw new Error('down') })
    mountEntry(null, fail)
    const button = screen.getByRole('button', { name: '笔记' })
    expect(button.hasAttribute('aria-current')).toBe(false)
    await act(async () => { fireEvent.click(button) })
    expect(screen.getByRole('alert').textContent).toContain('无法读取笔记目录')
    expect((button as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByRole('alert')).toBeNull()
    vi.useRealTimers()
    cleanup()
  })
})
