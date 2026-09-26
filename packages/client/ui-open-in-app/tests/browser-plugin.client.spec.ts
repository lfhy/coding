/** 真实 SlotRegistry 上的浏览器插件注册、注入与 fiber 释放。 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, SlotRegistry, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

import { apply, inject, type OpenInAppActionInjected } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { OpenInAppAction } from '../src/client/OpenInAppAction.tsx'
import { WorkspaceWorkbench, type WorkspaceWorkbenchInjected } from '../src/client/WorkspaceWorkbench.tsx'
import {
  HeroPanelToggle, WorkbenchPanelToggles,
  type HeroPanelToggleInjected, type WorkbenchPanelTogglesInjected,
} from '../src/client/WorkbenchPanelToggles.tsx'
import { RetainedTerminalPanel } from '../src/client/RetainedTerminalPanel.tsx'
import type { TerminalPanelInjected } from '../src/client/TerminalPanel.tsx'
import { en, NS, zh } from '../src/client/locales.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const SESSION = 'browser-plugin-session' as SessionId

/** 启动欢迎页、会话页头、工作台与底栏的最小真实 slot tree。 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.brand.action': { kind: 'list', scope: 'root' },
      'conversation.hero.actions': { kind: 'list', scope: 'root' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'conversation.view': { kind: 'list', scope: 'session' },
      'workbench': { kind: 'single', scope: 'session' },
      'workbench.bottom': { kind: 'single', scope: 'session' },
    },
  } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const openWorkbench = vi.fn()
  const closeWorkbench = vi.fn()
  const toggleWorkbenchFullscreen = vi.fn()
  const toggleWorkbenchBottom = vi.fn()
  const toggleWorkbenchFiles = vi.fn()
  const toggleHeroPanel = vi.fn()
  const workbench = createSnapshotStore({
    open: false, fullscreen: false, bottomOpen: false, filesOpen: true,
  })
  ctx.provide('layout', {
    toggleSidebar: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn(),
    openWorkbench, closeWorkbench, toggleWorkbench: vi.fn(),
    toggleWorkbenchFullscreen, toggleWorkbenchBottom, toggleWorkbenchFiles, toggleHeroPanel,
    workbench: vi.fn(() => workbench),
  })
  // 欢迎页入口从当前会话列表定位可操作的 Session。
  const list = createSnapshotStore<SessionListState>({
    ids: [SESSION],
    byId: { [SESSION]: { id: SESSION, blank: false } },
    current: SESSION as SessionId | undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  } as unknown as SessionListState)
  const open = vi.fn()
  ctx.provide('sessions', { list, open } as never)
  const workspaceList = createSnapshotStore({ recentWorkspaceId: undefined as string | undefined })
  const connectHome = vi.fn(async () => SESSION)
  const connectWorkspace = vi.fn(async () => SESSION)
  ctx.provide('workspaces', { list: workspaceList, connectHome, connectWorkspace } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx, fiber, openWorkbench, closeWorkbench, toggleWorkbenchFullscreen,
    toggleWorkbenchBottom, toggleWorkbenchFiles, toggleHeroPanel,
    sessionList: list, open, connectHome, connectWorkspace, workspaceList,
  }
}

describe('open-in-app browser half', () => {
  it('declares only the services read by apply', () => {
    expect(inject).toEqual(['slots', 'locale', 'layout', 'sessions', 'workspaces'])
  })

  it('registers session-header and hero controls, workbench, and bottom without a sidebar action', async () => {
    const { ctx, fiber } = await bench()
    const [action, headerPanels] = ctx.slots.entries('conversation.session.header.utilities')
    const workbench = ctx.slots.entries('workbench')[0]
    const bottom = ctx.slots.entries('workbench.bottom')[0]
    const heroActions = ctx.slots.entries('conversation.hero.actions')
    expect(action?.component).toBe(OpenInAppAction)
    expect(action?.options).toMatchObject({ id: 'open-in-app', order: -10 })
    expect(workbench?.component).toBe(WorkspaceWorkbench)
    expect(action?.store).toBe(workbench?.store)
    expect(bottom?.component).toBe(RetainedTerminalPanel)
    expect(ctx.slots.entries('conversation.view')).toEqual([])

    expect(headerPanels?.component).toBe(WorkbenchPanelToggles)
    expect(ctx.slots.entries('sidebar.brand.action')).toEqual([])
    expect(heroActions.map(entry => entry.component)).toEqual([HeroPanelToggle, HeroPanelToggle])
    expect(heroActions.map(entry => [entry.options.id, entry.options.order]))
      .toEqual([['bottom-toggle', 0], ['files-toggle', 10]])
    expect(headerPanels?.options).toMatchObject({ id: 'workbench-panels', order: 20 })
    expect(headerPanels?.locale).toBe(NS)
    const headerInjected = (headerPanels?.inject as unknown as (id: SessionId) => WorkbenchPanelTogglesInjected)(SESSION)
    expect(Object.keys(headerInjected).sort()).toEqual(['hooks', 'toggleBottom', 'toggleFiles'])

    await fiber.dispose()
    expect(ctx.slots.entries('conversation.session.header.utilities')).toEqual([])
    expect(ctx.slots.entries('sidebar.brand.action')).toEqual([])
    expect(ctx.slots.entries('conversation.hero.actions')).toEqual([])
    expect(ctx.slots.entries('workbench')).toEqual([])
    expect(ctx.slots.entries('workbench.bottom')).toEqual([])
  })

  it('injects target, launch, workbench, terminal, and layout operations', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/open-in-app/target')) {
        return new Response(JSON.stringify({ kind: 'local', apps: ['finder', 'cursor'] }), { status: 200 })
      }
      if (url.includes('/open-in-app/read')) {
        return new Response(JSON.stringify({
          displayPath: '/w/README.md', name: 'README.md', truncated: false,
          kind: 'text', format: 'markdown', text: '# Readme',
        }), { status: 200 })
      }
      if (url.includes('/open-in-app/files')) {
        return new Response(JSON.stringify({
          displayPath: '/w', entries: [{ name: 'README.md', type: 'file' }], truncated: false,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, action: 'launched' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('location', { origin: 'http://dsh.example' })
    const {
      ctx, fiber, openWorkbench, closeWorkbench, toggleWorkbenchFullscreen, toggleWorkbenchBottom,
      toggleWorkbenchFiles,
    } = await bench()
    const action = ctx.slots.entries('conversation.session.header.utilities')[0]
    const actionFace = (action?.inject as unknown as (id: SessionId) => OpenInAppActionInjected)(SESSION)
    await actionFace.load('/w')
    expect(actionFace.hooks.openInAppTargets.getSnapshot()['/w'])
      .toEqual({ kind: 'local', apps: ['finder', 'cursor'] })
    actionFace.choose('cursor')
    expect(actionFace.hooks.openInAppChoice.getSnapshot()).toBe('cursor')
    expect(actionFace.iconUrl('cursor')).toBe('/open-in-app/icon/cursor')
    await expect(actionFace.launch('cursor', '/w')).resolves.toBe('launched')
    actionFace.openWorkbench()
    expect(openWorkbench).toHaveBeenCalledOnce()
    expect(openWorkbench).toHaveBeenCalledWith(SESSION)

    const workbench = ctx.slots.entries('workbench')[0]
    const workbenchFace = (workbench?.inject as unknown as (id: SessionId) => WorkspaceWorkbenchInjected)(SESSION)
    await expect(workbenchFace.listFiles([])).resolves.toEqual({
      path: '/w', entries: [{ name: 'README.md', type: 'file', segments: ['README.md'] }], truncated: false,
    })
    await expect(workbenchFace.readFile(['README.md'])).resolves.toEqual({
      path: '/w/README.md', content: { kind: 'markdown', text: '# Readme' },
    })
    workbenchFace.closeWorkbench()
    workbenchFace.toggleWorkbenchFullscreen()
    workbenchFace.toggleFiles()
    workbenchFace.toggleBottom()
    expect(closeWorkbench).toHaveBeenCalledWith(SESSION)
    expect(toggleWorkbenchFullscreen).toHaveBeenCalledWith(SESSION)
    expect(toggleWorkbenchFiles).toHaveBeenCalledWith(SESSION)
    expect(toggleWorkbenchBottom).toHaveBeenCalledWith(SESSION)

    const bottom = ctx.slots.entries('workbench.bottom')[0]
    const terminalFace = (bottom?.inject as unknown as (id: SessionId) => TerminalPanelInjected)(SESSION)
    expect(terminalFace.terminalUrl)
      .toBe('ws://dsh.example/open-in-app/terminal?sessionId=browser-plugin-session&cols=80&rows=24')
    terminalFace.closeBottom()
    expect(toggleWorkbenchBottom).toHaveBeenCalledTimes(2)
    await fiber.dispose()
  })

  it('injects session-bound panel toggles independently of later selection', async () => {
    const { ctx, toggleWorkbenchFiles, toggleWorkbenchBottom } = await bench()
    const headerPanels = ctx.slots.entries('conversation.session.header.utilities')[1]
    const face = (headerPanels?.inject as unknown as (id: SessionId) => WorkbenchPanelTogglesInjected)(SESSION)
    const source = face.hooks.workbenchLayout
    expect(source.getSnapshot().open).toBe(false)

    face.toggleFiles()
    face.toggleBottom()
    // 页头注入动作绑定到其 Session，不在点击时读取可能改变的全局选择。
    expect(toggleWorkbenchFiles).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(toggleWorkbenchBottom).toHaveBeenCalledExactlyOnceWith(SESSION)
  })

  it('opens only the requested panel on a blank Session and retains its id', async () => {
    const b = await bench()
    b.sessionList.set({ ...b.sessionList.getSnapshot(), byId: { [SESSION]: { id: SESSION, blank: true } } } as never)
    const [bottom, files] = b.ctx.slots.entries('conversation.hero.actions')
    const bottomFace = (bottom?.inject as unknown as () => HeroPanelToggleInjected)()
    const filesFace = (files?.inject as unknown as () => HeroPanelToggleInjected)()
    expect(bottomFace.panel).toBe('bottom')
    expect(filesFace.panel).toBe('files')
    await bottomFace.togglePanel()
    expect(b.toggleHeroPanel).toHaveBeenCalledExactlyOnceWith(SESSION, 'bottom')
    expect(b.toggleWorkbenchBottom).not.toHaveBeenCalled()
    expect(b.toggleWorkbenchFiles).not.toHaveBeenCalled()
    await filesFace.togglePanel()
    expect(b.toggleHeroPanel).toHaveBeenLastCalledWith(SESSION, 'files')
    expect(b.toggleHeroPanel).toHaveBeenCalledTimes(2)
    expect(b.toggleWorkbenchFiles).not.toHaveBeenCalled()
    expect(b.connectHome).not.toHaveBeenCalled()
  })

  it('connects the recent Workspace or Host HOME before opening either panel', async () => {
    const b = await bench()
    const [bottom, files] = b.ctx.slots.entries('conversation.hero.actions')
    const bottomFace = (bottom?.inject as unknown as () => HeroPanelToggleInjected)()
    const filesFace = (files?.inject as unknown as () => HeroPanelToggleInjected)()
    b.sessionList.set({ ...b.sessionList.getSnapshot(), current: undefined })

    await bottomFace.togglePanel()
    expect(b.connectHome).toHaveBeenCalledOnce()
    expect(b.open).toHaveBeenLastCalledWith(SESSION)
    expect(b.toggleHeroPanel).toHaveBeenLastCalledWith(SESSION, 'bottom')

    b.workspaceList.set({ recentWorkspaceId: 'workspace-1' })
    await filesFace.togglePanel()
    expect(b.connectWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1')
    expect(b.connectHome).toHaveBeenCalledOnce()
    expect(b.toggleHeroPanel).toHaveBeenLastCalledWith(SESSION, 'files')
  })

  it.each([
    ['bottom', 'files'],
    ['files', 'bottom'],
  ] as const)('shares one HOME connection and honors the last %s → %s panel click', async (first, last) => {
    const b = await bench()
    b.sessionList.set({ ...b.sessionList.getSnapshot(), current: undefined })
    let resolve!: (id: SessionId) => void
    b.connectHome.mockImplementationOnce(() => new Promise<SessionId>((done) => { resolve = done }))
    const faces = Object.fromEntries(b.ctx.slots.entries('conversation.hero.actions').map((entry) => {
      const face = (entry.inject as unknown as () => HeroPanelToggleInjected)()
      return [face.panel, face]
    })) as Record<HeroPanelToggleInjected['panel'], HeroPanelToggleInjected>

    const firstClick = faces[first].togglePanel()
    const lastClick = faces[last].togglePanel()
    expect(b.connectHome).toHaveBeenCalledOnce()
    expect(b.connectWorkspace).not.toHaveBeenCalled()
    resolve(SESSION)
    await Promise.all([firstClick, lastClick])
    expect(b.open).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(b.toggleHeroPanel).toHaveBeenCalledExactlyOnceWith(SESSION, last)
  })

  it('clears a failed shared connection so either button can retry', async () => {
    const b = await bench()
    b.sessionList.set({ ...b.sessionList.getSnapshot(), current: undefined })
    let reject!: (reason: Error) => void
    b.connectHome.mockImplementationOnce(() => new Promise<SessionId>((_, fail) => { reject = fail }))
    const [bottom, files] = b.ctx.slots.entries('conversation.hero.actions')
    const bottomFace = (bottom?.inject as unknown as () => HeroPanelToggleInjected)()
    const filesFace = (files?.inject as unknown as () => HeroPanelToggleInjected)()
    const attempts = [bottomFace.togglePanel(), filesFace.togglePanel()]
    expect(b.connectHome).toHaveBeenCalledOnce()
    reject(new Error('offline'))
    await expect(Promise.allSettled(attempts)).resolves.toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ])
    await filesFace.togglePanel()
    expect(b.connectHome).toHaveBeenCalledTimes(2)
    expect(b.open).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(b.toggleHeroPanel).toHaveBeenCalledExactlyOnceWith(SESSION, 'files')
  })

  it('does not take selection back if the user switches sessions while connecting', async () => {
    const b = await bench()
    b.sessionList.set({ ...b.sessionList.getSnapshot(), current: undefined })
    let resolve!: (id: SessionId) => void
    b.connectHome.mockImplementationOnce(() => new Promise<SessionId>((done) => { resolve = done }))
    const action = b.ctx.slots.entries('conversation.hero.actions')[1]
    const face = (action?.inject as unknown as () => HeroPanelToggleInjected)()
    const opening = face.togglePanel()
    b.sessionList.set({ ...b.sessionList.getSnapshot(), current: SESSION })
    resolve(SESSION)
    await opening
    expect(b.open).not.toHaveBeenCalled()
    expect(b.toggleHeroPanel).not.toHaveBeenCalled()
  })

  it('registers bilingual dictionaries and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    ctx.locale.setLocale('zh')
    const translate = ctx.locale.bind(NS)
    expect(translate('workbench.label')).toBe(zh['workbench.label'])
    ctx.locale.setLocale('en')
    expect(translate('workbench.label')).toBe(en['workbench.label'])
    await fiber.dispose()
    expect(translate('workbench.label')).not.toBe(en['workbench.label'])
  })

  it('keeps English keys identical to the Chinese source', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('ui-open-in-app node half', () => {
  it('keeps an inert Loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
