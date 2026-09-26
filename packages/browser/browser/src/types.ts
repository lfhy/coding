/** 浏览器命令与观测的数据约定。实时页面及访问策略属于提供方。 @module @deepseek-ai/dsh-browser/types */

/** 一次会话浏览器操作。元素引用只在产生它的观测修订版中有效。 */
export type BrowserCommand =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'click'; readonly ref: string; readonly revision: number }
  | { readonly kind: 'fill'; readonly ref: string; readonly text: string; readonly revision: number }
  | { readonly kind: 'scroll'; readonly direction: 'up' | 'down'; readonly pixels: number }
  | { readonly kind: 'screenshot' }
  | { readonly kind: 'close' }

/** 成功操作后的纯 JSON 观测；generation 改变时旧修订版及元素引用全部失效。 */
export interface BrowserObservation {
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
}

/** 可供消费方识别的浏览器失败种类；调用方取消保留 AbortSignal 的原因。 */
export type BrowserUseErrorCode =
  | 'BROWSER_INVALID_URL'
  | 'BROWSER_STALE_REF'
  | 'BROWSER_CLOSED'
  | 'BROWSER_DENIED'
  | 'BROWSER_UNAVAILABLE'
  | 'BROWSER_FAILED'
