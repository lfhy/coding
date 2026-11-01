# Ego 浏览器 Host

`coding-browser-ego-host` 将 [ego-lite](https://github.com/CitroLabs/ego-lite) 的 Node CLI/CDP 运行时接入 Host。需要 Node 22+、本机 Edge、Chrome 或 Chromium、`coding-session` 和 `coding-subprocess`；运行 Web 画面还需要 `coding-host-webserver` 与 `coding-client-connection`。包本身不注册任何 `ego_*` 模型工具：`ctx.egoBrowser.toolDefinitions()` 只返回经过会话检查的定义，由 [按 Agent 审批的消费方](../tool-browser-ego/README.md)决定是否注册为 `browser_*`。宿主不载入归档的上游 Host `apply`，故上游登录导入、设置网关、配对、FFmpeg 下载均不可通过本包访问。

## 当前能力

可用的受限 ego-lite 工具为 `navigate`、`snapshot`、`page_info`、`tabs`（只列出当前会话标签）、`click`（按 selector/ref）、`fill`、`scroll`、`wait`、`wait_for_selector`、`wait_for_url`、`key`、`hover`、`read_element`、`select`、`drag`、`check`、`captcha` 与 `screenshot`。这是宿主可交付工具集合；模型侧是否可用还取决于消费方权限审批。工具执行前后从活跃 Agent 取得真实 Session，完整 session ID 经 SHA-256 映射到唯一空间；`args.space`、`tab`、`targetId` 一律拒绝，未绑定 Session 不可启动浏览器。URL 导航限 HTTP(S)，文件截图仅在工作区根目录独占新建普通 PNG（可选 `path`，无路径时随机生成）；单张截图限 8 MiB，结果输出限 96 KiB。生成图片的附件读取、模型图片预算和审批属于消费方。Host 仅接收结构化参数，脚本模板为固定代码，不把任意模型字符串当 JS 执行。

`webServer` 和 `connection` 同时可用时才注册 `/api/ego/spaces?sessionId`、`/api/ego/stream?sessionId`、`/api/ego/frame?sessionId&targetId`、`/api/ego/activity` 以及 `POST /api/ego/input`。所有入口首先调用 `connection.requestRejection(req)` 并要求 loopback 同源；`spaces` 与 SSE 只发布该 Session 的 target，`frame` 只发布属于该 Session 的目标 JPEG，`activity` 只发布模型工具启动的 `{count,sessionId}`。`input` 需要 JSON `{sessionId,targetId,type,...}`，严格核对目标存在、仍属于该 Session、视口坐标合法并剔除多余 CDP 字段后才调用 worker；错误不派发任何输入。画面使用只读 CDP 截图轮询；工作台隐藏时 Client 断开 SSE。未命中的 `/api/ego/*` 与 `/ego/api/*` 不由本包注册，不能访问上游 settings、login、watch、resize、close 或 FFmpeg 路由。

浏览器 Profile/状态由 ego-lite 在用户目录保存，不在 Coding 项目根：Unix/macOS 默认分别为 `~/.local/share/ego-lite-linux/profile` 与 `~/.local/state/ego-lite-linux/`，Windows 默认 `%LOCALAPPDATA%/ego-lite-linux/`；可使用 `XDG_DATA_HOME`、`XDG_STATE_HOME`、`EGO_LINUX_STATE_DIR` 与 `EGO_LINUX_PROFILE` 设置实际位置。这些目录可能含网站登录态、浏览记录和空间 target 信息，**不要提交或分享**。Host 强制 `EGO_ISOLATE_SPACES=1`，每个任务空间使用独立 Chromium context；context 创建失败会拒绝运行而不是降级共用页面。运行时依赖本机已经安装的浏览器，不下载浏览器或 FFmpeg。临时目录中隔离的真机 Edge 测试不会触碰默认 Profile。

## 验证

从仓库根运行：

```sh
pnpm exec tsc -b packages/browser/browser-ego-host/tsconfig.json
pnpm exec vitest run packages/browser/browser-ego-host/tests
DSH_EGO_EDGE_SMOKE=1 pnpm exec vitest run packages/browser/browser-ego-host/tests/edge-smoke.spec.ts
```

最后一条仅在 macOS 安装 Edge 时运行，自动创建独立临时 XDG 数据目录并在结束后停止该次浏览器；其它测试不要求浏览器。来源、原始授权、快照增补见 [许可来源说明](NOTICE.md)。

## Model Experience

### What the model sees

此包不直接向模型注册工具、提示词或上下文；消费方选择后的 `browser_*` 工具使用本包受限参数与规范 JSON 结果，只有成功调用才进入历史。非 `screenshot` 工具不输出模型图片；上游帮助、裸 JS/CDP/HTTP、Cookie 导入、任意空间操作不对模型开放。

### Token effect

此包单独挂载不增加模型请求 token；消费方注册有限工具后 schema 和调用结果按正常工具流水线计入 token。

### KV Cache effect

此包不修改模型请求前缀；仅消费方工具集合变化时改变工具 schema 前缀。

## Known Limitations and Deferred Work

- 上游 34 个工具并未全部开放：`upload`、`download`、`dialog`、`wait_for_response`、`wait_for_human` 需要文件边界、对话权限或事件语义重新审核；裸脚本/JS/CDP/HTTP、空间管理、login import、auth flush 以及 FFmpeg 路由不提供。安全工具目前采用上游 ego-browser facade 的固定模板，参数与上游完整 schema 不完全相同；不能把上游模型指南当作本包完整能力清单。
- `stream` 当前每秒采集本会话活动页；选择非活动页时 Client 应按需调用 `/api/ego/frame?sessionId&targetId`。没有该补充查询，非活动页没有流式画面。
- 本地 loopback worker 本身是上游进程，不能作为网络安全边界；Host 入口只信任 `connection` 与同源 loopback。不同 Host 实例共享同一上游 Profile 时应按部署单实例管理，避免 worker/状态文件互相抢占。
