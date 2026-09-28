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
  /** 右侧工作台关闭时仍单独显示底栏。 */
  bottomStandalone: boolean
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
    bottomStandalone: false,
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
  closeWorkbenchBottom: (draft: LayoutState, sessionId: SessionId) => void
  toggleWorkbenchFiles: (draft: LayoutState, sessionId: SessionId) => void
  toggleHeroPanel: (draft: LayoutState, sessionId: SessionId, panel: 'bottom' | 'files') => void
  retainWorkbenchSessions: (draft: LayoutState, sessionIds: readonly SessionId[]) => void
}

/**
 * 创建布局 store。工作台状态按 Session 隔离；工作台打开会关闭详情栏，而详情栏仅暂时覆盖当前工作台，保留其 Session 偏好。关闭右侧工作台时已显示的底栏保持可见，宽度和文件侧栏偏好也保留。
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
        state.bottomStandalone = false
        state.fullscreen = false
      },
      closeWorkbench: (d, sessionId: SessionId) => {
        const state = workbench(d, sessionId)
        state.bottomStandalone = state.bottomOpen && (state.open || state.bottomStandalone)
        state.open = false
        state.fullscreen = false
      },
      toggleWorkbench: (d, sessionId: SessionId) => {
        const state = workbench(d, sessionId)
        if (state.open) {
          state.bottomStandalone = state.bottomOpen
          state.open = false
          state.fullscreen = false
        } else {
          d.details = 0
          state.open = true
          state.bottomStandalone = false
          state.fullscreen = false
        }
      },
      toggleWorkbenchFullscreen: (d, sessionId: SessionId) => {
        const state = d.workbench[sessionId]
        if (state?.open) state.fullscreen = !state.fullscreen
      },
      // 两个面板的入口各自只改变目标面板；显示时关闭暂时遮挡它的详情栏。
      toggleWorkbenchBottom: (d, sessionId: SessionId) => {
        const state = workbench(d, sessionId)
        if (d.details === 0 && state.bottomOpen && (state.open || state.bottomStandalone)) {
          state.bottomOpen = false
          state.bottomStandalone = false
          return
        }
        d.details = 0
        state.bottomOpen = true
        state.bottomStandalone = !state.open
      },
      closeWorkbenchBottom: (d, sessionId: SessionId) => {
        const state = d.workbench[sessionId]
        if (state === undefined) return
        state.bottomOpen = false
        state.bottomStandalone = false
      },
      toggleWorkbenchFiles: (d, sessionId: SessionId) => {
        const state = workbench(d, sessionId)
        state.bottomStandalone = false
        if (state.open) {
          if (d.details !== 0) {
            d.details = 0
            state.filesOpen = true
          } else {
            state.filesOpen = !state.filesOpen
          }
        } else {
          d.details = 0
          state.open = true
          state.fullscreen = false
          state.filesOpen = true
        }
      },
      toggleHeroPanel: (d, sessionId: SessionId, panel: 'bottom' | 'files') => {
        const state = workbench(d, sessionId)
        if (panel === 'bottom') {
          if (d.details === 0 && state.bottomOpen && (state.bottomStandalone || state.open)) {
            state.bottomOpen = false
            state.bottomStandalone = false
          } else {
            d.details = 0
            state.open = false
            state.fullscreen = false
            state.bottomOpen = true
            state.bottomStandalone = true
          }
        } else if (d.details === 0 && state.open && state.filesOpen) {
          state.open = false
          state.bottomStandalone = state.bottomOpen
          state.fullscreen = false
        } else {
          d.details = 0
          state.open = true
          state.fullscreen = false
          state.filesOpen = true
          state.bottomOpen = false
          state.bottomStandalone = false
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
