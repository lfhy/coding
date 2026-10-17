# 电脑控制

电脑控制能力由 [`@deepseek-ai/dsh-computer-use`](../../packages/computer-use/computer-use/README.md) 在宿主层提供 `ctx.computerUse`，由该包的 macOS 提供方实现；模型可见的 Skill、引导工具与执行工具由 [`@deepseek-ai/dsh-tool-computer-use`](../../packages/computer-use/tool-computer-use/README.md) 在显式 opt-in 的 agent 预设层贡献。默认 profile 不装载这两个插件。
显式装配后一个进程只有一份提供方：它持有 Swift helper 进程、观察缓存、按应用的租约与一次确认令牌，所有会话共享这些对象；会话之间通过 `SessionId`、agent 与 turn 归属区分授权，helper 自身不做会话隔离。
显式装配这一能力时只有本地 macOS 宿主提供实现，其他平台不会装载对应插件；helper 只接受固定 argv 与 JSON 行协议，模型不能提供 shell 片段、脚本或原生 selector。

## 观察与目标

每次观察冻结一份不可变状态：不透明的 `observationId`、应用身份、前台与窗口元数据、有界的可访问性树文本、当次元素表、可选截图产物与当时的权限状态。
元素带观察内唯一的 `index` 与不透明 `targetHandle`；动作只能引用某个观察，索引在被引用的观察里解析，元素消失时 fail closed，不会重新指向别的控件。
`allowRebind` 只接受限定在同一进程与窗口内的唯一原生标识或唯一语义匹配，歧义与低置信度都拒绝。
坐标动作默认按被观察窗口的局部坐标解释，`coordinateSpace: screen` 才接受屏幕全局点；两者都必须来自当次交付的栅格，越界或过期一律在原生派发之前拒绝。

## 权限、审批与确认

读取（观察与截图）与控制（投递 UI 输入）按精确 bundle id 分成两类租约：配置里的静态授权直接生效，没有授权的应用走会话审批，读取批准在整个 Session 有效，控制批准只在当前 turn 有效，拒绝在该 Session 内保持最终结果。
持久化的读取授权与拒绝决定写在本包拥有的 `computer_use_state` 存储域里，并按会话 header 的创建时间与 cwd 绑定生命周期；storage-domain 缺席时只有静态授权可用，需要持久化的交互决定会明确失败而不是静默缩短授权。
高影响动作（对外发送、敏感数据传输、不可逆删除、账户与安全设置、未经请求的安装、法律条款、财务完成）必须在执行前取一次确认令牌，令牌绑定应用、观察、目标与动作且只能用一次；确认走 DSH 审批通道，审批提示被禁用时不提供确认，动作被拒绝而不是绕过。

## 平台、完整性与失败

非 macOS 宿主不注册任何工具或 Skill，服务仍可注入并把状态报告为不支持。
托管 helper 必须先通过文件类型、可执行位与 manifest 哈希校验才能使用；本仓库不提交编译产物，缺失时按签名允许的路径用仓库内的 Swift 源码重建并写入新的 manifest。
helper 缺失、哈希不符、权限未授予、目标进程不接受定向输入、窗口几何在派发前变化等情形都以稳定错误码失败，且不产生任何输入；`danger-full-access` 配 `never` 审批时不弹提示，插件返回可操作的权限错误而不把它记成用户拒绝。

## 行为边界

- 屏幕读取需要屏幕录制权限，只有请求截图时才使用；元素动作只需要辅助功能权限。
- 输入路由到选定进程，不移动系统真实光标；独立 Agent 光标只提示动作落点，不激活应用，也不进入全局事件流。
- 截图作为产物写入会话工作区，其余临时文件使用会话私有临时目录，能力本身不要求 `danger-full-access`。
- 可访问性树是主要动作路径，键盘与坐标输入是回退路径；封面的 canvas、游戏与自绘输入面可能拒绝定向事件，此时以语义动作或键盘替代。
- 只有主 agent 应当使用这一能力：执行工具在 Skill 加载后按 agent 暴露，子 agent 不会自动获得。

以下跨包类型声明来自 [`packages/computer-use/computer-use/src/types.ts`](../../packages/computer-use/computer-use/src/types.ts)。服务方法的完整签名与 JSDoc 由下方 Cordis API 区域生成。

```ts type-equiv
/** Opaque identifier for one immutable observed UI state. */
export type ComputerObservationId = Branded<'ComputerObservationId'>
```

