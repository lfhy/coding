# browser-playwright

`@deepseek-ai/dsh-browser-playwright` 在 Host 中实现 `ctx.browserUse`，不依赖 Web Host：首次 `navigate` 为会话建立独立的 Chromium 内存上下文、页面和环回代理，视口固定为 1280×720。尚未导航或关闭后的其他操作返回 `BROWSER_CLOSED`；再次导航产生新的 generation。调用按会话串行执行；元素引用只在产生它的 generation 和 revision 下有效，过期引用拒绝执行。每次成功操作发布不超过 12,000 字符的页面文本与最多 150 个视口内可见元素、最多 2 MiB PNG 画面；元素扫描最多遍历 50,000 个 DOM 节点，以免极大页面无界占用资源。密码框元素名不会读取输入值。标题上限 4096 字符，交互指针留在视口内。最多同时持有 8 个会话，空闲 10 分钟的会话定期回收；`closeSession`、`close`、会话销毁、调用方中止以及插件卸载会释放页面、代理与连接。中止或不确定的操作失败不会发布新观测。

配置 `allowedOrigins` 默认为 `[]`，仅允许 DNS 全部答案均为公网地址的 HTTP(S) 请求；特殊用途地址段（包括 Teredo、IPv6 基准测试和文档地址）默认拒绝。配置条目必须是无凭据、无路径的精确 origin，例如 `http://127.0.0.1:8080`；此授权同时放行该 origin 的导航、重定向与子资源。放行环回 origin 等同于授予页面访问该本机服务的权限，应只针对可信的测试或明确授权的部署使用。Chromium context 强制通过会话独占、随机凭据保护的环回代理处理 HTTP 与 HTTPS；未认证的本机代理客户端收到 407。代理对每一次请求及重定向逐跳解析所有 DNS 答案，并直接连接已核准的 IP，不再让连接层二次解析主机名。HTTP 保留原 Host 并清理请求与响应的逐跳字段；HTTPS CONNECT 保留 Chromium 的 TLS SNI 和证书验证。升级及非 HTTP(S) 不可用，WebSocket、下载、弹窗、服务工作线程与浏览器权限不可用。Chromium 缺失时返回 `BROWSER_UNAVAILABLE`，需安装与锁定 Playwright 版本匹配的 Chromium (`pnpm exec playwright install chromium`)；不会复用桌面 Host 应用窗口。

当 composition 同时具有 `webServer` 与 `connection` 时，Web Host 注册只读 GET `/browser-use/state?sessionId=` 与 `/browser-use/frame?sessionId=&generation=&revision=`；headless 模式不注册 HTTP 路由。状态返回观测字段和 `hasFrame`，未知或关闭的会话返回 204；画面返回 PNG，未知会话返回 404，过期帧返回 409。响应不缓存；服务先经过 composition 的 `connection.requestRejection`，再限制服务器和请求来源为环回地址及同源 Host/Origin。这里不提供页面写入 RPC。

真实 Chromium 环回验收为可选检查：安装匹配版本的 Chromium 后运行 `DSH_BROWSER_E2E=1 pnpm exec vitest run packages/browser/browser-playwright/tests/chromium-fixture.spec.ts`。普通 keyless 单测不下载浏览器，也不依赖图形桌面。

## Model Experience

本包不直接写入模型上下文；模型只通过浏览器工具消费有界观测。

#### KV Cache effect

本包不维护模型请求或缓存前缀。观测内容由消费方加入会话历史时才影响后续请求。

## Known Limitations and Deferred Work

- 代理仅约束 Chromium 经 HTTP(S) 代理发出的流量；QUIC 和非代理 WebRTC UDP 已禁用，但浏览器进程未置于 OS 级网络沙箱，不应将此策略视为所有协议的隔离保证。
- 页面截图超过 2 MiB 时操作失败并关闭该会话；目前不缩放或有损压缩截图。
