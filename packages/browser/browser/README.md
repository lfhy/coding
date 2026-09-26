# @deepseek-ai/dsh-browser

`BrowserUseService` 是 `ctx.browserUse` 的 Service Definition：Provider 为每个 `SessionId` 持有独立页面，Consumer 通过统一命令执行导航、页面读取与交互。本包不启动浏览器、不注册工具，也不决定 URL 访问许可。

## 服务 API

`execute(sessionId, command, signal)` 执行一次 `BrowserCommand`，返回 `BrowserCapture`。`latest(sessionId)` 同步读取最近成功发布的捕获；会话尚未产生观测或关闭后返回 `undefined`。`closeSession(sessionId)` 等待该会话资源停止；不存在资源时正常完成。具体 Provider 必须隔离会话、拒绝过期元素修订版，并在拒绝或取消时不发布新观测。调用方中止时保留 `AbortSignal` 的原因。

命令为封闭判别联合：`navigate` 携带 URL；`snapshot` 读取页面；`click` 和 `fill` 携带元素 `ref` 与观测 `revision`；`scroll` 携带方向与像素量；`screenshot` 获取图像；`close` 关闭页面。`BrowserObservation` 包含 `generation`、`revision`、最终 `url`、`title`、文本 `snapshot`、`viewport` 和最后操作 `cursor`。不同 `generation` 之间不得复用元素引用；捕获中的 `png` 是可选 PNG 字节，与可序列化的 `observation` 分离。类型可从包入口或 `@deepseek-ai/dsh-browser/types` 导入。

Provider 通过 `BrowserUseError.code` 报告 `BROWSER_INVALID_URL`、`BROWSER_STALE_REF`、`BROWSER_CLOSED`（已关闭会话上的操作）、`BROWSER_DENIED`、`BROWSER_UNAVAILABLE` 或 `BROWSER_FAILED`；取消原因直接向调用方传播。跨进程/RPC、页面和模型 JSON 输入的校验，以及网络与页面权限检查必须发生在实际做出相应决定的 Provider 或 Consumer 边界。这个抽象服务没有配置项、事件或注册器；Cordis 仅允许当前 context 的一个实现。

## Model Experience

通过使用本服务的 Consumer 间接影响模型；本包本身不注册提示词、工具 schema 或模型可见文本。具体工具决定截图、页面快照及失败如何进入会话日志和模型上下文。

#### KV Cache effect

本包不修改模型请求前缀，也不直接影响 KV Cache；Consumer 添加或替换模型可见内容时自行决定请求和缓存行为。

## Known Limitations and Deferred Work

- 活页状态和最近捕获只存在于 Provider 运行期间；本接口不定义重启后的页面恢复或跨会话共享。
- 本接口不订阅画面变化；界面只能在执行操作后读取捕获，实时浏览器镜像需要另行定义传输和授权。
