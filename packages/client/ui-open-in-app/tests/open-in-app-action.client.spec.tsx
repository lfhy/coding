// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  WORKBENCH_CHOICE_ID,
  type WorkspaceOpenTarget,
  type WorkspaceOpenTargets,
} from '../src/client/controller.ts'
import { OpenInAppAction, type OpenInAppActionProps } from '../src/client/OpenInAppAction.tsx'
import { zh } from '../src/client/locales.ts'
import { createWorkbenchStore } from '../src/client/store.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const SESSION = 'session' as SessionId
const t: OpenInAppActionProps['t'] = makeTranslate(zh)

interface Bench {
  props: OpenInAppActionProps
  load: ReturnType<typeof vi.fn>
  launch: ReturnType<typeof vi.fn>
  choose: ReturnType<typeof vi.fn>
  openWorkbench: ReturnType<typeof vi.fn>
  files: ReturnType<ReturnType<typeof createWorkbenchStore>['create']>
}

function bench(over: {
  target?: WorkspaceOpenTarget
  choice?: string
  cwd?: string
  workbench?: Partial<{ open: boolean; fullscreen: boolean; bottomOpen: boolean; filesOpen: boolean }>
  launch?: (appId: string, path: string) => Promise<'launched' | 'files'>
} = {}): Bench {
  const cwd = over.cwd
  const state = {
    ids: [SESSION],
    byId: cwd === undefined ? {} : { [SESSION]: { cwd } },
    current: SESSION,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  } as unknown as SessionListState
  const targets = createSnapshotStore<WorkspaceOpenTargets>(
    cwd === undefined || over.target === undefined ? {} : { [cwd]: over.target },
  )
  const choice = createSnapshotStore<string>(over.choice ?? '')
  const workbenchState = {
    open: false,
    fullscreen: false,
    bottomOpen: false,
    ...over.workbench,
  }
  const workbench = createSnapshotStore(workbenchState)
  const files = createWorkbenchStore().create()
  const load = vi.fn(async () => {})
  const launch = vi.fn(over.launch ?? (async () => 'launched' as const))
  const choose = vi.fn()
  const openWorkbench = vi.fn()
  function useSessions<T>(select: (snapshot: SessionListState) => T): T {
    return select(state)
  }
  const props = {
    sessionId: SESSION,
    useSessions,
    useOpenInAppTargets: bindSnapshotSelector(targets),
    useOpenInAppChoice: bindSnapshotSelector(choice),
    useWorkbenchLayout: bindSnapshotSelector(workbench),
    useStore: bindSnapshotSelector(files.store),
    actions: files.actions,
    load,
    launch,
    choose,
    openWorkbench,
    iconUrl: (appId: string) => `/open-in-app/icon/${appId}`,
    t,
  } as unknown as OpenInAppActionProps
  return {
    props,
    load,
    launch,
    choose,
    openWorkbench,
    files,
  }
}

