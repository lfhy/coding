# browser-playwright

`@deepseek-ai/dsh-browser-playwright` 在 Host 中实现 `ctx.browserUse`，不依赖 Web Host：首次模型导航或人工 `ensure-tab`/`new-tab` 为会话建立独立的 Chromium 内存上下文与空白页面，初始视口为 1280×720。人工 `set-viewport` 可在会话已存在时调整全部页面的真实视口，宽 200–1920、高 240–1400、面积至多 1,800,000 像素；未知会话返回 `undefined`，相同尺寸不发布新状态。尺寸变化使审批修订版和旧元素引用失效，活动页重新截图，切回后台页时刷新过时画面。单击工作台只创建 `about:blank`，不会偷偷导航；`new-tab` 真正新增页面，最多每会话 8 页。模型对未知或关闭会话的非导航命令返回 `BROWSER_CLOSED`；再次导航建立新上下文与 generation。模型与人工操作按会话串行执行；元素引用只在产生它的标签页、generation 和 revision 下有效，审批前的空会话或已有标签页目标在执行队列中复核；会话 generation 与状态修订版也必须匹配，因此同 URL 刷新、尺寸变化或切离后切回均使审批失效。空白页也带页面 generation。每次成功页面操作发布不超过 12,000 字符的页面文本与最多 150 个视口内可见元素、最多 2 MiB PNG 画面；元素扫描最多遍历 50,000 个 DOM 节点，以免极大页面无界占用资源。密码框元素名不会读取输入值。标题上限 4096 字符，交互指针留在视口内。最多同时持有 8 个会话，空闲 10 分钟的会话定期回收；关闭最后一页、`closeSession`、模型 `close`、会话销毁、调用方中止以及插件卸载会释放页面与连接。中止或不确定的操作失败不会发布新观测。

本包没有配置项。浏览器直接使用 Chromium 原生网络栈，不设置代理、目的地允许列表、公私网或 DNS 地址检查，也不拦截 HTTP 请求、重定向或子资源；页面可访问浏览器支持的网络目的地，包括环回与私网服务，WebSocket（`ws`／`wss`）和普通服务工作线程可用。Chromium 的 TLS 证书验证、同源与 CORS 等标准安全机制保持启用。

模型和人工 `navigate` 的输入必须是无用户信息凭据的绝对 HTTP(S) URL，最多 4096 字符；格式、凭据和长度校验只检查命令输入，不筛选网络目的地。下载、弹窗和授予页面浏览器权限不可用。Chromium 缺失时返回 `BROWSER_UNAVAILABLE`，需安装与锁定 Playwright 版本匹配的 Chromium (`pnpm exec playwright install chromium`)；不会复用桌面 Host 应用窗口。

当 composition 同时具有 `webServer` 与 `connection` 时，Web Host 注册只读 GET `/browser-use/state?sessionId=` 与 `/browser-use/frame?sessionId=&tabId=&browserGeneration=&stateRevision=&generation=&revision=`；headless 模式不注册 HTTP 路由。状态返回完整标签页状态，未知或关闭会话返回 204；画面请求必须同时匹配会话、活跃标签页、会话与页面 generation、状态与页面 revision，未知会话返回 404，过期或无截图返回 409。响应不缓存；服务先经过 composition 的 `connection.requestRejection`，再限制服务器和请求来源为环回地址及同源 Host/Origin。这是 Host 预览 API 的入站信任限制，与页面的出站联网无关；这里不提供页面写入 HTTP 路由。

真实 Chromium 环回验收为可选检查：安装匹配版本的 Chromium 后运行 `DSH_BROWSER_E2E=1 pnpm exec vitest run packages/browser/browser-playwright/tests/chromium-fixture.spec.ts`。普通 keyless 单测不下载浏览器，也不依赖图形桌面。

## Model Experience

本包不直接写入模型上下文；模型只通过浏览器工具消费有界观测。

#### KV Cache effect

本包不维护模型请求或缓存前缀。观测内容由消费方加入会话历史时才影响后续请求。

## Known Limitations and Deferred Work

- 页面截图超过 2 MiB 时操作失败、清除该标签页的旧画面和元素引用，但保留会话、标签页与历史；缩小视口或再次采集成功后恢复画面。目前不缩放或有损压缩截图；其他不确定的页面操作失败仍会关闭会话。
