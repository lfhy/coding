# 浏览器使用

浏览器使用能力由 [`@deepseek-ai/dsh-browser`](../../packages/browser/browser/README.md) 定义 `ctx.browserUse`，由 [Playwright 提供方](../../packages/browser/browser-playwright/README.md)实现，并由 [`browser_use` 工具](../../packages/browser/tool-browser/README.md)消费。服务按 `SessionId` 隔离浏览器上下文与标签页；工具负责一次性审批和模型结果，提供方负责实际网络访问限制、页面资源及清理。工作台读取 Host 的标签页状态与画面。

以下跨包类型声明来自 [`packages/browser/browser/src/types.ts`](../../packages/browser/browser/src/types.ts)。服务方法的完整签名与 JSDoc 由下方 Cordis API 区域生成。

## 命令与引用

`BrowserCommand` 和 `BrowserHumanCommand` 是封闭的判别联合。`click` 与 `fill` 使用最近观测中的不透明元素 `ref` 和 `revision`，而不是选择器或脚本；提供方必须拒绝跨标签页及过期引用。`close` 释放会话浏览器资源。人工命令在同一会话中建立、选择、关闭标签页或导航活跃标签页，标签页 id 关闭后不可复用。`set-viewport` 调整会话所有页面的视口，状态暴露当前宽高；尺寸改变使旧截图、元素引用和审批失效。视口边界由[提供方](../../packages/browser/browser-playwright/README.md)校验。`browserGeneration` 标识会话浏览器资源，`generation` 标识标签页的页面代际；状态每次发布后递增 `stateRevision`，因此切离又切回也不能沿用旧审批。审批前采样的 `expectedTarget` 区分无会话和已有标签页，并在执行队列中复核；空白标签页也暴露 generation。

```ts type-equiv
/** 一次会话浏览器操作。元素引用只在产生它的标签页与观测修订版中有效。 */
export type BrowserCommand =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'click'; readonly ref: string; readonly revision: number }
  | { readonly kind: 'fill'; readonly ref: string; readonly text: string; readonly revision: number }
  | { readonly kind: 'scroll'; readonly direction: 'up' | 'down'; readonly pixels: number }
  | { readonly kind: 'screenshot' }
  | { readonly kind: 'close' }
```

```ts type-equiv
/** 会话内标签页的稳定身份；关闭后不可复用。 */
export type BrowserTabId = string & { readonly __browserTabId: unique symbol }
```

```ts type-equiv
/** 审批前目标；会话状态每次发布后递增，切离又切回也不能复用旧审批。 */
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
```

```ts type-equiv
/** 人工操作仅作用于当前会话，不进入模型工具历史。 */
export type BrowserHumanCommand =
  | { readonly kind: 'ensure-tab' }
  | { readonly kind: 'new-tab' }
  | { readonly kind: 'select-tab'; readonly tabId: BrowserTabId }
  | { readonly kind: 'close-tab'; readonly tabId: BrowserTabId }
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'forward' }
  | { readonly kind: 'reload' }
  | { readonly kind: 'set-viewport'; readonly width: number; readonly height: number }
```

```ts type-equiv
/** 标签页在最近一次队列操作完成时的导航状态。 */
export interface BrowserTabSummary {
  readonly id: BrowserTabId
  readonly generation: string
  readonly url: string
  readonly title: string
  readonly canGoBack: boolean
  readonly canGoForward: boolean
}
```

```ts type-equiv
/** 只读会话状态；修订版使画面请求不能跨标签页使用旧截图。 */
export interface BrowserSessionState {
  readonly browserGeneration: string
  readonly stateRevision: number
  readonly viewport: { readonly width: number; readonly height: number }
  readonly tabs: BrowserTabSummary[]
  readonly activeTabId: BrowserTabId | null
  readonly observation: BrowserObservation | null
  readonly hasFrame: boolean
}
```

## 观测与截图

