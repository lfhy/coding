/**
 * 工作区浏览器与欢迎页选择器分别占用侧栏和对话 slot，均通过全局 hook 读取 Host 工作区。
 * 两者各自声明目录流子 slot，供可替换的选择器插件占用。
 */
import type { ConnectionHandle } from 'coding-client-connection/client'
import type { HostObservable } from 'coding-client-ui-slots'
import type { ClientContext } from 'coding-client-runtime/client'
// 类型导入补齐 locale 与 layout 对 Context 的服务声明。
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-layout/client'
import type { WorkspaceBrowserInjected, WorkspacePickerInjected } from './contract/slots.ts'
import { createWorkspaceViewStore } from './stores.ts'
import { WorkspaceBrowser } from './WorkspaceBrowser.tsx'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import { getRemoteSshBridge } from './remote.ts'
import { en, zh, type WorkspaceKey } from './locales.ts'

export type {
  DirectoryFlowOwnerProps, DirectoryFlowSlotName, DirectoryPickingHooks, DirectoryPickingInjected,
  WorkspaceBrowserInjected, WorkspaceBrowserProps, WorkspacePickerInjected, WorkspacePickerProps,
} from './contract/slots.ts'
export type { WorkspaceKey } from './locales.ts'

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 工作区浏览与选择流程文案。 */
    workspace: WorkspaceKey
  }
}

/** 本插件持有的字典命名空间。 */
const NS = 'workspace'

/**
 * 必需服务。目标 slot 由侧栏和对话插件声明，其加载元数据不保证 apply 顺序；
 * 注册仍通过 `slots.inject()` 等待各自的 slot 声明。
 */
export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'locale', 'connection']

/**
 * 在目标 slot 声明后注册浏览器与选择器；注入只返回回调，数据由全局 hook 读取。
 * @param ctx - Client 根上下文。
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const hostDescription = connection.hostDescription
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace: dictionaries')

  // 桌面端可用已保存的凭据恢复远端连接；普通 Web 没有 preload 桥，不注册该服务。
  const remoteBridge = getRemoteSshBridge()
  if (remoteBridge !== undefined) {
    ctx.effect(() => ctx.reflect.provide('remoteWorkspace', {
      activate: async (path: string): Promise<void> => {
        const result = await remoteBridge.reconnectWorkspace(path)
        if (result.kind === 'error') throw new Error(result.message)
        if (result.kind === 'host-key-confirmation') {
          throw new Error('远端主机密钥需要重新确认，请从连接向导重新连接。')
        }
      },
    }), 'ui-workspace: remote workspace activation')
  }

  const searchSessions: WorkspaceBrowserInjected['searchSessions'] = async (query, signal) => {
    const result = await ctx.sessions.search(query, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  // Stable per-surface occupancy sources (the renderer's hook cache keys by
  // source identity): true while the surface's directory-flow hole is filled.
  const flowSource = (hole: 'sidebar.workspaces.directoryFlow' | 'conversation.hero.workspace.directoryFlow'): HostObservable<boolean> => ({
    getSnapshot: () => ctx.slots.entries(hole).length > 0,
    subscribe: listener => ctx.slots.subscribe(hole, listener),
  })
  const browserFlowSource = flowSource('sidebar.workspaces.directoryFlow')
  const pickerFlowSource = flowSource('conversation.hero.workspace.directoryFlow')
  const browserInjected = (): WorkspaceBrowserInjected => ({
    // 分组动作保留指定工作区；无指定时由运行时继承当前会话工作区，再退到最近工作区。
    startSession: (workspaceId) => {
      ctx.layout.beginNewConversation()
      ctx.workspaces.startSession(workspaceId)
    },
    open: (sessionId) => { ctx.sessions.open(sessionId) },
    searchSessions,
    searchResultLimit: ctx.sessions.searchResultLimit,
    renameSession: async (sessionId, title) => {
      // Row → session-face hop: rename is a per-session verb (ISession), not
      // a list-service verb; the binding resolves any listed session.
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) throw new Error(`unknown session "${sessionId}"`)
      const result = await session.rename(title)
      if (!result.ok) throw new Error(result.error.message)
    },
    forkSession: (sessionId) => {
      ctx.sessions.fork({ sessionId, increaseTitle: true })
        .then((childId) => { ctx.sessions.open(childId) })
        .catch(() => {
          // Fork or child-rename failure keeps the current selection.
        })
    },
    renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title) },
    deleteWorkspace: async (workspaceId) => { await ctx.workspaces.delete(workspaceId) },
    insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
      await ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId)
    },
    archiveSession: async (sessionId) => { await ctx.workspaces.archiveSession(sessionId) },
    insertSessionBefore: async (workspaceId, sessionId, beforeSessionId) => {
      await ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    },
    createWorkspace: input => ctx.workspaces.create(input),
    hooks: { directoryFlow: browserFlowSource, hostDescription },
  })
  const pickerInjected = (): WorkspacePickerInjected => ({
    createWorkspace: input => ctx.workspaces.create(input),
    startSessionWithoutWorkspace: () => ctx.workspaces.startSessionWithoutWorkspace(),
    hooks: { directoryFlow: pickerFlowSource },
  })
  // Each registration declares its directory-flow child in the same call;
  // slot injection follows both the owner and declaration HMR lifetimes.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      children: { 'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' } },
      store: createWorkspaceViewStore(),
      inject: browserInjected,
      locale: NS,
    },
    WorkspaceBrowser,
  ))
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register(
    {
      name: 'conversation.hero.workspace',
      children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } },
      inject: pickerInjected,
      locale: NS,
    },
    WorkspacePicker,
  ))
}
