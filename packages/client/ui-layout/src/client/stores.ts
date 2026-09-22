/**
 * root entry 的瞬时布局 store。它持有导航与详情栏的全局偏好，以及按
 * Session 隔离的工作台开关和尺寸偏好；响应式让步只影响 AppFrame 的实际
 * 几何，不改写这些偏好。模块只导出工厂，避免热重载之间共享实例。
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  clampWidth,
  DETAILS_DEFAULT,
  DETAILS_MAX,
  DETAILS_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  WORKBENCH_BOTTOM_DEFAULT,
  WORKBENCH_BOTTOM_MAX,
  WORKBENCH_BOTTOM_MIN,
  WORKBENCH_DEFAULT,
  WORKBENCH_MAX,
  WORKBENCH_MIN,
} from './columns.ts'

/** 单个 Session 的工作台瞬时状态。 */
export type WorkbenchState = {
  open: boolean
  fullscreen: boolean
  width: number
  bottomOpen: boolean
  bottomHeight: number
  filesOpen: boolean
}

/** 布局偏好；0 宽度只用于既有 sidebar/details 的关闭语义。 */
type LayoutState = {
  sidebar: number
  details: number
  narrow: boolean
  narrowExpanded: boolean
  workbench: Record<SessionId, WorkbenchState | undefined>
}

function workbench(draft: LayoutState, sessionId: SessionId): WorkbenchState {
  return draft.workbench[sessionId] ??= {
    open: false,
    fullscreen: false,
    width: WORKBENCH_DEFAULT,
    bottomOpen: false,
    bottomHeight: WORKBENCH_BOTTOM_DEFAULT,
    filesOpen: true,
  }
}

/** store action 的声明镜像；`defineStore` 会校验实现没有漂移。 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  setWorkbench: (draft: LayoutState, sessionId: SessionId, px: number) => void
  setWorkbenchBottom: (draft: LayoutState, sessionId: SessionId, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
  openWorkbench: (draft: LayoutState, sessionId: SessionId) => void
  closeWorkbench: (draft: LayoutState, sessionId: SessionId) => void
  toggleWorkbench: (draft: LayoutState, sessionId: SessionId) => void
  toggleWorkbenchFullscreen: (draft: LayoutState, sessionId: SessionId) => void
  toggleWorkbenchBottom: (draft: LayoutState, sessionId: SessionId) => void
  toggleWorkbenchFiles: (draft: LayoutState, sessionId: SessionId) => void
  retainWorkbenchSessions: (draft: LayoutState, sessionIds: readonly SessionId[]) => void
}

/**
 * 创建布局 store。工作台状态按 Session 隔离；工作台打开会关闭详情栏，而详情栏仅暂时覆盖当前工作台，保留其 Session 偏好。关闭工作台时保留本 Session 的宽度、底栏和文件侧栏偏好，重新打开可恢复用户几何。
 * @returns 包含定义、身份和实例工厂的 store handle。
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions> {
  return defineStore({
    init: (): LayoutState => ({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      narrow: false,
      narrowExpanded: false,
      workbench: {},
    }),
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) },
      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },
      setWorkbench: (d, sessionId: SessionId, px: number) => {
        workbench(d, sessionId).width = clampWidth(px, WORKBENCH_MIN, WORKBENCH_MAX)
      },
      setWorkbenchBottom: (d, sessionId: SessionId, px: number) => {
        workbench(d, sessionId).bottomHeight = clampWidth(px, WORKBENCH_BOTTOM_MIN, WORKBENCH_BOTTOM_MAX)
      },
      toggleSidebar: (d) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      },
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      openDetails: (d) => {
        if (d.details === 0) d.details = DETAILS_DEFAULT
      },
      closeDetails: (d) => { d.details = 0 },
      openWorkbench: (d, sessionId: SessionId) => {
        d.details = 0
        const state = workbench(d, sessionId)
        state.open = true
        state.fullscreen = false
      },
      closeWorkbench: (d, sessionId: SessionId) => {
        const state = workbench(d, sessionId)
        state.open = false
        state.fullscreen = false
      },
      toggleWorkbench: (d, sessionId: SessionId) => {
        const state = workbench(d, sessionId)
        if (state.open) {
          state.open = false
          state.fullscreen = false
        } else {
          d.details = 0
          state.open = true
          state.fullscreen = false
        }
      },
      toggleWorkbenchFullscreen: (d, sessionId: SessionId) => {
        const state = d.workbench[sessionId]
        if (state?.open) state.fullscreen = !state.fullscreen
      },
      // 关闭态的面板切换先打开工作台并关闭详情栏，让常驻入口一次点击就显示目标面板。
      toggleWorkbenchBottom: (d, sessionId: SessionId) => {
        const state = workbench(d, sessionId)
        if (state.open) {
          state.bottomOpen = !state.bottomOpen
        } else {
          d.details = 0
          state.open = true
          state.fullscreen = false
          state.bottomOpen = true
        }
      },
      toggleWorkbenchFiles: (d, sessionId: SessionId) => {
        const state = workbench(d, sessionId)
        if (state.open) {
          state.filesOpen = !state.filesOpen
        } else {
          d.details = 0
          state.open = true
          state.fullscreen = false
          state.filesOpen = true
        }
      },
      retainWorkbenchSessions: (d, sessionIds: readonly SessionId[]) => {
        const retained = new Set(sessionIds)
        if (Object.keys(d.workbench).every(sessionId => retained.has(sessionId as SessionId))) return
        const next: Record<SessionId, WorkbenchState | undefined> = {}
        for (const [sessionId, state] of Object.entries(d.workbench)) {
          if (retained.has(sessionId as SessionId)) next[sessionId as SessionId] = state
        }
        d.workbench = next
      },
    },
  })
}
