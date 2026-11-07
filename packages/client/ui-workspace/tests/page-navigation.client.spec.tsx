// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { SlotTestRuntime } from 'coding-client-test-runtime'
import { createSnapshotStore, type SessionId, type WorkspaceId } from 'coding-client-runtime/client'
import { LocaleRuntime } from 'coding-client-locale/client'
import { apply as applySidebar, inject as injectSidebar } from 'coding-client-ui-sidebar/client'
import { apply, inject } from '../src/client/index.ts'

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

describe('sidebar conversation navigation from shell pages', () => {
  it.each(['grouped', 'flat', 'search'] as const)('returns to the same or another conversation in %s view', async (mode) => {
    const runtime = await SlotTestRuntime.create()
    const current = 'current' as SessionId
    const other = 'other' as SessionId
    const page = createSnapshotStore<{ kind: string; sessionId: SessionId } | null>(null)
    const closePage = () => { page.set(null) }
    runtime.provide('layout', { page, closePage, toggleSidebar: () => {} })
    runtime.provide('connection', {
      hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
    })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.sessions.add({ id: current, summary: { displayTitle: '会话甲' } })
    await runtime.sessions.add({ id: other, summary: { displayTitle: '会话乙' } }, { current: false })
    await runtime.workspaces.update((draft) => {
      draft.items = [{
        workspaceId: 'workspace' as WorkspaceId, title: '项目', path: '/projects/example',
        sessionIds: [current, other], createdAt: '0', updatedAt: '0',
      }] as never
    })
    await runtime.declare({ sidebar: { kind: 'single', scope: 'root' } })
    await runtime.mount({ inject: [...injectSidebar], apply: applySidebar })
    await runtime.mount({ inject: [...inject], apply })
    const { view } = runtime.renderSlot('sidebar', {
      collapsed: false, width: 300, welcomeActionsVisible: false,
    })
    if (mode === 'flat') {
      fireEvent.click(view.getByRole('button', { name: '视图选项' }))
      fireEvent.click(screen.getByRole('menuitem', { name: '单列表', hidden: true }))
    }
    if (mode === 'search') {
      fireEvent.click(view.getByRole('button', { name: '搜索会话' }))
      fireEvent.change(view.getByRole('textbox'), { target: { value: '会话' } })
    }
    const row = (title: string) => view.getByText(title).closest('[role="treeitem"]') as HTMLElement
    await waitFor(() => { expect(row('会话甲').getAttribute('aria-selected')).toBe('true') })

    act(() => { page.set({ kind: 'image-gallery', sessionId: current }) })
    expect(row('会话甲').getAttribute('aria-selected')).toBe('false')
    expect(runtime.sessions.list.getSnapshot().current).toBe(current)
    fireEvent.click(row('会话甲'))
    expect(page.getSnapshot()).toBeNull()
    expect(runtime.sessions.list.getSnapshot().current).toBe(current)
    expect(row('会话甲').getAttribute('aria-selected')).toBe('true')
    expect(runtime.sessions.calls).toEqual([{ method: 'open', args: [current] }])

    act(() => { page.set({ kind: 'another-shell-page', sessionId: current }) })
    expect(row('会话甲').getAttribute('aria-selected')).toBe('false')
    act(closePage)
    expect(row('会话甲').getAttribute('aria-selected')).toBe('true')
    act(() => { page.set({ kind: 'another-shell-page', sessionId: current }) })
    fireEvent.click(row('会话乙'))
    expect(page.getSnapshot()).toBeNull()
    expect(runtime.sessions.list.getSnapshot().current).toBe(other)
    expect(row('会话甲').getAttribute('aria-selected')).toBe('false')
    expect(row('会话乙').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(row('会话甲'))
    expect(runtime.sessions.list.getSnapshot().current).toBe(current)
    expect(row('会话甲').getAttribute('aria-selected')).toBe('true')
    expect(runtime.sessions.calls.filter(call => call.method === 'clear')).toEqual([])
    await runtime.dispose()
  })
})
