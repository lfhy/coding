# browser-electron

`@deepseek-ai/dsh-browser-electron` 仅在桌面 Host 中替换 `ctx.browserUse`；同一个 Electron guest 同时承接工作台人工操作和 Agent 命令。Web/CLI 仍由 [Playwright 提供方](../browser-playwright/README.md)拥有。桌面主进程先在 `127.0.0.1` 绑定私有 WebSocket，再启动 Host；插件配置 `originEnv` 和 `tokenEnv` 是环境变量的名称，不含端口或凭据。Host 通过 `Authorization: Bearer` 连接，令牌不会进入 URL、插件配置或只读画面。

模型操作从审批到执行结束独占会话；人工操作按会话排队，并在命令发送前执行准入复核。审批目标由主进程即时刷新；页面自行导航通过状态事件撤销旧截图与审批修订版。原生导航超过 10 秒仍未完成时，主进程尝试停止加载，并在 3 秒内确认旧导航停稳；成功停稳仍返回失败、使旧观测与审批失效，但保留同一个 guest，下一次单独获批的 `browser_snapshot` 可读取当前页面。无法安全停稳则只关闭受影响的 Session。Host 私有桥的 20 秒请求超时、取消或连接断开仍终止整个连接并清除会话缓存；当前 Host 进程不自动重连，也不改道至另一提供方。每次连接最多保留八个会话，每会话最多八个标签页，PNG 最多 2 MiB；跨进程字段均受校验。主进程在协议的 `lease`/`release` 期间阻止未经授权的人工变更，并在 `execute` 时再次校验 `expectedTarget`。

原生 guest 尚未在工作台呈现时，普通操作只读取 DOM 观测并返回 `png: null`；此时显式 `browser_screenshot` 报告不可用。已呈现页面的截图捕获超过 5 秒时只关闭受影响的 Session，其他 Session 及私有连接保留。

同时挂载 `webServer` 与 `connection` 时，本包提供只读 `/browser-use/state`、`/browser-use/frame`，保持 Playwright 提供方的状态码、截图版本和环回同源入站限制。没有 Web Host 服务时不注册路由。此包不直接写入模型上下文；模型结果仍由浏览器工具消费方记录。无法连接桌面主进程时返回 `BROWSER_UNAVAILABLE`，不启动独立浏览器。

## Model Experience

本包不直接提供模型上下文；模型间接通过[浏览器工具消费方](../tool-browser/README.md)取得观测。

#### KV Cache effect

提供方不修改模型请求；仅已记录的工具结果影响后续模型上下文。

## Known Limitations and Deferred Work

原生导航与截图超时按上述单 Session 规则处理；私有桥请求超时、取消和连接断开会终止此 Host 进程的全部桌面浏览器会话。
