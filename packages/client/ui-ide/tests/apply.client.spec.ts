import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

describe('ui-ide registration', () => {
  it('注册双语导航入口与欢迎页，并让页面关闭欢迎后的助手栏', async () => {
    type Entry = {
      id?: string
      key?: string
      order?: number
      locale?: string
      store?: unknown
      children?: Record<string, unknown>
      inject: () => Record<string, unknown>
    }
    const registered: Entry[] = []
    const register = vi.fn((options: Entry) => {
      registered.push(options)
      return () => {}
    })
    const localeRegister = vi.fn((
      _namespace: string,
      _dictionaries: { zh: Record<string, string>; en: Record<string, string> },
    ) => () => {})
    const togglePage = vi.fn()
    const openPage = vi.fn()
    const setPageAssistant = vi.fn()
    const closePage = vi.fn()
    const workspaceFiles = {}
    const connectHome = vi.fn(async () => 'session-home' as const)
    const connectWorkspace = vi.fn(async () => 'session-workspace' as const)
    const open = vi.fn()
    const create = vi.fn(async (input: { path: string }) => ({
      workspaceId: 'workspace-1' as const, path: input.path, title: 'project', sessionIds: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }))
    const ctx = {
      effect: (install: () => unknown) => { install() },
      locale: { register: localeRegister, bind: () => (key: string) => key },
      slots: { inject: (_name: string, install: () => unknown) => { install() }, register },
      sessions: { list: { getSnapshot: () => ({ current: 'session-current' as const }) }, open },
      workspaces: {
        connectHome, connectWorkspace, create,
        list: { getSnapshot: () => ({ items: [] }) },
      },
      workspaceFiles,
      layout: {
        page: { getSnapshot: () => null },
        togglePage, openPage, setPageAssistant, closePage,
      },
    }
    apply(ctx as never)

    expect(inject).toEqual(['slots', 'locale', 'layout', 'sessions', 'workspaces', 'workspaceFiles'])
    expect(localeRegister.mock.calls[0]?.[0]).toBe('ide')
    expect(localeRegister.mock.calls[0]?.[1].zh.nav).toBe(zh.nav)
    expect(registered[0]).toMatchObject({ id: 'ide', order: 12, locale: 'ide' })
    expect(registered[1]).toMatchObject({ key: 'ide', locale: 'ide' })
    // 页面状态由插件自己持有（跨挂载存活），不注册成会话级 store。
    expect(registered[1]?.store).toBeUndefined()
    expect(registered[1]?.children).toHaveProperty('shell.ide.welcome.directoryFlow')

    const navigation = registered[0]?.inject() as { openIde: () => Promise<void> }
    await navigation.openIde()
    expect(connectHome).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('session-current')
    expect(togglePage).toHaveBeenCalledWith('ide', 'session-current', 'session-current')
    expect(setPageAssistant).toHaveBeenCalledWith(false)

    const page = registered[1]?.inject() as {
      hooks: { ideState: { getSnapshot: () => { workspaceId: string | null } } }
      actions: { enter: (workspaceId: string | null) => void }
      createWorkspace: (input: { path: string }) => Promise<unknown>
      openWorkspace: (workspaceId: 'workspace-1') => Promise<void>
      leaveWorkspace: () => void
      workspaceFiles: unknown
    }
    expect(page.workspaceFiles).toBe(workspaceFiles)
    expect(typeof page.hooks.ideState.getSnapshot().workspaceId).not.toBe('undefined')
    const workspace = await page.createWorkspace({ path: '/tmp/project' })
    expect(create).toHaveBeenCalledWith({ path: '/tmp/project' })
    await page.openWorkspace((workspace as { workspaceId: 'workspace-1' }).workspaceId)
    expect(connectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(open).toHaveBeenCalledWith('session-workspace')
    expect(openPage).toHaveBeenCalledWith('ide', 'session-workspace', 'session-current')
    expect(setPageAssistant).toHaveBeenLastCalledWith('auto')
    page.leaveWorkspace()
    expect(setPageAssistant).toHaveBeenLastCalledWith(false)
    expect(closePage).not.toHaveBeenCalled()
  })
})
