/**
 * root entry 的瞬时布局 store。右侧工作台的开合与最大化属于会话；工作台尺寸和终端底栏属于工作区。响应式让步只影响 AppFrame 的实际几何，不改写这些偏好。
 */
import { defineStore, type EngineStoreHandle } from 'coding-client-runtime/client'
import type { SessionId } from 'coding-session/types'
import {
  clampWidth,
  DETAILS_DEFAULT,
  DETAILS_MAX,
  DETAILS_MIN,
  PAGE_ASSISTANT_DEFAULT,
  PAGE_ASSISTANT_MAX,
  PAGE_ASSISTANT_MIN,
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

/** 同一工作区内共享的工作台尺寸与底栏偏好。 */
type WorkbenchState = {
  /** 工作台宽度偏好；0 表示尚未手动调整，由求解器按对话 1、右侧 2 分配主内容。 */
  width: number
  bottomOpen: boolean
  bottomHeight: number
}

/** 当前主内容页的临时身份；返回入口可指定打开前的会话。 */
export interface PageRoute {
  kind: string
  sessionId: SessionId
  returnSessionId?: SessionId
}

/** 跨插件动作发给根布局的一次性会话显示请求。 */
export interface ConversationRequest { sessionId: SessionId; seq: number }

/** 主内容页关闭后的单次跨会话归还请求；from 用于拒绝已过期的导航。 */
export interface ConversationReturn { sessionId: SessionId; from: SessionId; seq: number }

/** 布局偏好；0 宽度只用于既有 sidebar/details 的关闭语义。 */
type LayoutState = {
  sidebar: number
  /** 折叠前最后一次展开宽度；独立页与对话共用，重新展开时不丢失拖拽结果。 */
  sidebarExpandedWidth: number
  details: number
  narrow: boolean
  narrowExpanded: boolean
  /** 工作台尺寸与底栏状态按工作区键保存。 */
  workbench: Record<string, WorkbenchState | undefined>
  /** 只记录已打开右栏的会话；没有记录时默认收起。 */
  rightWorkbench: Record<SessionId, { fullscreen: boolean } | undefined>
  /** 主内容区的临时页面；只属于打开它的会话，可选记录打开前的对话。 */
  page: PageRoute | null
  /** 当前页面的助手偏好；null 表示页面未启用助手。 */
  pageAssistant: boolean | 'auto' | null
  /** 独立页助手的宽度偏好；与详情栏一样只属于当前浏览器会话。 */
  pageAssistantWidth: number
  conversationRequest: ConversationRequest | null
  conversationReturn: ConversationReturn | null
  conversationRequestSeq: number
}

function workbench(draft: LayoutState, key: string): WorkbenchState {
  return draft.workbench[key] ??= {
    width: WORKBENCH_DEFAULT,
    bottomOpen: false,
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
  openWorkbench: (draft: LayoutState, sessionId: SessionId, foreground: boolean) => void
  closeWorkbench: (draft: LayoutState, sessionId: SessionId) => void
  toggleWorkbench: (draft: LayoutState, sessionId: SessionId) => void
  toggleWorkbenchFullscreen: (draft: LayoutState, sessionId: SessionId) => void
  toggleWorkbenchBottom: (draft: LayoutState, key: string) => void
  closeWorkbenchBottom: (draft: LayoutState, key: string) => void
  toggleHeroPanel: (draft: LayoutState, key: string, panel: 'bottom' | 'files', sessionId: SessionId) => void
  resetBlankWorkbench: (draft: LayoutState, sessionIds: readonly SessionId[]) => void
  retainWorkbenchSessions: (draft: LayoutState, keys: readonly string[], sessionIds: readonly SessionId[]) => void
  openPage: (draft: LayoutState, kind: string, sessionId: SessionId, returnSessionId?: SessionId) => void
  closePage: (draft: LayoutState) => void
  discardPage: (draft: LayoutState) => void
  togglePage: (draft: LayoutState, kind: string, sessionId: SessionId, returnSessionId?: SessionId) => void
  setPageAssistant: (draft: LayoutState, open: boolean | 'auto') => void
  setPageAssistantWidth: (draft: LayoutState, px: number) => void
  requestShowConversation: (draft: LayoutState, sessionId: SessionId) => void
  acknowledgeConversationRequest: (draft: LayoutState, seq: number) => void
  acknowledgeConversationReturn: (draft: LayoutState, seq: number) => void
  clearConversationRequest: (draft: LayoutState) => void
}

/**
 * 创建布局 store；详情栏只覆盖当前右栏，不改写其会话状态。关闭右栏保留共享底栏与尺寸。
 * @returns 包含定义、身份和实例工厂的 store handle。
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions> {
  return defineStore({
    init: (): LayoutState => ({
      sidebar: SIDEBAR_DEFAULT,
      sidebarExpandedWidth: SIDEBAR_DEFAULT,
      details: 0,
      narrow: false,
      narrowExpanded: false,
      workbench: {},
      rightWorkbench: {},
      page: null,
      pageAssistant: null,
      pageAssistantWidth: PAGE_ASSISTANT_DEFAULT,
      conversationRequest: null,
      conversationReturn: null,
      conversationRequestSeq: 0,
    }),
    actions: {
      setSidebar: (d, px: number) => {
        d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX)
        d.sidebarExpandedWidth = d.sidebar
      },
      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },
      setWorkbench: (d, key: string, px: number) => {
        workbench(d, key).width = clampWidth(px, WORKBENCH_MIN, WORKBENCH_MAX)
      },
      setWorkbenchBottom: (d, key: string, px: number) => {
        workbench(d, key).bottomHeight = clampWidth(px, WORKBENCH_BOTTOM_MIN, WORKBENCH_BOTTOM_MAX)
      },
      toggleSidebar: (d) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else d.sidebar = d.sidebar === 0 ? d.sidebarExpandedWidth : 0
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
      openWorkbench: (d, sessionId, foreground) => {
        const right = d.rightWorkbench[sessionId] ??= { fullscreen: false }
        if (foreground) {
          d.details = 0
          right.fullscreen = false
        }
      },
      closeWorkbench: (d, sessionId) => { Reflect.deleteProperty(d.rightWorkbench, sessionId) },
      toggleWorkbench: (d, sessionId) => {
        if (d.rightWorkbench[sessionId] !== undefined && d.details === 0) {
          Reflect.deleteProperty(d.rightWorkbench, sessionId)
        } else {
          d.details = 0
          // 详情栏只遮挡工作台，恢复时保留原有的最大化偏好。
          d.rightWorkbench[sessionId] ??= { fullscreen: false }
        }
      },
      toggleWorkbenchFullscreen: (d, sessionId) => {
        const right = d.rightWorkbench[sessionId]
        if (right !== undefined) right.fullscreen = !right.fullscreen
      },
      toggleWorkbenchBottom: (d, key) => {
        const state = workbench(d, key)
        if (d.details === 0 && state.bottomOpen) {
          state.bottomOpen = false
          return
        }
        d.details = 0
        state.bottomOpen = true
      },
      closeWorkbenchBottom: (d, key) => {
        const state = d.workbench[key]
        if (state !== undefined) state.bottomOpen = false
      },
      toggleHeroPanel: (d, key, panel, sessionId) => {
        const state = workbench(d, key)
        if (panel === 'bottom') {
          if (d.details === 0 && state.bottomOpen) {
            state.bottomOpen = false
          } else {
            d.details = 0
            Reflect.deleteProperty(d.rightWorkbench, sessionId)
            state.bottomOpen = true
          }
        } else if (d.details === 0 && d.rightWorkbench[sessionId] !== undefined) {
          Reflect.deleteProperty(d.rightWorkbench, sessionId)
        } else {
          d.details = 0
          d.rightWorkbench[sessionId] = { fullscreen: false }
          state.bottomOpen = false
        }
      },
      resetBlankWorkbench: (d, sessionIds) => {
        for (const id of sessionIds) Reflect.deleteProperty(d.rightWorkbench, id)
      },
      retainWorkbenchSessions: (d, keys, sessionIds) => {
        const retainedKeys = new Set(keys)
        const retainedIds = new Set<string>(sessionIds)
        for (const key of Object.keys(d.workbench)) if (!retainedKeys.has(key)) Reflect.deleteProperty(d.workbench, key)
        for (const id of Object.keys(d.rightWorkbench)) if (!retainedIds.has(id)) Reflect.deleteProperty(d.rightWorkbench, id)
      },
      openPage: (d, kind: string, sessionId: SessionId, returnSessionId?: SessionId) => {
        d.page = returnSessionId === undefined || returnSessionId === sessionId
          ? { kind, sessionId }
          : { kind, sessionId, returnSessionId }
        d.pageAssistant = null
        d.conversationReturn = null
      },
      closePage: (d) => {
        const page = d.page
        if (page === null) return
        d.page = null
        d.pageAssistant = null
        // 仅跨会话返回需要再选中原会话；同会话关闭沿用已有的页面呈现路径。
        d.conversationReturn = page.returnSessionId === undefined ? null : {
          sessionId: page.returnSessionId,
          from: page.sessionId,
          seq: ++d.conversationRequestSeq,
        }
      },
      discardPage: (d) => { d.page = null; d.pageAssistant = null; d.conversationReturn = null },
      togglePage: (d, kind: string, sessionId: SessionId, returnSessionId?: SessionId) => {
        if (d.page?.kind === kind && d.page.sessionId === sessionId) {
          const page = d.page
          d.page = null
          d.pageAssistant = null
          d.conversationReturn = page.returnSessionId === undefined ? null : {
            sessionId: page.returnSessionId,
            from: page.sessionId,
            seq: ++d.conversationRequestSeq,
          }
          return
        }
        d.page = returnSessionId === undefined || returnSessionId === sessionId
          ? { kind, sessionId }
          : { kind, sessionId, returnSessionId }
        d.pageAssistant = null
        d.conversationReturn = null
      },
      setPageAssistant: (d, open: boolean | 'auto') => {
        if (d.page !== null) d.pageAssistant = open
      },
      setPageAssistantWidth: (d, px: number) => {
        d.pageAssistantWidth = clampWidth(px, PAGE_ASSISTANT_MIN, PAGE_ASSISTANT_MAX)
      },
      requestShowConversation: (d, sessionId: SessionId) => {
        d.conversationRequest = { sessionId, seq: ++d.conversationRequestSeq }
      },
      acknowledgeConversationRequest: (d, seq: number) => {
        if (d.conversationRequest?.seq === seq) d.conversationRequest = null
      },
      clearConversationRequest: (d) => {
        d.conversationRequest = null
        d.conversationReturn = null
      },
      acknowledgeConversationReturn: (d, seq: number) => {
        if (d.conversationReturn?.seq === seq) d.conversationReturn = null
      },
    },
  })
}
