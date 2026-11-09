/**
 * root entry 的瞬时布局 store。它持有导航与详情栏的全局偏好，以及按工作区键保存的工作台开关和尺寸偏好；响应式让步只影响 AppFrame 的实际几何，不改写这些偏好。模块只导出工厂，避免热重载之间共享实例。
 */
import { defineStore, type EngineStoreHandle } from 'coding-client-runtime/client'
import type { SessionId } from 'coding-session/types'
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

/** 单个工作区的工作台瞬时状态。 */
export type WorkbenchState = {
  open: boolean
  fullscreen: boolean
  /** 工作台宽度偏好；0 表示尚未手动调整，由求解器按对话 1、右侧 2 分配主内容。 */
  width: number
  bottomOpen: boolean
  /** 右侧工作台关闭时仍单独显示底栏。 */
  bottomStandalone: boolean
  bottomHeight: number
}

/** 当前主内容页的临时身份。 */
export interface PageRoute { kind: string; sessionId: SessionId }

/** 跨插件动作发给根布局的一次性会话显示请求。 */
export interface ConversationRequest { sessionId: SessionId; seq: number }

/** 布局偏好；0 宽度只用于既有 sidebar/details 的关闭语义。 */
type LayoutState = {
  sidebar: number
  details: number
  narrow: boolean
  narrowExpanded: boolean
  /** 工作台偏好按工作区键保存；会话 id 仍是合法的字符串键，单会话部署行为不变。 */
  workbench: Record<string, WorkbenchState | undefined>
  /** 空白阶段的右栏临时显隐；首条消息后转为该会话的显式打开或抑制状态。 */
  blankWorkbench: Record<SessionId, boolean | undefined>
  /** 空白会话开始后仍屏蔽旧右栏；显式打开为 false，尚未见过的会话不设值。 */
  suppressedWorkbench: Record<SessionId, boolean | undefined>
  /** 新建意图待选中的会话；首次选中时即使空白阶段已经结束也要隔离旧偏好。 */
  pendingNewConversation: boolean
  /** 通用工作台动作当前所属的空白会话，供没有 session 参数的顶栏动作使用。 */
  activeBlankSession: { sessionId: SessionId; key: string } | null
  /** 主内容区的临时页面；只属于打开它的会话。 */
  page: PageRoute | null
  conversationRequest: ConversationRequest | null
  conversationRequestSeq: number
}

function workbench(draft: LayoutState, key: string): WorkbenchState {
  return draft.workbench[key] ??= {
    open: false,
    fullscreen: false,
    width: WORKBENCH_DEFAULT,
    bottomOpen: false,
    bottomStandalone: false,
    bottomHeight: WORKBENCH_BOTTOM_DEFAULT,
  }
}