```ts type-equiv
/** Opaque reference to one element descriptor captured inside an observation. */
export type ComputerTargetHandle = Branded<'ComputerTargetHandle'>
```

```ts type-equiv
/** Opaque one-use grant for one confirmed sensitive action. */
export type ComputerConfirmationToken = Branded<'ComputerConfirmationToken'>
```

```ts type-equiv
/** Rectangle in screen-global point coordinates unless a containing type states otherwise. */
export interface ComputerRect {
  x: number
  y: number
  width: number
  height: number
}
```

```ts type-equiv
/** macOS permission state reported without attempting to grant it. */
export type ComputerPermissionState = 'granted' | 'denied' | 'not-determined' | 'unavailable'
```

```ts type-equiv
/** Stable identity of one running user-facing application. */
export interface ComputerAppIdentity {
  bundleId: string
  pid: number
  name: string
}
```

```ts type-equiv
/** Application selector accepted from a model or caller. */
export interface ComputerAppSelector {
  bundleId?: string
  pid?: number
  name?: string
}
```

```ts type-equiv
/** Bounded application row returned by discovery. */
export interface ComputerAppSummary extends ComputerAppIdentity {
  frontmost: boolean
  accessibility: ComputerPermissionState
  screenRecording: ComputerPermissionState
}
```

```ts type-equiv
/** One model-addressable element. Its index and opaque handle belong only to the enclosing observation. */
export interface ComputerElement {
  index: number
  targetHandle: ComputerTargetHandle
  role: string
  subrole?: string
  title?: string
  label?: string
  value?: string
  enabled?: boolean
  focused?: boolean
  selected?: boolean
  frame?: ComputerRect
  actions: string[]
}
```

```ts type-equiv
/** Deterministic route used to resolve a target immediately before input. */
export type ComputerTargetResolutionMode =
  | 'exact-locator'
  | 'native-identifier'
  | 'semantic-rebind'
```

```ts type-equiv
/** Model-visible evidence describing how an element target was resolved. */
export interface ComputerTargetResolutionResult {
  mode: ComputerTargetResolutionMode
  confidence: number
  candidateCount: number
  targetChanged: boolean
}
```

```ts type-equiv
/** File artifact emitted by a Computer Use observation. */
export interface ComputerArtifact {
  path: string
  filename: string
  mimeType: 'image/png'
  kind: 'image'
  description: string
  sourceTool: 'computer_observe' | 'computer_action'
  previewIntent: 'image'
  bytes: number
  width: number
  height: number
}
```

```ts type-equiv
/** Complete model-visible observation. */
export interface ComputerObservation {
  observationId: ComputerObservationId
  app: ComputerAppIdentity
  createdAt: string
  expiresAt: string
  frontmost: boolean
  window?: {
    title?: string
    frame: ComputerRect
    id?: number
  }
  tree: {
    mode: 'full' | 'diff'
    text: string
    truncated: boolean
  }
  elements: ComputerElement[]
  screenshot?: ComputerArtifact
  permissions: {
    accessibility: ComputerPermissionState
    screenRecording: ComputerPermissionState
  }
}
```

```ts type-equiv
/** Whether screenshot capture is omitted, best-effort, or required. */
export type ComputerScreenshotMode = 'none' | 'optional' | 'required'
```

```ts type-equiv
/** Request for a fresh observation. */
export interface ComputerObserveRequest {
  app: ComputerAppSelector
  screenshot?: ComputerScreenshotMode
  full?: boolean
}
```

```ts type-equiv
/** Closed set of supported key modifiers. */
export type ComputerKeyModifier = 'command' | 'control' | 'option' | 'shift'
```

```ts type-equiv
/** Closed set of supported mouse buttons. */
export type ComputerMouseButton = 'left' | 'right' | 'middle'
```

```ts type-equiv
/** Coordinate space accepted by coordinate-based pointer actions. */
export type ComputerCoordinateSpace = 'window' | 'screen'
```

```ts type-equiv
/** Stable target selection fields shared by element-addressed actions. */
export interface ComputerElementTarget {
  /** Observation-local compatibility index. It does not authorize rebinding by itself. */
  elementIndex?: number
  /** Opaque handle returned on the selected observation element. */
  targetHandle?: ComputerTargetHandle
  /** Permit deterministic native-identifier or unique semantic rebinding. */
  allowRebind?: boolean
}
```

