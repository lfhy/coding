/**
 * 围栏内文件链接的宿主导航上下文。
 *
 * 可用性跟踪可选的 `sidebarRight` 服务（工作台未挂载时链接退化为纯文本）；
 * 打开动作经 `openFileForSession` 走右侧工作台文件标签，并把会话限制在
 * 当前主视图选择上，避免给后台会话开标签。
 */
import { createContext, createElement, useContext, useMemo, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import css from './GenuiBlock.module.css'

interface SidebarRightFileService {
  openFileForSession(sessionId: string, file: { readonly name: string; readonly segments: readonly string[] }): boolean
}

interface FileLinkHostContext {
  get(name: 'sidebarRight', strict?: false): SidebarRightFileService | undefined
  sessions: {
    list: { getSnapshot(): { current?: string | undefined } }
  }
}

interface FileLinkScope {
  get(name: 'sidebarRight'): SidebarRightFileService | undefined
  effect(callback: () => void | (() => void), name?: string): unknown
}

export interface FileLinkCordisContext extends FileLinkHostContext {
  inject(services: ['sidebarRight'], callback: (scope: FileLinkScope) => void): unknown
}

export interface FileLinkAvailability {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
}

const FileLinkOpenContext = createContext<((path: string, line?: number) => void) | undefined>(undefined)

/** 跟踪一个可选宿主服务的到达、移除与插件卸载。 */
export function createFileLinkAvailability(ctx: FileLinkCordisContext): FileLinkAvailability {
  let available = ctx.get('sidebarRight', false)?.openFileForSession !== undefined
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const setAvailable = (next: boolean): void => {
    if (available === next) return
    available = next
    notify()
  }

  ctx.inject(['sidebarRight'], (scope) => {
    scope.effect(() => {
      setAvailable(scope.get('sidebarRight')?.openFileForSession !== undefined)
      return () =>{  setAvailable(false) }
    }, 'genui: file-link sidebarRight')
  })

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => available,
  }
}

/** 把路径拆成工作台文件标签需要的 name + segments（空段剔除，反斜杠归一）。 */
function fileSegmentsOf(path: string): { name: string; segments: string[] } {
  const normalized = path.replaceAll('\\', '/')
  const segments = normalized.split('/').filter(segment => segment.length > 0)
  return { name: segments[segments.length - 1] ?? normalized, segments }
}

/** 为一个围栏的渲染子树提供会话级文件打开能力。 */
function FileLinkProvider({ ctx, availability, sessionId, streaming, children }: {
  ctx: FileLinkHostContext
  availability: FileLinkAvailability
  sessionId: string | undefined
  streaming: boolean
  children?: ReactNode
}) {
  const available = useSyncExternalStore(
    onStoreChange => availability.subscribe(onStoreChange),
    () => availability.getSnapshot(),
    () => false,
  )
  const open = useMemo(() => {
    if (!available || streaming || sessionId === undefined) return undefined
    return (path: string, _line?: number): void => {
      // 仅当该围栏所属会话仍是主视图当前会话时才导航。
      if (ctx.sessions.list.getSnapshot().current !== sessionId) return
      const sidebar = ctx.get('sidebarRight', false)
      if (sidebar === undefined) return
      sidebar.openFileForSession(sessionId, fileSegmentsOf(path))
    }
  }, [available, ctx, sessionId, streaming])

  return createElement(FileLinkOpenContext.Provider, { value: open }, children)
}

/** 服务可用时把文件链接渲染为可访问的宿主导航按钮。 */
export function FileLink({ path, line, label, children }: { path: string; line?: number; label: string; children?: ReactNode }) {
  const open = useContext(FileLinkOpenContext)
  if (open === undefined) return createElement('span', { title: path }, children)
  return createElement('button', {
    type: 'button',
    className: css.inlineFileLink,
    title: path,
    'aria-label': `${label} (${path})`,
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      open(path, line)
    },
  }, children)
}

/** 为一个围栏渲染树附加会话级文件导航。 */
export function withFileLinkContext(
  ctx: FileLinkHostContext,
  availability: FileLinkAvailability,
  sessionId: string | undefined,
  streaming: boolean,
  children: ReactNode,
): ReactNode {
  return createElement(FileLinkProvider, { ctx, availability, sessionId, streaming, children })
}
