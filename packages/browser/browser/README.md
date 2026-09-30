# @deepseek-ai/dsh-browser

`BrowserUseService` 是 `ctx.browserUse` 的 Service Definition：Provider 为每个 `SessionId` 持有独立浏览器上下文和标签页，Consumer 通过统一命令执行导航、页面读取与交互。本包不启动浏览器、不注册工具，也不决定 URL 访问许可。

## 服务 API

`execute(sessionId, command, signal, expectedTarget?)` 执行一次 `BrowserCommand`，返回 `BrowserCapture`；可选 `expectedTarget` 以 `kind: 'none'` 绑定调用前不存在的会话，或以 `kind: 'tab'` 绑定会话 generation、状态修订版、标签页 id、页面 generation 和可选 URL，执行队列中任一目标变化均拒绝，包括同 URL 刷新和切离后切回。每次人工选择标签页、导航及发布新观测均递增状态修订版，重复选择当前页也不例外。`latest(sessionId)` 同步读取活跃标签页最近成功发布的捕获；空白标签页、尚未产生观测或关闭后返回 `undefined`。`state(sessionId)` 同步读取标签页列表、活跃标签页与最近观测；未知或关闭会话返回 `undefined`。`control(sessionId, command, signal)` 串行处理人工命令，关闭最后一页后返回 `undefined`。`closeSession(sessionId)` 等待该会话资源停止；不存在资源时正常完成。Provider 必须隔离会话、拒绝过期元素修订版，并在拒绝或取消时不发布新观测。调用方中止时保留 `AbortSignal` 的原因。

模型命令为封闭判别联合：`navigate` 携带 URL；`snapshot` 读取页面；`click` 和 `fill` 携带元素 `ref` 与观测 `revision`；`scroll` 携带方向与像素量；`screenshot` 获取图像；`close` 关闭会话。人工命令包含幂等的 `ensure-tab`、新增 `new-tab`、带 `BrowserTabId` 的 `select-tab` 和 `close-tab`，以及 `navigate`、`back`、`forward`、`reload`、`set-viewport(width,height)`。`BrowserSessionState` 包含 `browserGeneration`、`stateRevision`、当前视口、带页面 generation 的标签页摘要、活跃标签页 id、观测与截图存在标记；空白页也有可绑定目标身份的 generation。视口由 Provider 校验边界并按会话应用于所有页面，尺寸改变会使旧截图和元素引用失效，重新发布活跃页观测。`BrowserObservation` 包含标签页 id、`generation`、`revision`、最终 URL、标题、文本快照、视口和最后操作指针。不同标签页、generation 或观测修订版之间不得复用元素引用；捕获中的 `png` 与可序列化的观测分离。类型可从包入口或 `@deepseek-ai/dsh-browser/types` 导入。

Provider 通过 `BrowserUseError.code` 报告 `BROWSER_INVALID_URL`、`BROWSER_STALE_REF`、`BROWSER_CLOSED`（已关闭会话上的操作）、`BROWSER_DENIED`、`BROWSER_UNAVAILABLE` 或 `BROWSER_FAILED`；取消原因直接向调用方传播。跨进程/RPC、页面和模型 JSON 输入的校验，以及网络与页面权限检查必须发生在实际做出相应决定的 Provider 或 Consumer 边界。这个抽象服务没有配置项、事件或注册器；Cordis 仅允许当前 context 的一个实现。

## Model Experience

通过使用本服务的 Consumer 间接影响模型；本包本身不注册提示词、工具 schema 或模型可见文本。具体工具决定截图、页面快照及失败如何进入会话日志和模型上下文。

#### KV Cache effect

本包不修改模型请求前缀，也不直接影响 KV Cache；Consumer 添加或替换模型可见内容时自行决定请求和缓存行为。

## Known Limitations and Deferred Work

- 活页状态和最近捕获只存在于 Provider 运行期间；本接口不定义重启后的页面恢复或跨会话共享。
- 本接口不订阅画面变化；界面在执行操作后读取状态与捕获，实时浏览器镜像需要另行定义传输和授权。
