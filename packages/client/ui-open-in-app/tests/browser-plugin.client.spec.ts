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
  HeroBottomToggle, WorkbenchPanelToggles,
  type HeroBottomToggleInjected, type WorkbenchPanelTogglesInjected,
} from '../src/client/WorkbenchPanelToggles.tsx'
import { RetainedTerminalPanel } from '../src/client/RetainedTerminalPanel.tsx'
import type { TerminalPanelInjected } from '../src/client/TerminalPanel.tsx'
import { en, NS, zh } from '../src/client/locales.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const SESSION = 'browser-plugin-session' as SessionId

/** 启动侧边栏品牌行、头部 utility、工作台与底栏的最小真实 slot tree。 */
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
  const workbench = createSnapshotStore({
    open: false, fullscreen: false, bottomOpen: false, filesOpen: true,
  })
  ctx.provide('layout', {
    toggleSidebar: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn(),
    openWorkbench, closeWorkbench, toggleWorkbench: vi.fn(),
    toggleWorkbenchFullscreen, toggleWorkbenchBottom, toggleWorkbenchFiles,
    workbench: vi.fn(() => workbench),
  })
  // 品牌行开关在 root scope 通过全局 useSessions 选会话；activeSessionId 只读取
  // `ctx.sessions.list` 的当前选中项，这里提供最小可用的列表快照。
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
    toggleWorkbenchBottom, toggleWorkbenchFiles,
    sessionList: list, open, connectHome, connectWorkspace, workspaceList,
  }
}

describe('open-in-app browser half', () => {
  it('declares only the services read by apply', () => {
    expect(inject).toEqual(['slots', 'locale', 'layout', 'sessions', 'workspaces'])
  })

  it('registers header, sidebar-brand, workbench, and bottom entries without a conversation view', async () => {
    const { ctx, fiber } = await bench()
    const action = ctx.slots.entries('conversation.session.header.utilities')[0]
    const workbench = ctx.slots.entries('workbench')[0]
    const bottom = ctx.slots.entries('workbench.bottom')[0]
    const brandAction = ctx.slots.entries('sidebar.brand.action')[0]
    const heroAction = ctx.slots.entries('conversation.hero.actions')[0]
    expect(action?.component).toBe(OpenInAppAction)
    expect(action?.options).toMatchObject({ id: 'open-in-app', order: -10 })
    expect(workbench?.component).toBe(WorkspaceWorkbench)
    expect(action?.store).toBe(workbench?.store)
    expect(bottom?.component).toBe(RetainedTerminalPanel)
    expect(ctx.slots.entries('conversation.view')).toEqual([])

    // 常驻的面板开关注册在侧边栏品牌行 list 槽，带 owner props 的注册者 id、词典与注入面。
    expect(brandAction?.component).toBe(WorkbenchPanelToggles)
    expect(heroAction?.component).toBe(HeroBottomToggle)
    expect(heroAction?.options).toMatchObject({ id: 'bottom-toggle', order: 10 })
    expect(brandAction?.options).toMatchObject({ id: 'workbench-panels', order: 20 })
    expect(brandAction?.locale).toBe(NS)
    const brandInjected = (brandAction?.inject as unknown as () => WorkbenchPanelTogglesInjected)()
    expect(Object.keys(brandInjected).sort())
      .toEqual(['toggleBottom', 'toggleFiles', 'workbenchSource'])

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
      ctx, fiber, openWorkbench, closeWorkbench, toggleWorkbenchFullscreen,
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
    expect(closeWorkbench).toHaveBeenCalledWith(SESSION)
    expect(toggleWorkbenchFullscreen).toHaveBeenCalledWith(SESSION)

    const bottom = ctx.slots.entries('workbench.bottom')[0]
    const terminalFace = (bottom?.inject as unknown as (id: SessionId) => TerminalPanelInjected)(SESSION)
    expect(terminalFace.terminalUrl)
      .toBe('ws://dsh.example/open-in-app/terminal?sessionId=browser-plugin-session&cols=80&rows=24')
    await fiber.dispose()
  })

  it('injects the resident panel toggles for the current session', async () => {
    const { ctx, toggleWorkbenchFiles, toggleWorkbenchBottom } = await bench()
    const brandAction = ctx.slots.entries('sidebar.brand.action')[0]
    const face = (brandAction?.inject as unknown as () => WorkbenchPanelTogglesInjected)()
    const source = face.workbenchSource(SESSION)
    expect(source.getSnapshot().open).toBe(false)

    face.toggleFiles()
    face.toggleBottom()
    // 两个开关都作用于当前会话，并委托给布局服务。
    expect(toggleWorkbenchFiles).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(toggleWorkbenchBottom).toHaveBeenCalledExactlyOnceWith(SESSION)
  })

  it('opens the bottom panel on a blank Session and retains its id', async () => {
    const b = await bench()
    b.sessionList.set({ ...b.sessionList.getSnapshot(), byId: { [SESSION]: { id: SESSION, blank: true } } } as never)
    const action = b.ctx.slots.entries('conversation.hero.actions')[0]
    const face = (action?.inject as unknown as () => HeroBottomToggleInjected)()
    await face.toggleBottom()
    expect(b.toggleWorkbenchBottom).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(b.connectHome).not.toHaveBeenCalled()
  })

  it('connects the recent Workspace or Host HOME before opening the bottom panel', async () => {
    const b = await bench()
    const action = b.ctx.slots.entries('conversation.hero.actions')[0]
    const face = (action?.inject as unknown as () => HeroBottomToggleInjected)()
    b.sessionList.set({ ...b.sessionList.getSnapshot(), current: undefined })

    await face.toggleBottom()
    expect(b.connectHome).toHaveBeenCalledOnce()
    expect(b.open).toHaveBeenLastCalledWith(SESSION)
    expect(b.toggleWorkbenchBottom).toHaveBeenLastCalledWith(SESSION)

    b.workspaceList.set({ recentWorkspaceId: 'workspace-1' })
    await face.toggleBottom()
    expect(b.connectWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1')
    expect(b.connectHome).toHaveBeenCalledOnce()
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