/** store action 的声明镜像；`defineStore` 会校验实现没有漂移。 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  setWorkbench: (draft: LayoutState, key: string, px: number) => void
  setWorkbenchBottom: (draft: LayoutState, key: string, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
  openWorkbench: (draft: LayoutState, key: string, sessionId?: SessionId) => void
  closeWorkbench: (draft: LayoutState, key: string, sessionId?: SessionId) => void
  toggleWorkbench: (draft: LayoutState, key: string, sessionId?: SessionId) => void
  toggleWorkbenchFullscreen: (draft: LayoutState, key: string) => void
  toggleWorkbenchBottom: (draft: LayoutState, key: string) => void
  closeWorkbenchBottom: (draft: LayoutState, key: string) => void
  toggleHeroPanel: (draft: LayoutState, key: string, panel: 'bottom' | 'files', sessionId?: SessionId) => void
  beginNewConversation: (draft: LayoutState) => void
  setActiveBlankSession: (draft: LayoutState, sessionId: SessionId | undefined, key?: string) => void
  selectConversation: (draft: LayoutState, sessionId: SessionId | undefined) => void
  clearBlankWorkbench: (draft: LayoutState, sessionId: SessionId) => void
  retainBlankSessions: (draft: LayoutState, sessionIds: readonly SessionId[]) => void
  retainWorkbenchSessions: (draft: LayoutState, keys: readonly string[]) => void
  openPage: (draft: LayoutState, kind: string, sessionId: SessionId) => void
  closePage: (draft: LayoutState) => void
  togglePage: (draft: LayoutState, kind: string, sessionId: SessionId) => void
  requestShowConversation: (draft: LayoutState, sessionId: SessionId) => void
  acknowledgeConversationRequest: (draft: LayoutState, seq: number) => void
  clearConversationRequest: (draft: LayoutState) => void
}

/**
 * 创建布局 store。工作台状态按工作区键保存；工作台打开会关闭详情栏，而详情栏仅暂时覆盖当前工作台，保留其工作区偏好。关闭右侧工作台时已显示的底栏保持可见，尺寸偏好也保留。
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
      blankWorkbench: {},
      suppressedWorkbench: {},
      pendingNewConversation: false,
      activeBlankSession: null,
      page: null,
      conversationRequest: null,
      conversationRequestSeq: 0,
    }),
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) },
      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },
      setWorkbench: (d, key: string, px: number) => {
        workbench(d, key).width = clampWidth(px, WORKBENCH_MIN, WORKBENCH_MAX)
      },
      setWorkbenchBottom: (d, key: string, px: number) => {
        workbench(d, key).bottomHeight = clampWidth(px, WORKBENCH_BOTTOM_MIN, WORKBENCH_BOTTOM_MAX)
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
      openWorkbench: (d, key: string, sessionId?: SessionId) => {
        d.details = 0
        const state = workbench(d, key)
        state.open = true
        state.bottomStandalone = false
        if (sessionId !== undefined) d.suppressedWorkbench[sessionId] = false
        const backgroundForBlank = d.activeBlankSession?.key === key
          && sessionId !== undefined && sessionId !== d.activeBlankSession.sessionId
        if (!backgroundForBlank) state.fullscreen = false
        if (d.activeBlankSession?.key === key
          && (sessionId === undefined || sessionId === d.activeBlankSession.sessionId)) {
          d.blankWorkbench[d.activeBlankSession.sessionId] = true
        }
      },
      closeWorkbench: (d, key: string, sessionId?: SessionId) => {
        const state = workbench(d, key)
        state.bottomStandalone = state.bottomOpen && (state.open || state.bottomStandalone)
        state.open = false
        state.fullscreen = false
        if (sessionId !== undefined) d.suppressedWorkbench[sessionId] = true
        if (d.activeBlankSession?.key === key) d.blankWorkbench[d.activeBlankSession.sessionId] = false
      },
      toggleWorkbench: (d, key: string, sessionId?: SessionId) => {
        const state = workbench(d, key)
        const activeBlank = d.activeBlankSession?.key === key
          && (sessionId === undefined || sessionId === d.activeBlankSession.sessionId)
          ? d.activeBlankSession.sessionId : undefined
        const rightVisible = activeBlank !== undefined ? d.blankWorkbench[activeBlank] === true
          : state.open && (sessionId === undefined || d.suppressedWorkbench[sessionId] !== true)
        if (rightVisible && d.details === 0) {
          state.bottomStandalone = state.bottomOpen
          state.open = false
          state.fullscreen = false
          if (activeBlank !== undefined) d.blankWorkbench[activeBlank] = false
          if (sessionId !== undefined) d.suppressedWorkbench[sessionId] = true
        } else {
          d.details = 0
          state.bottomStandalone = false
          // 详情栏只遮挡工作台，恢复时保留原有的最大化偏好。
          if (!state.open || sessionId !== undefined && d.suppressedWorkbench[sessionId] === true) {
            state.open = true
            state.fullscreen = false
          }
          if (activeBlank !== undefined) d.blankWorkbench[activeBlank] = true
          if (sessionId !== undefined) d.suppressedWorkbench[sessionId] = false
        }
      },
      toggleWorkbenchFullscreen: (d, key: string) => {
        const state = d.workbench[key]
        if (state?.open) state.fullscreen = !state.fullscreen
      },
      // 底栏入口只改变底栏；显示时关闭暂时遮挡它的详情栏。
      toggleWorkbenchBottom: (d, key: string) => {
        const state = workbench(d, key)
        if (d.details === 0 && state.bottomOpen && (state.open || state.bottomStandalone)) {
          state.bottomOpen = false
          state.bottomStandalone = false
          return
        }
        d.details = 0
        state.bottomOpen = true
        state.bottomStandalone = !state.open
      },
      closeWorkbenchBottom: (d, key: string) => {
        const state = d.workbench[key]
        if (state === undefined) return
        state.bottomOpen = false
        state.bottomStandalone = false
      },
      toggleHeroPanel: (d, key: string, panel: 'bottom' | 'files', sessionId?: SessionId) => {
        const state = workbench(d, key)
        const rightVisible = sessionId === undefined ? state.open : d.blankWorkbench[sessionId] === true
        if (panel === 'bottom') {
          if (d.details === 0 && state.bottomOpen && (state.bottomStandalone || state.open || sessionId !== undefined)) {
            state.bottomOpen = false
            state.bottomStandalone = false
          } else {
            d.details = 0
            state.open = false
            state.fullscreen = false
            state.bottomOpen = true
            state.bottomStandalone = true
          }
          if (sessionId !== undefined) {
            d.blankWorkbench[sessionId] = false
            d.suppressedWorkbench[sessionId] = true
          }
        } else if (d.details === 0 && rightVisible) {
          state.open = false
          state.bottomStandalone = state.bottomOpen
          state.fullscreen = false
          if (sessionId !== undefined) {
            d.blankWorkbench[sessionId] = false
            d.suppressedWorkbench[sessionId] = true
          }
        } else {
          d.details = 0
          state.open = true
          state.fullscreen = false
          state.bottomOpen = false
          state.bottomStandalone = false
          if (sessionId !== undefined) {
            d.blankWorkbench[sessionId] = true
            d.suppressedWorkbench[sessionId] = false
          }
        }
      },
      beginNewConversation: (d) => {
        for (const id of Object.keys(d.blankWorkbench)) d.suppressedWorkbench[id as SessionId] = true
        d.blankWorkbench = {}
        if (d.activeBlankSession !== null) d.suppressedWorkbench[d.activeBlankSession.sessionId] = true
        d.pendingNewConversation = true
      },
      selectConversation: (d, sessionId: SessionId | undefined) => {
        if (!d.pendingNewConversation || sessionId === undefined) return
        if (d.suppressedWorkbench[sessionId] === undefined) d.suppressedWorkbench[sessionId] = true
        d.pendingNewConversation = false
      },
      setActiveBlankSession: (d, sessionId: SessionId | undefined, key?: string) => {
        if (sessionId !== undefined && key !== undefined && d.activeBlankSession?.sessionId !== sessionId
          && d.blankWorkbench[sessionId] === undefined && d.suppressedWorkbench[sessionId] === undefined) {
          d.suppressedWorkbench[sessionId] = true
        }
        d.activeBlankSession = sessionId === undefined || key === undefined ? null : { sessionId, key }
      },
      clearBlankWorkbench: (d, sessionId: SessionId) => {
        const visible = d.blankWorkbench[sessionId]
        if (visible === undefined) return
        if (visible) d.suppressedWorkbench[sessionId] = false
        else d.suppressedWorkbench[sessionId] = true
        d.blankWorkbench = Object.fromEntries(
          Object.entries(d.blankWorkbench).filter(([id]) => id !== sessionId),
        )
      },
      retainBlankSessions: (d, sessionIds: readonly SessionId[]) => {
        const retained = new Set(sessionIds)
        if (Object.keys(d.blankWorkbench).some(id => !retained.has(id as SessionId))) {
          d.blankWorkbench = Object.fromEntries(
            Object.entries(d.blankWorkbench).filter(([id]) => retained.has(id as SessionId)),
          )
        }
        if (Object.keys(d.suppressedWorkbench).some(id => !retained.has(id as SessionId))) {
          d.suppressedWorkbench = Object.fromEntries(
            Object.entries(d.suppressedWorkbench).filter(([id]) => retained.has(id as SessionId)),
          )
        }
        if (d.activeBlankSession !== null && !retained.has(d.activeBlankSession.sessionId)) d.activeBlankSession = null
      },
      retainWorkbenchSessions: (d, keys: readonly string[]) => {
        const retained = new Set(keys)
        if (Object.keys(d.workbench).every(key => retained.has(key))) return
        const next: Record<string, WorkbenchState | undefined> = {}
        for (const [key, state] of Object.entries(d.workbench)) {
          if (retained.has(key)) next[key] = state
        }
        d.workbench = next
      },
      openPage: (d, kind: string, sessionId: SessionId) => { d.page = { kind, sessionId } },
      closePage: (d) => { d.page = null },
      togglePage: (d, kind: string, sessionId: SessionId) => {
        d.page = d.page?.kind === kind && d.page.sessionId === sessionId ? null : { kind, sessionId }
      },
      requestShowConversation: (d, sessionId: SessionId) => {
        d.conversationRequest = { sessionId, seq: ++d.conversationRequestSeq }
      },
      acknowledgeConversationRequest: (d, seq: number) => {
        if (d.conversationRequest?.seq === seq) d.conversationRequest = null
      },
      clearConversationRequest: (d) => { d.conversationRequest = null },
    },
  })
}