```ts type-equiv
/** Click an observed element or an observed-window coordinate. */
export interface ComputerClickAction extends ComputerActionBase, ComputerElementTarget {
  kind: 'click'
  x?: number
  y?: number
  /** `window` (default) resolves `x`/`y` inside the observed window frame; `screen` treats them as Quartz screen-global points. */
  coordinateSpace?: ComputerCoordinateSpace
  button?: ComputerMouseButton
  clickCount?: number
  allowCoordinateFallback?: boolean
}
```

```ts type-equiv
/** Set the Accessibility value of an observed editable element. */
export interface ComputerSetValueAction extends ComputerActionBase, ComputerElementTarget {
  kind: 'set-value'
  value: string
}
```

```ts type-equiv
/** Insert Unicode into the currently focused control through Accessibility or keyboard fallback, without using the clipboard. */
export interface ComputerTypeTextAction extends ComputerActionBase {
  kind: 'type-text'
  text: string
}
```

```ts type-equiv
/** Press one validated key chord. */
export interface ComputerPressKeyAction extends ComputerActionBase {
  kind: 'press-key'
  key: string
  modifiers?: ComputerKeyModifier[]
}
```

```ts type-equiv
/** Scroll at an observed element or coordinate. */
export interface ComputerScrollAction extends ComputerActionBase, ComputerElementTarget {
  kind: 'scroll'
  x?: number
  y?: number
  coordinateSpace?: ComputerCoordinateSpace
  direction: 'up' | 'down' | 'left' | 'right'
  pages?: number
}
```

```ts type-equiv
/** Drag between two points in the observed window or screen coordinate space. */
export interface ComputerDragAction extends ComputerActionBase {
  kind: 'drag'
  fromX: number
  fromY: number
  toX: number
  toY: number
  coordinateSpace?: ComputerCoordinateSpace
}
```

```ts type-equiv
/** Perform one Accessibility action advertised by an observed element. */
export interface ComputerPerformAction extends ComputerActionBase, ComputerElementTarget {
  kind: 'perform-action'
  action: string
}
```

```ts type-equiv
/** Wait for a bounded UI condition without mutating state. */
export interface ComputerWaitAction extends ComputerActionBase {
  kind: 'wait'
  condition: {
    text?: string
    elementRole?: string
    elementTitle?: string
  }
  timeoutMs?: number
}
```

```ts type-equiv
/** Every model-accessible Computer Use action. */
export type ComputerActionRequest =
  | ComputerClickAction
  | ComputerSetValueAction
  | ComputerTypeTextAction
  | ComputerPressKeyAction
  | ComputerScrollAction
  | ComputerDragAction
  | ComputerPerformAction
  | ComputerWaitAction
```

```ts type-equiv
/** Result of a successful action followed by a fresh observation. */
export interface ComputerActionResult {
  action: ComputerActionRequest['kind']
  channel: 'accessibility' | 'coordinates' | 'keyboard' | 'wait'
  /** Verifiable target-app foreground state transition requested by the helper for this action. */
  activation: 'not-requested' | 'already-frontmost' | 'activated'
  /** Whether the helper emitted mouse, drag, or scroll-wheel input to the target process. */
  pointerInput: boolean
  /** Pointer-event route selected by the helper; global HID routing is not supported. */
  pointerRouting: 'none' | 'target-process'
  /** Present when the action addressed an observed element. */
  resolution?: ComputerTargetResolutionResult
  /** Present only when the agent cursor should be on screen and is not. */
  agentCursor?: { visible: false; reason?: string }
  /** What changed in the bounded post-action structural observation. */
  effect: ComputerActionEffect
  observation: ComputerObservation
}
```

```ts type-equiv
/**
 * What changed in the bounded structural observation after an action.
 *
 * The comparison covers the window title, id and frame plus the Accessibility
 * element tree. It does not prove that the action caused the change, and it
 * cannot observe pixel-only, transient, remote, or otherwise external effects.
 */
export interface ComputerActionEffect {
  /** True when the post-action structural state hash differed. */
  observedStateChanged: boolean
  /** How long the settle loop watched, in milliseconds. */
  observedForMs: number
  /** Scope guidance when no structural change was observed. */
  note?: string
}
```

