# @deepseek-ai/dsh-browser

`BrowserUseService` 是 `ctx.browserUse` 的 Service Definition：Provider 为每个 `SessionId` 持有独立浏览器上下文和标签页，Consumer 通过统一命令执行导航、页面读取与交互。本包不启动浏览器、不注册工具，也不决定 URL 访问许可。

## 服务 API

`execute(sessionId, command, signal, expectedTarget?)` 执行一次 `BrowserCommand`，返回 `BrowserCapture`；可选 `expectedTarget` 以 `kind: 'none'` 绑定调用前不存在的会话，或以 `kind: 'tab'` 绑定会话 generation、由 `prepareTarget` 提供的不透明目标修订版、标签页 id、页面 generation 和可选 URL，执行队列中任一目标变化均拒绝，包括同 URL 刷新和切离后切回。目标修订版不要求等同于 `state(sessionId)` 发布的 UI 状态修订版；调用方必须原样传递 `prepareTarget` 的结果。`latest(sessionId)` 同步读取活跃标签页最近成功发布的捕获；空白标签页、尚未产生观测或关闭后返回 `undefined`。`state(sessionId)` 同步读取标签页列表、活跃标签页与最近观测；未知或关闭会话返回 `undefined`。`control(sessionId, command, signal)` 串行处理人工命令，关闭最后一页后返回 `undefined`。`closeSession(sessionId)` 等待该会话资源停止；不存在资源时正常完成。Provider 必须隔离会话、拒绝过期元素修订版，并在拒绝或取消时不发布新观测。调用方中止时保留 `AbortSignal` 的原因。

模型消费方在审批前调用 `acquireOperation(sessionId, signal)`：提供方立即阻止新人工命令，排空此前已接纳的操作，然后消费方调用 `prepareTarget(sessionId, signal)` 绑定审批与执行共用的目标；执行和结果保存后须在 `finally` 调用返回的幂等释放函数。`prepareTarget` 默认从已发布状态取得身份，活页 Provider 可在队列中只刷新当前页面 URL 与文档身份，不读取页面内容或截图；这允许页面在两次模型工具调用之间自行导航后按新目标重新申请审批。审批等待期间目标继续变化仍由 `execute` 拒绝，不沿用旧审批或元素引用。占用期间 `control` 和同会话第二次占用均返回 `BROWSER_BUSY`，`operationActive(sessionId)` 对尚无浏览器资源的会话也可读取。会话状态同时携带 `operationActive`，拒绝或取消不会留下占用。

模型命令为封闭判别联合：`navigate` 携带 URL；`snapshot` 读取页面；`click` 和 `fill` 携带元素 `ref` 与观测 `revision`；`scroll` 携带方向与像素量；`screenshot` 获取图像；`close` 关闭会话。人工命令包含幂等的 `ensure-tab`、新增空白页的 `new-tab`、在同一提供方队列中创建并选中新标签页后导航到 URL 的 `open-url`、带 `BrowserTabId` 的 `select-tab` 和 `close-tab`，以及作用于当前页的 `navigate`、`back`、`forward`、`reload`、`set-viewport(width,height)`。`open-url` 不属于模型命令，也不改变 `new-tab` 或 `navigate` 的既有行为。`BrowserSessionState` 包含 `browserGeneration`、`stateRevision`、当前视口、带页面 generation 的标签页摘要、活跃标签页 id、观测与截图存在标记；空白页也有可绑定目标身份的 generation。视口由 Provider 校验边界并按会话应用于所有页面，尺寸改变会使旧截图和元素引用失效，重新发布活跃页观测。`BrowserObservation` 包含标签页 id、`generation`、`revision`、最终 URL、标题、文本快照、视口和最后操作指针。不同标签页、generation 或观测修订版之间不得复用元素引用；捕获中的 `png` 与可序列化的观测分离。类型可从包入口或 `@deepseek-ai/dsh-browser/types` 导入。

截图人工操作 `click`、`scroll`、`type` 带视口内整数坐标及 `BrowserHumanTarget`：会话 generation、状态 revision、标签页 id、页面 generation、观测 revision 和视口。提供方在队列中核对全部身份、当前截图和页面 URL，过期则以 `BROWSER_STALE_REF` 拒绝且不触碰页面；`type` 点选坐标后插入文本，不替换已有输入，也不模拟键盘按键事件。

`control` 的可选异步 `guard` 在提供方队列中、任何页面副作用前执行；网络入口可用它复核会话附着和远程工作区状态，拒绝时命令不执行。`expectedTarget.stateRevision` 是审批目标令牌，人工截图目标的 `stateRevision` 是已发布 UI 状态修订版；两者都必须在页面自行导航时失效，包括同 URL 重载，但不要求相同。只读状态不得继续供应过期截图。

Provider 通过 `BrowserUseError.code` 报告 `BROWSER_INVALID_URL`、`BROWSER_STALE_REF`、`BROWSER_CLOSED`（已关闭会话上的操作）、`BROWSER_DENIED`、`BROWSER_UNAVAILABLE` 或 `BROWSER_FAILED`；取消原因直接向调用方传播。跨进程/RPC、页面和模型 JSON 输入的校验，以及页面操作权限检查必须发生在实际做出相应决定的 Provider 或 Consumer 边界；本接口不要求网络目的地过滤。这个抽象服务没有配置项、事件或注册器；Cordis 仅允许当前 context 的一个实现。

## Model Experience

通过使用本服务的 Consumer 间接影响模型；本包本身不注册提示词、工具 schema 或模型可见文本。具体工具决定截图、页面快照及失败如何进入会话日志和模型上下文。

#### KV Cache effect

本包不修改模型请求前缀，也不直接影响 KV Cache；Consumer 添加或替换模型可见内容时自行决定请求和缓存行为。

## Known Limitations and Deferred Work

- 活页状态和最近捕获只存在于 Provider 运行期间；本接口不定义重启后的页面恢复或跨会话共享。
- 本接口不订阅画面变化；界面在执行操作后读取状态与捕获，实时浏览器镜像需要另行定义传输和授权。
