/**
 * root entry 的瞬时布局 store。它持有面板开关和尺寸偏好；响应式让步只影响
 * AppFrame 的实际几何，不改写这些偏好。模块只导出工厂，避免热重载之间共享实例。
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
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

/** 布局偏好；0 宽度只用于既有 sidebar/details 的关闭语义。 */
type LayoutState = {
  sidebar: number
  details: number
  narrow: boolean
  narrowExpanded: boolean
  workbenchOpen: boolean
  workbenchFullscreen: boolean
  workbenchWidth: number
  workbenchBottomOpen: boolean
  workbenchBottomHeight: number
}

/** store action 的声明镜像；`defineStore` 会校验实现没有漂移。 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  setWorkbench: (draft: LayoutState, px: number) => void
  setWorkbenchBottom: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
  openWorkbench: (draft: LayoutState) => void
  closeWorkbench: (draft: LayoutState) => void
  toggleWorkbench: (draft: LayoutState) => void
  toggleWorkbenchFullscreen: (draft: LayoutState) => void
  toggleWorkbenchBottom: (draft: LayoutState) => void
}

/**
 * 创建布局 store。工作台和详情栏互斥；打开工作台会关闭详情栏，打开详情栏
 * 也会退出工作台。工作台关闭时保留宽度和底栏偏好，重新打开可恢复用户几何。
 * @returns 包含定义、身份和实例工厂的 store handle。
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions> {
  return defineStore({
    init: (): LayoutState => ({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      narrow: false,
      narrowExpanded: false,
      workbenchOpen: false,
      workbenchFullscreen: false,
      workbenchWidth: WORKBENCH_DEFAULT,
      workbenchBottomOpen: false,
      workbenchBottomHeight: WORKBENCH_BOTTOM_DEFAULT,
    }),
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) },
      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },
      setWorkbench: (d, px: number) => { d.workbenchWidth = clampWidth(px, WORKBENCH_MIN, WORKBENCH_MAX) },
      setWorkbenchBottom: (d, px: number) => {
        d.workbenchBottomHeight = clampWidth(px, WORKBENCH_BOTTOM_MIN, WORKBENCH_BOTTOM_MAX)
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
        d.workbenchOpen = false
        d.workbenchFullscreen = false
      },
      closeDetails: (d) => { d.details = 0 },
      openWorkbench: (d) => {
        d.details = 0
        d.workbenchOpen = true
        d.narrowExpanded = false
      },
      closeWorkbench: (d) => {
        d.workbenchOpen = false
        d.workbenchFullscreen = false
      },
      toggleWorkbench: (d) => {
        if (d.workbenchOpen) {
          d.workbenchOpen = false
          d.workbenchFullscreen = false
        } else {
          d.details = 0
          d.workbenchOpen = true
          d.narrowExpanded = false
        }
      },
      toggleWorkbenchFullscreen: (d) => {
        if (d.workbenchOpen) d.workbenchFullscreen = !d.workbenchFullscreen
      },
      toggleWorkbenchBottom: (d) => {
        if (d.workbenchOpen) d.workbenchBottomOpen = !d.workbenchBottomOpen
      },
    },
  })
}