describe('OpenInAppAction target routing', () => {
  it('loads an unclassified cwd and renders no speculative local action', async () => {
    const b = bench({ cwd: '/w' })
    const { container } = render(<OpenInAppAction {...b.props} />)
    expect(container.innerHTML).toBe('')
    await waitFor(() => { expect(b.load).toHaveBeenCalledExactlyOnceWith('/w') })
  })

  it('renders nothing without a usable local target', () => {
    for (const over of [
      {},
      { cwd: '', target: { kind: 'local', apps: ['finder'] } as const },
      { cwd: '/w', target: { kind: 'loading' } as const },
      { cwd: '/w', target: { kind: 'unavailable' } as const },
    ]) {
      const { container } = render(<OpenInAppAction {...bench(over).props} />)
      expect(container.innerHTML).toBe('')
      cleanup()
    }
  })

  it('opens the built-in file page by default, even without a known app', () => {
    for (const apps of [['finder', 'cursor'], [], ['unknown-app']]) {
      const b = bench({ cwd: '/w', target: { kind: 'local', apps } })
      render(<OpenInAppAction {...b.props} />)
      fireEvent.click(screen.getByRole('button', { name: zh['workbench.open.title'] }))
      expect(b.openWorkbench).toHaveBeenCalledExactlyOnceWith()
      expect(b.launch).not.toHaveBeenCalled()
      cleanup()
    }
  })

  it('leaves the workbench view controls to the workbench top bar', () => {
    for (const workbench of [
      { open: false, fullscreen: false, bottomOpen: false },
      { open: true, fullscreen: true, bottomOpen: true },
    ]) {
      const b = bench({ cwd: '/w', target: { kind: 'files', apps: [] }, workbench })
      render(<OpenInAppAction {...b.props} />)
      const entry = screen.getByRole('button', { name: zh['workbench.open.title'] })
      expect(entry.getAttribute('aria-pressed')).toBe(workbench.open ? 'true' : null)
      for (const label of [
        zh['workbench.files.show'], zh['workbench.files.hide'], zh['workbench.close'],
      ]) {
        expect(screen.queryByRole('button', { name: label })).toBeNull()
      }
      cleanup()
    }
  })

  it('opens the workbench for a Remote-SSH target without launching an app', () => {
    const b = bench({ cwd: '/marker', target: { kind: 'files', apps: [] } })
    render(<OpenInAppAction {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.open.title'] }))
    expect(b.openWorkbench).toHaveBeenCalledExactlyOnceWith()
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('uses the remembered local app, falling back to the built-in file page', () => {
    const target = { kind: 'local' as const, apps: ['finder', 'cursor'] }
    render(<OpenInAppAction {...bench({ cwd: '/w', target, choice: 'cursor' }).props} />)
    expect(screen.getByRole('button', { name: zh['open.title'].replace('{app}', 'Cursor') })).toBeDefined()
    cleanup()
    for (const choice of ['', 'vscode', WORKBENCH_CHOICE_ID]) {
      render(<OpenInAppAction {...bench({ cwd: '/w', target, choice }).props} />)
      expect(screen.getByRole('button', { name: zh['workbench.open.title'] })).toBeDefined()
      cleanup()
    }
  })

  it('replaces a failed Host icon with the generic glyph', () => {
    const { container } = render(<OpenInAppAction {...bench({
      cwd: '/w', target: { kind: 'local', apps: ['cursor'] }, choice: 'cursor',
    }).props} />)
    const image = container.querySelector('img')
    expect(image).not.toBeNull()
    fireEvent.error(image as HTMLImageElement)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})

describe('OpenInAppAction local launching', () => {
  it('ignores a repeat click while a fast launch is in flight', async () => {
    let resolve: (value: 'launched') => void = () => {}
    const b = bench({
      cwd: '/w',
      target: { kind: 'local', apps: ['finder'] },
      choice: 'finder',
      launch: () => new Promise((r) => { resolve = r }),
    })
    render(<OpenInAppAction {...b.props} />)
    const main = screen.getByRole('button', { name: zh['open.title'].replace('{app}', zh['app.finder']) })
    fireEvent.click(main)
    fireEvent.click(main)
    expect(b.launch).toHaveBeenCalledExactlyOnceWith('finder', '/w')
    expect(main.getAttribute('data-state')).toBe('idle')
    resolve('launched')
    await waitFor(() => { expect((main as HTMLButtonElement).disabled).toBe(false) })
  })

  it('switches to Files if the Host observes a remote transition during launch', async () => {
    const b = bench({
      cwd: '/w',
      target: { kind: 'local', apps: ['finder'] },
      choice: 'finder',
      launch: async () => 'files',
    })
    render(<OpenInAppAction {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['open.title'].replace('{app}', zh['app.finder']) }))
    await waitFor(() => { expect(b.openWorkbench).toHaveBeenCalledExactlyOnceWith() })
  })

  it('shows delayed busy and temporary error states', async () => {
    vi.useFakeTimers()
    let reject: (error: Error) => void = () => {}
    const b = bench({
      cwd: '/w',
      target: { kind: 'local', apps: ['finder'] },
      choice: 'finder',
      launch: () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise }),
    })
    render(<OpenInAppAction {...b.props} />)
    const main = screen.getByRole('button', { name: zh['open.title'].replace('{app}', zh['app.finder']) })
    fireEvent.click(main)
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect((main as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { reject(new Error('nope')); await Promise.resolve() })
    expect(main.getAttribute('data-state')).toBe('error')
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(main.getAttribute('data-state')).toBe('idle')
  })

  it('persists and launches a menu choice, while ignoring picks during another launch', async () => {
    let resolve: (value: 'launched') => void = () => {}
    const b = bench({
      cwd: '/w',
      target: { kind: 'local', apps: ['finder', 'cursor'] },
      launch: () => new Promise((r) => { resolve = r }),
    })
    render(<OpenInAppAction {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['menu.toggle'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cursor' }))
    expect(b.choose).toHaveBeenCalledExactlyOnceWith('cursor')
    expect(b.launch).toHaveBeenCalledExactlyOnceWith('cursor', '/w')

    fireEvent.click(screen.getByRole('button', { name: zh['menu.toggle'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['app.finder'] }))
    expect(b.choose).toHaveBeenCalledTimes(1)
    resolve('launched')
  })

  it('returns to the built-in file page from the menu', () => {
    const b = bench({
      cwd: '/w',
      target: { kind: 'local', apps: ['finder', 'cursor'] },
      choice: 'cursor',
    })
    render(<OpenInAppAction {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['menu.toggle'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['workbench.label'] }))
    expect(b.choose).toHaveBeenCalledExactlyOnceWith(WORKBENCH_CHOICE_ID)
    expect(b.openWorkbench).toHaveBeenCalledExactlyOnceWith()
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('closes the application menu on Escape', async () => {
    const b = bench({ cwd: '/w', target: { kind: 'local', apps: ['finder', 'cursor'] } })
    render(<OpenInAppAction {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['menu.toggle'] }))
    expect(screen.getByRole('menu')).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  })
})
