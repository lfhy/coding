// @vitest-environment jsdom
/** 会话页头实际布局：两个面板按钮跟随 utilities 槽，而非标题旁或侧边栏。 */
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
    const toggleFiles = vi.fn()
    const toggleBottom = vi.fn()
    const panels = {
      useWorkbenchLayout: bindSnapshotSelector(layout), toggleFiles, toggleBottom,
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
      t: makeTranslate(conversationZh),
    } as unknown as ConversationSessionHeaderProps

    const view = render(<ConversationSessionHeader {...props} />)
    const header = view.container.querySelector('header') as HTMLElement
    const row = header.querySelector('nav[aria-label]')?.parentElement?.parentElement as HTMLElement
    const utilities = row.lastElementChild as HTMLElement
    expect(header.getAttribute('aria-hidden')).toBeNull()
    expect(row.firstElementChild?.contains(view.getByTestId('title-action'))).toBe(true)
    expect(within(utilities).getByRole('button', { name: zh['workbench.files.show'] })).toBeTruthy()
    expect(within(utilities).getAllByRole('button').map(button => button.getAttribute('aria-label')))
      .toEqual([zh['workbench.bottom.show'], zh['workbench.files.show']])
    const terminal = within(utilities).getByRole('button', { name: zh['workbench.bottom.show'] })
    fireEvent.click(terminal)
    expect(toggleBottom).toHaveBeenCalledOnce()
    expect(toggleFiles).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-testid="brand-action-seat"]')).toBeNull()
  })
})
