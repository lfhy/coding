/**
 * AppFrame 的纯几何求解器。详情栏沿用既有让步顺序；工作台使用独立
 * 求解规则，在宽屏保护对话区，在窄屏或全屏模式下占据全部主内容。
 */

/** 详情模式下的三列实际宽度。 */
export interface Columns { sidebar: number; center: number; details: number }

/** 工作台模式下的三列实际宽度。 */
export interface WorkbenchColumns { sidebar: number; conversation: number; workbench: number }

/** 详情模式中优先保护的对话区宽度。 */
export const CENTER_MIN = 640
/** 工作台并排模式中优先保护的对话区宽度。 */
export const WORKBENCH_CONVERSATION_MIN = 400
/** 导航栏拖拽下限。 */
export const SIDEBAR_MIN = 264
/** 导航栏拖拽上限。 */
export const SIDEBAR_MAX = 420
/** 导航栏初始宽度。 */
export const SIDEBAR_DEFAULT = 280
/** 收起后的导航 rail：24px 图标列加两侧 16px 内边距。 */
export const SIDEBAR_COLLAPSED = 56
/** 导航栏自动收敛的视口断点。 */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** 详情栏拖拽下限。 */
export const DETAILS_MIN = 300
/** 详情栏拖拽上限。 */
export const DETAILS_MAX = 520
/** 详情栏初始宽度。 */
export const DETAILS_DEFAULT = 360
/** 工作台右栏拖拽下限；与 400px 对话区共同覆盖 1110px 桌面视口。 */
export const WORKBENCH_MIN = 300
/** 工作台右栏拖拽上限，覆盖超宽桌面上的预览与文件树。 */
export const WORKBENCH_MAX = 2_400
/** 工作台右栏初始宽度；窄窗口会由求解器让步给对话区。 */
export const WORKBENCH_DEFAULT = 1_020
/** 工作台底栏拖拽下限。 */
export const WORKBENCH_BOTTOM_MIN = 160
/** 工作台底栏拖拽上限。 */
export const WORKBENCH_BOTTOM_MAX = 480
/** 工作台底栏初始高度。 */
export const WORKBENCH_BOTTOM_DEFAULT = 260
/** 底栏让步前优先保留的上方工作区高度。 */
export const WORKBENCH_TOP_MIN = 240

/**
 * 将面板尺寸限制到约定范围并取整。
 * @param px - 请求尺寸。
 * @param min - 下限。
 * @param max - 上限。
 * @returns 取整后的约束尺寸。
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/** 解析导航栏偏好；关闭时保留可操作的紧凑 rail。 */
function resolveSidebar(sidebar: number): number {
  return sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
}

/**
 * 求解导航栏、对话和详情栏宽度。详情栏先收缩，再自动隐藏；偏好值不被改写。
 * @param viewport - AppFrame 可用宽度。
 * @param sidebar - 导航栏宽度偏好，0 表示收起。
 * @param details - 详情栏宽度偏好，0 表示关闭。
 * @returns 三列实际宽度。
 */
export function computeColumns(viewport: number, sidebar: number, details: number): Columns {
  const s = resolveSidebar(sidebar)
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)

  if (s + d0 + CENTER_MIN <= viewport) return { sidebar: s, center: viewport - s - d0, details: d0 }

  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s - CENTER_MIN)
  if (s + d1 + CENTER_MIN <= viewport) return { sidebar: s, center: CENTER_MIN, details: d1 }

  return { sidebar: s, center: Math.max(0, viewport - s), details: 0 }
}

/**
 * 求解导航栏、对话和工作台宽度。普通模式先收缩工作台到 300px，再让
 * 对话区承担更窄视口的剩余缺口；全屏模式让工作台占据导航栏外的全部宽度。
 * @param viewport - AppFrame 可用宽度。
 * @param sidebar - 导航栏宽度偏好，0 表示收起。
 * @param workbench - 工作台宽度偏好。
 * @param fullscreen - 是否使用工作台全屏呈现。
 * @returns 三列实际宽度。
 */
export function computeWorkbenchColumns(
  viewport: number,
  sidebar: number,
  workbench: number,
  fullscreen: boolean,
): WorkbenchColumns {
  const s = resolveSidebar(sidebar)
  const available = Math.max(0, viewport - s)
  if (fullscreen) return { sidebar: s, conversation: 0, workbench: available }

  const preferred = clampWidth(workbench, WORKBENCH_MIN, WORKBENCH_MAX)
  const protectedMaximum = available - WORKBENCH_CONVERSATION_MIN
  const resolved = protectedMaximum >= WORKBENCH_MIN
    ? Math.min(preferred, protectedMaximum)
    : Math.min(WORKBENCH_MIN, available)
  return {
    sidebar: s,
    conversation: Math.max(0, available - resolved),
    workbench: resolved,
  }
}

/**
 * 求解底栏高度。视口过矮时底栏向上方工作区让步，但 store 中的偏好保持不变。
 * @param viewport - AppFrame 可用高度。
 * @param preferred - 底栏高度偏好。
 * @param shown - 是否请求显示底栏。
 * @returns 底栏实际高度；0 表示视觉隐藏但不卸载。
 */
export function computeWorkbenchBottom(viewport: number, preferred: number, shown: boolean): number {
  if (!shown) return 0
  return Math.min(
    clampWidth(preferred, WORKBENCH_BOTTOM_MIN, WORKBENCH_BOTTOM_MAX),
    Math.max(0, viewport - WORKBENCH_TOP_MIN),
  )
}
