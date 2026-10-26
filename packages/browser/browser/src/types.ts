/** 浏览器命令与观测的数据约定。实时页面及访问策略属于提供方。 @module coding-browser/types */

/** 会话内标签页的稳定身份；关闭后不可复用。 */
export type BrowserTabId = string & { readonly __browserTabId: unique symbol }

/** 批量交互中的一步元素操作；同一批次的每一步共用产生它们的观测修订版。 */
export type BrowserStep =
  | { readonly kind: 'click'; readonly ref: string }
  | { readonly kind: 'fill'; readonly ref: string; readonly text: string }

/** 批量交互中一步的实际结果；未被执行的步骤不出现在结果里。 */
export interface BrowserStepResult {
  readonly kind: 'click' | 'fill'
  readonly ok: boolean
  /** 仅失败步骤提供：提供方对该步失败原因的一句话说明，已去掉控制字符并按长度截断。 */
  readonly reason?: string
}

/** 一次会话浏览器操作。元素引用只在产生它的标签页与观测修订版中有效。 */
export type BrowserCommand =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'click'; readonly ref: string; readonly revision: number }
  | { readonly kind: 'fill'; readonly ref: string; readonly text: string; readonly revision: number }
  | { readonly kind: 'act'; readonly revision: number; readonly steps: readonly BrowserStep[] }
  | { readonly kind: 'scroll'; readonly direction: 'up' | 'down'; readonly pixels: number }
  | { readonly kind: 'viewport'; readonly width: number; readonly height: number }
  | { readonly kind: 'screenshot' }
  | { readonly kind: 'close' }

/** 审批前目标；修订标记由提供方持有，不等同于 UI 状态发布次数，切离又切回也不能复用旧审批。 */
export type BrowserExpectedTarget =
  | { readonly kind: 'none' }
  | {
    readonly kind: 'tab'
    readonly browserGeneration: string
    readonly stateRevision: number
    readonly tabId: BrowserTabId
    readonly generation: string
    readonly url?: string
  }

/** 人工操作仅作用于当前会话，不进入模型工具历史；open-url 在同一提供方队列中新增、选中并导航标签页。 */
export type BrowserHumanCommand =
  | { readonly kind: 'ensure-tab' }
  | { readonly kind: 'new-tab' }
  | { readonly kind: 'open-url'; readonly url: string }
  | { readonly kind: 'select-tab'; readonly tabId: BrowserTabId }
  | { readonly kind: 'close-tab'; readonly tabId: BrowserTabId }
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'forward' }
  | { readonly kind: 'reload' }
  | { readonly kind: 'set-viewport'; readonly width: number; readonly height: number }
  | { readonly kind: 'click'; readonly target: BrowserHumanTarget; readonly x: number; readonly y: number }
  | { readonly kind: 'scroll'; readonly target: BrowserHumanTarget; readonly x: number; readonly y: number; readonly direction: 'up' | 'down'; readonly pixels: number }
  | { readonly kind: 'type'; readonly target: BrowserHumanTarget; readonly x: number; readonly y: number; readonly text: string }

/** 截图对应的目标身份；人工坐标命令在提供方队列中按全部字段核对。 */
export interface BrowserHumanTarget {
  readonly browserGeneration: string
  readonly stateRevision: number
  readonly tabId: BrowserTabId
  readonly generation: string
  readonly revision: number
  readonly viewport: { readonly width: number; readonly height: number }
}

/** 标签页在最近一次队列操作完成时的导航状态。 */
export interface BrowserTabSummary {
  readonly id: BrowserTabId
  readonly generation: string
  readonly url: string
  readonly title: string
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  /** 原生 guest 的实时加载状态；Web 等提供方可以不提供。 */
  readonly loading?: boolean
}

/** 只读会话状态；修订版使画面请求不能跨标签页使用旧截图。 */
export interface BrowserSessionState {
  readonly operationActive: boolean
  readonly browserGeneration: string
  readonly stateRevision: number
  readonly viewport: { readonly width: number; readonly height: number }
  readonly tabs: BrowserTabSummary[]
  readonly activeTabId: BrowserTabId | null
  readonly observation: BrowserObservation | null
  readonly hasFrame: boolean
}

/** 仅首次模型导航等待审批、尚未创建浏览器资源时的只读状态。 */
export interface BrowserOperationOnlyState {
  readonly operationActive: true
}

/** 成功操作后的纯 JSON 观测；generation 改变时旧修订版及元素引用全部失效。 */
export interface BrowserObservation {
  readonly tabId: BrowserTabId
  readonly generation: string
  readonly revision: number
  readonly url: string
  readonly title: string
  readonly snapshot: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly cursor: {
    readonly x: number
    readonly y: number
    readonly kind: 'click' | 'fill' | 'scroll'
    readonly at: number
  } | null
}

/** 同一成功操作产生的结构化观测与可选 PNG 字节；字节不属于 JSON 观测。 */
export interface BrowserCapture {
  readonly observation: BrowserObservation
  readonly png: Uint8Array | null
  /**
   * 批量交互各步的结果，顺序与请求一致；`act` 之外的操作不提供。
   * 批次在第一个无法执行的步骤处停止，因此较短的数组表示其余步骤没有执行。
   */
  readonly steps?: readonly BrowserStepResult[]
}

/** 可供消费方识别的浏览器失败种类；调用方取消保留 AbortSignal 的原因。 */
export type BrowserUseErrorCode =
  | 'BROWSER_INVALID_URL'
  | 'BROWSER_STALE_REF'
  | 'BROWSER_CLOSED'
  | 'BROWSER_DENIED'
  | 'BROWSER_UNAVAILABLE'
  | 'BROWSER_FAILED'
  | 'BROWSER_BUSY'
