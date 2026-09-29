// @vitest-environment jsdom
/** 会话页头实际布局：概览按钮与 utilities 槽的两个面板按钮位于最右侧。 */
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkbenchLayoutSnapshot } from '@deepseek-ai/dsh-client-ui-layout/client'
import { ConversationSessionHeader } from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationSession.tsx'
import type { ConversationSessionHeaderProps } from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationSession.tsx'
import { zh as conversationZh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { WorkbenchPanelToggles } from '../src/client/WorkbenchPanelToggles.tsx'
import type { WorkbenchPanelTogglesProps } from '../src/client/WorkbenchPanelToggles.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SESSION = 'header-panel-session' as SessionId

describe('active conversation panel placement', () => {
  it('renders both switches after title actions at the far right of the visible header', () => {
    const layout = createSnapshotStore<WorkbenchLayoutSnapshot>({
      open: false, fullscreen: false, bottomOpen: false, filesOpen: true,
    })
    const toggleWorkbench = vi.fn()
    const toggleBottom = vi.fn()
    const toggleOverview = vi.fn()
    const panels = {
      useWorkbenchLayout: bindSnapshotSelector(layout), toggleWorkbench, toggleBottom,
      t: makeTranslate(zh),
    } as unknown as WorkbenchPanelTogglesProps
    const sessions = createSnapshotStore({
      current: SESSION,
      byId: { [SESSION]: { id: SESSION, displayTitle: 'Conversation', origin: 'user' } },
    })
    const props = {
      sessionId: SESSION,
      useSession: (select: (state: { composerPhase: string; blank: boolean }) => unknown) =>
        select({ composerPhase: 'active', blank: false }),
      useSessions: bindSnapshotSelector(sessions),
      useStore: () => null,
      views: { subscribe: () => () => {}, version: () => 1, list: () => [] },
      renderSlot: (slot: string) => slot === 'conversation.session.header.actions'
        ? <span data-testid="title-action">context</span>
        : slot === 'conversation.session.header.utilities'
          ? <WorkbenchPanelToggles {...panels} />
          : null,
      open: vi.fn(), startSession: vi.fn(), actions: { setView: vi.fn() },
      overviewExpanded: false, toggleOverview,
      t: makeTranslate(conversationZh),
    } as unknown as ConversationSessionHeaderProps

    const view = render(<ConversationSessionHeader {...props} />)
    const header = view.container.querySelector('header') as HTMLElement
    const row = header.querySelector('nav[aria-label]')?.parentElement?.parentElement as HTMLElement
    const utilities = row.lastElementChild as HTMLElement
    expect(header.getAttribute('aria-hidden')).toBeNull()
    expect(row.firstElementChild?.contains(view.getByTestId('title-action'))).toBe(true)
    const overview = within(utilities).getByRole('button', { name: conversationZh['overview.expand'] })
    expect(overview.getAttribute('aria-expanded')).toBe('false')
    expect(overview.getAttribute('aria-controls')).toBe('dsh-conversation-overview')
    expect(within(utilities).getByRole('button', { name: zh['workbench.right.open'] })).toBeTruthy()
    expect(within(utilities).getAllByRole('button').map(button => button.getAttribute('aria-label')))
      .toEqual([conversationZh['overview.expand'], zh['workbench.bottom.show'], zh['workbench.right.open']])
    fireEvent.click(overview)
    expect(toggleOverview).toHaveBeenCalledOnce()
    expect(toggleBottom).not.toHaveBeenCalled()
    expect(toggleWorkbench).not.toHaveBeenCalled()
    const terminal = within(utilities).getByRole('button', { name: zh['workbench.bottom.show'] })
    fireEvent.click(terminal)
    expect(toggleBottom).toHaveBeenCalledOnce()
    expect(toggleWorkbench).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-testid="brand-action-seat"]')).toBeNull()
  })
})