成功命令发布一份 `BrowserObservation`。`generation` 改变时旧修订版和元素引用全部失效；`latest(sessionId)` 只返回活跃标签页最近成功发布的捕获，不执行页面操作，尚无观测或关闭后返回 `undefined`。`state(sessionId)` 可读取空白标签页而不启动页面操作。拒绝或取消不会发布新的观测。`png` 与可序列化的观测分开保存，可能为 `null`；面向模型的工具仅在显式截图时持久化图像附件。

```ts type-equiv
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
```

```ts type-equiv
/** 同一成功操作产生的结构化观测与可选 PNG 字节；字节不属于 JSON 观测。 */
export interface BrowserCapture {
  readonly observation: BrowserObservation
  readonly png: Uint8Array | null
}
```

## 失败与生命周期

`BrowserUseError.code` 供消费方区分无效 URL、过期引用、已关闭会话、策略拒绝、浏览器不可用与其他操作失败；调用方取消则保留 `AbortSignal` 的原因。`closeSession(sessionId)` 等待资源停稳，不存在资源时正常完成。页面与最近捕获只存在于提供方运行期间，不定义重启恢复或跨会话共享。具体提供方的网络边界和部署限制见其 [README](../../packages/browser/browser-playwright/README.md)。

```ts type-equiv
/** 可供消费方识别的浏览器失败种类；调用方取消保留 AbortSignal 的原因。 */
export type BrowserUseErrorCode =
  | 'BROWSER_INVALID_URL'
  | 'BROWSER_STALE_REF'
  | 'BROWSER_CLOSED'
  | 'BROWSER_DENIED'
  | 'BROWSER_UNAVAILABLE'
  | 'BROWSER_FAILED'
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog`; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowseruse--browseruseservice-abstract-seam"></a>

### `ctx.browserUse` — `BrowserUseService` (abstract seam)

每个 SessionId 独占浏览器上下文、标签页与代理的可替换服务。

```ts cordis-catalog
/**
 * 对指定会话执行一个命令，成功时发布对应的观测与可选截图。
 * 元素操作必须拒绝跨标签页或过期 revision；拒绝与取消不得发布虚假的新观测。
 * @param sessionId - 独占浏览器上下文的会话身份。
 * @param command - 导航、快照、交互或关闭命令。
 * @param signal - 中止当前操作；提供方应保留调用方给出的中止原因。
 * @param expectedTarget - 审批前采样的可选空会话或活跃标签页与状态修订版，执行队列中必须再次核对。
 * @returns 成功命令产生的观测和可选 PNG 字节。
 */
abstract execute(sessionId: SessionId, command: BrowserCommand, signal: AbortSignal, expectedTarget?: BrowserExpectedTarget): Promise<BrowserCapture>

/**
 * 同步读取最近一次队列操作完成后的会话状态，不启动或导航页面。
 * @param sessionId - 要读取的会话身份。
 * @returns 资源不存在时为 undefined；空白标签页没有观测。
 */
abstract state(sessionId: SessionId): BrowserSessionState | undefined

/**
 * 串行执行人工导航、标签页或有界页面视口操作，取消时释放不确定的会话状态。
 * @param sessionId - 独占浏览器上下文的会话身份。
 * @param command - 人工操作，标签页 id 只在当前会话有效。
 * @param signal - 调用方中止信号。
 * @returns 操作后的状态；关闭最后一个标签页时为 undefined。
 */
abstract control(sessionId: SessionId, command: BrowserHumanCommand, signal: AbortSignal): Promise<BrowserSessionState | undefined>

/**
 * 读取指定会话最近一次成功发布的观测，不启动浏览器操作。
 * @param sessionId - 要读取的会话身份。
 * @returns 已发布的捕获；尚无观测或资源已关闭时为 undefined。
 */
abstract latest(sessionId: SessionId): BrowserCapture | undefined

/**
 * 停止并释放指定会话的浏览器资源；调用方等待资源完全停稳。
 * @param sessionId - 要关闭的会话身份。
 * @returns 清理完成后兑现；没有该会话资源时也完成。
 */
abstract closeSession(sessionId: SessionId): Promise<void>
```

Types: [SessionId](core.md)

Source: [`packages/browser/browser/src/index.ts:24`](../../packages/browser/browser/src/index.ts)
<!-- END GENERATED cordis-surface -->