```ts type-equiv
/** Confirmation request binding an exact proposed action to human-readable impact. */
export interface ComputerConfirmRequest {
  action: Omit<ComputerActionRequest, 'confirmationToken'>
  reason: string
  target: string
  dataSummary?: string
}
```

```ts type-equiv
/** One-use confirmation result. */
export interface ComputerConfirmation {
  token: ComputerConfirmationToken
  observationId: ComputerObservationId
  app: ComputerAppIdentity
  expiresAt: string
}
```

```ts type-equiv
/** Caller context required for scoping, cancellation, approval audit, and artifact placement. */
export interface ComputerUseContext {
  agent: Agent
  workspace: string
  callId?: CallId
  signal: AbortSignal
}
```

```ts type-equiv
/** Provider and permission diagnostics exposed to Settings. */
export interface ComputerUseStatus {
  platform: NodeJS.Platform
  provider: 'macos-ax' | 'cua-driver' | 'unsupported'
  generation: number
  ready: boolean
  helperPath: string
  helperVersion?: string
  helperSha256?: string
  accessibility: ComputerPermissionState
  screenRecording: ComputerPermissionState
  lastError?: string
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog`; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcomputeruse--computeruseservice"></a>

### `ctx.computerUse` — `ComputerUseService`

Complete Service Definition plus provider-independent implementation.

```ts cordis-catalog
/**
 * 读取当前提供方与权限诊断，不触发任何探测。
 * @returns 平台、后端名、代次、helper 路径与最近一次健康结果。
 */
status(): ComputerUseStatus

/**
 * 重新执行不修改任何权限与 UI 的提供方健康检查。
 * @param signal - 调用方取消信号；与服务生命周期信号合并后传给后端。
 * @returns 检查后的最新状态；后端失败时抛出并把原因记入状态。
 */
async health(signal: AbortSignal): Promise<ComputerUseStatus>

/**
 * 响应用户的显式设置操作，打开对应的 macOS 隐私面板；插件不自行授予权限。
 * @param kind - 要打开的面板：辅助功能或屏幕录制。
 * @param signal - 调用方取消信号。
 */
async openPermissionSettings(kind: 'accessibility' | 'screen-recording', signal: AbortSignal): Promise<void>

/**
 * 列出有界的运行中用户应用；不读取任何应用的界面内容，因此不需要读取租约。
 * @param context - 发起调用的 agent、工作区、可选的调用 id 与取消信号。
 * @returns 按后端顺序返回的应用摘要，含 bundle id、pid、前台状态与权限状态。
 */
async listApps(context: ComputerUseContext): Promise<ComputerAppSummary[]>

/**
 * 在读取租约通过后取得一份新鲜观察；观察冻结元素索引与目标句柄，后续动作只能引用它。
 * @param request - 目标应用、截图模式与是否强制整树。
 * @param context - 发起调用的 agent、工作区、可选的调用 id 与取消信号。
 * @returns 新的观察，包含观察 id、有界树文本、元素表与可选截图产物。
 */
async observe(request: ComputerObserveRequest, context: ComputerUseContext): Promise<ComputerObservation>

/**
 * 为一个精确的高影响动作申请一次性确认令牌；申请本身不执行任何动作。
 * @param request - 拟执行的动作、影响说明、目标与数据摘要。
 * @param context - 发起调用的 agent、工作区、可选的调用 id 与取消信号。
 * @returns 绑定该应用、观察、目标与动作的令牌及其过期时间。
 */
async confirm(request: ComputerConfirmRequest, context: ComputerUseContext): Promise<ComputerConfirmation>

/**
 * 执行一个绑定到既有观察的动作，并始终返回动作之后的新观察。
 * @param action - 封闭联合中的动作，携带观察 id、目标与可选的一次性确认令牌。
 * @param context - 发起调用的 agent、工作区、可选的调用 id 与取消信号。
 * @returns 动作通道、激活与指针路由事实、结构变化摘要与新观察。
 */
async act(action: ComputerActionRequest, context: ComputerUseContext): Promise<ComputerActionResult>

/**
 * 释放一个已销毁 agent 的全部观察、租约与确认令牌；由服务的 `agent/disposed` 监听调用。
 * @param agent - 已结束的 agent。
 */
releaseAgent(agent: Agent): void
```

Types: [Agent](core.md)

Source: [`packages/computer-use/computer-use/src/service.ts:188`](../../packages/computer-use/computer-use/src/service.ts)
<!-- END GENERATED cordis-surface -->
