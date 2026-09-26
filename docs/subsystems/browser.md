# 浏览器使用

浏览器使用能力由 [`@deepseek-ai/dsh-browser`](../../packages/browser/browser/README.md) 定义 `ctx.browserUse`，由 [Playwright 提供方](../../packages/browser/browser-playwright/README.md)实现，并由 [`browser_use` 工具](../../packages/browser/tool-browser/README.md)消费。服务按 `SessionId` 隔离页面；工具负责一次性审批和模型结果，提供方负责实际网络访问限制、页面资源及清理。界面的[只读浏览器工作台](../../packages/client/ui-browser/README.md)读取 Host 捕获的画面，不承担页面操作。

以下跨包类型声明来自 [`packages/browser/browser/src/types.ts`](../../packages/browser/browser/src/types.ts)。服务方法的完整签名与 JSDoc 由下方 Cordis API 区域生成。

## 命令与引用

`BrowserCommand` 是封闭的判别联合。`click` 与 `fill` 使用最近观测中的不透明元素 `ref` 和 `revision`，而不是选择器或脚本；提供方必须拒绝过期引用。`close` 释放会话页面；再次 `navigate` 才建立新的页面 generation。

```ts type-equiv
/** 一次会话浏览器操作。元素引用只在产生它的观测修订版中有效。 */
export type BrowserCommand =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'click'; readonly ref: string; readonly revision: number }
  | { readonly kind: 'fill'; readonly ref: string; readonly text: string; readonly revision: number }
  | { readonly kind: 'scroll'; readonly direction: 'up' | 'down'; readonly pixels: number }
  | { readonly kind: 'screenshot' }
  | { readonly kind: 'close' }
```

## 观测与截图

成功命令发布一份 `BrowserObservation`。`generation` 改变时旧修订版和元素引用全部失效；`latest(sessionId)` 只返回最近成功发布的捕获，不执行页面操作，尚无观测或关闭后返回 `undefined`。拒绝或取消不会发布新的观测。`png` 与可序列化的观测分开保存，可能为 `null`；面向模型的工具仅在显式截图时持久化图像附件。

```ts type-equiv
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

每个 SessionId 独占一个浏览器资源的可替换服务。

```ts cordis-catalog
/**
 * 对指定会话执行一个命令，成功时发布对应的观测与可选截图。
 * 元素操作必须拒绝过期 revision；拒绝与取消不得发布虚假的新观测。
 * @param sessionId - 独占页面的会话身份。
 * @param command - 导航、快照、交互或关闭命令。
 * @param signal - 中止当前操作；提供方应保留调用方给出的中止原因。
 * @returns 成功命令产生的观测和可选 PNG 字节。
 */
abstract execute(sessionId: SessionId, command: BrowserCommand, signal: AbortSignal): Promise<BrowserCapture>

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
