// @vitest-environment jsdom
/** 顶部选择单向写入侧栏；单纯筛选侧栏不改变页面模式或触发会话创建。 */
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from 'coding-client-test-runtime'
import { zh as commonZh } from 'coding-client-locale/src/locales/zh.ts'
import { NewConversationModeSwitch } from '../src/client/NewConversationModeSwitch.tsx'
import type { NewConversationModeSwitchProps } from '../src/client/NewConversationModeSwitch.tsx'
import { createWorkspaceViewStore } from '../src/client/stores.ts'
import { zh } from '../src/client/locales.ts'

beforeEach(() => { localStorage.clear() })
afterEach(cleanup)

function mountMode(busy = false) {
  const store = createWorkspaceViewStore().create()
  const onPick = vi.fn()
  function ModePage() {
    const [mode, setMode] = useState<NewConversationModeSwitchProps['mode']>('work')
    return (
      <NewConversationModeSwitch
        id="new-conversation-mode"
        mode={mode}
        busy={busy}
        onPick={(next) => { setMode(next); onPick(next) }}
        actions={store.actions}
        useStore={bindSnapshotSelector(store)}
        useSessions={() => { throw new Error('unused') }}
        useWorkspaces={() => { throw new Error('unused') }}
        t={makeTranslate(zh, commonZh)}
      />
    )
  }
  return { store, onPick, ...render(<ModePage />) }
}

describe('新对话顶部入口单向联动', () => {
  it('顶部对话同步侧栏对话，顶部工作同步侧栏工作', () => {
    const page = mountMode()
    const tabs = within(page.getByRole('tablist', { name: '新对话方式' }))
    expect(tabs.queryByRole('tab', { name: '最近' })).toBeNull()
    fireEvent.click(tabs.getByRole('tab', { name: '对话' }))
    expect(page.store.getSnapshot().view).toBe('conversations')
    expect(page.onPick).toHaveBeenLastCalledWith('conversation')
    fireEvent.click(tabs.getByRole('tab', { name: '工作' }))
    expect(page.store.getSnapshot().view).toBe('work')
    expect(page.onPick).toHaveBeenLastCalledWith('work')
  })

  it('侧栏浏览对话或最近不会改变顶部工作，也不会请求切换页面', () => {
    const page = mountMode()
    for (const view of ['conversations', 'recent'] as const) {
      act(() => { page.store.actions.setView(view) })
      expect(page.getByRole('tab', { name: '工作' }).getAttribute('aria-selected')).toBe('true')
    }
    expect(page.onPick).not.toHaveBeenCalled()
    fireEvent.click(page.getByRole('tab', { name: '对话' }))
    act(() => { page.store.actions.setView('work') })
    expect(page.getByRole('tab', { name: '对话' }).getAttribute('aria-selected')).toBe('true')
    expect(page.onPick).toHaveBeenCalledOnce()
  })

  it('支持双向键盘导航，创建期间不允许重复触发', () => {
    const page = mountMode()
    const work = page.getByRole('tab', { name: '工作' })
    work.focus()
    fireEvent.keyDown(work, { key: 'End' })
    const conversation = page.getByRole('tab', { name: '对话' })
    expect(document.activeElement).toBe(conversation)
    expect(page.store.getSnapshot().view).toBe('conversations')
    fireEvent.keyDown(conversation, { key: 'ArrowRight' })
    expect(page.store.getSnapshot().view).toBe('work')
    expect(document.activeElement).toBe(work)
    page.unmount()
    const pending = mountMode(true)
    fireEvent.click(pending.getByRole('tab', { name: '对话' }))
    expect(pending.onPick).not.toHaveBeenCalled()
    expect((pending.getByRole('tab', { name: '对话' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
