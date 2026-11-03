# Ego 浏览器 Host

`coding-browser-ego-host` 将 [ego-lite](https://github.com/CitroLabs/ego-lite) 的 Node CLI/CDP 运行时接入 Host。需要 Node 22+、本机 Edge、Chrome 或 Chromium、`coding-session` 和 `coding-subprocess`；运行 Web 画面还需要 `coding-host-webserver` 与 `coding-client-connection`。包本身不注册任何 `ego_*` 模型工具：`ctx.egoBrowser.toolDefinitions()` 只返回经过会话检查的定义，由 [按 Agent 审批的消费方](../tool-browser-ego/README.md)决定是否注册为 `browser_*`。宿主不载入归档的上游 Host `apply`，故上游登录导入、设置网关、配对、FFmpeg 下载均不可通过本包访问。

## 当前能力

上游 v0.9.7 的 35 个工具全部移植：`status`、`auth_flush`、`login_import`、`space_open`、`space_close`、`snapshot`、`navigate`、`click`、`fill`、`js`、`cdp`、`screenshot`、`page_info`、`tabs`（列出/打开/切换/关闭）、`wait`、`wait_for_selector`、`wait_for_url`、`wait_for_response`、`key`、`hover`、`read_element`、`select`、`drag`、`scroll`、`upload`、`download`、`check`、`dialog`、`http`、`cli`、`captcha`、`wait_for_human`、`help`、`doctor`、`script`。消费方统一以 `browser_*` 注册，参数形状与上游 schema 一致；审批、Remote-SSH 拒绝与结果上限由消费方执行。Host 将省略的 `space`、空字符串与 `default` 都视为当前会话空间，并将 `space_open`／`space_close` 的 `name: "default"` 映射到本会话；显式指定其他空间仍拒绝，不能用空值绕过隔离。`cli`／`script` 执行前先进入当前会话空间，页面才会出现在该会话工作台。默认每个会话独立任务空间（上游 `sessionScopedSpaces`），浏览器 Profile 持久保存在用户目录，跨会话共享登录态但页面/标签隔离。

宿主的 `third-party/upstream/src/` 是上游 Host 源码，构建产物 `third-party/upstream/lib/index.js` 才是运行时入口；`apply()` 收集全部工具定义并由本包暴露，同时注册上游观察窗路由。上游 `/api/ego/*` 与 `/ego/api/*` 统一经过本项目 `connection.requestRejection` 与回环同源栅栏；`spaces`、`stream`、`frame`、`input`、`navigation`、`close`、`status`、`history` 使用本项目按会话过滤的实现，其余上游路由（设置网关、登录导入、watch、video 等）在通过同一栅栏后可用。

`webServer` 和 `connection` 同时可用时才注册 `/api/ego/spaces?sessionId`、`/api/ego/stream?sessionId`、`/api/ego/frame?sessionId&targetId`、`/api/ego/activity` 以及 `POST /api/ego/input`、`POST /api/ego/navigation`、`POST /api/ego/pages`、`POST /api/ego/hover`。所有入口在读取载荷或启动 worker 前调用 `connection.requestRejection(req)` 并要求 loopback 同源；`spaces` 与 SSE 只发布该 Session 的 target，`frame` 只发布属于该 Session 的目标 JPEG，`activity` 向新连接回放存活会话最近一次活动，再广播新工具启动的会话与计数，不携带页面或画面。`pages` 只接受所属 Session，空会话复用空白锚页，否则在该空间新建页面并复核目标归属；同会话并发请求串行化且页面数不超过 30。`hover` 接受经过边界映射的 CSS 视口坐标，仅对本会话 target 投递鼠标移动并返回受限标准光标、标题及无凭据 HTTP(S) 链接；跨源子帧无法读取其 DOM。worker 的封闭 `GET /api/frame?targetId` 只采集当前存在页面的 JPEG 与实测 CSS 视口 `{targetId,data,vw,vh,ts}`；会话归属由 Host 再核验。`input` 需要 JSON `{sessionId,targetId,type,...}`，严格核对目标存在且属于该 Session，鼠标坐标在视口内；文本输入有界，`keyDown`/`keyUp` 仅接受受限导航键的 `key`、`code`、`windowsVirtualKeyCode`、`modifiers` 并剔除其余 CDP 字段。错误不派发输入。画面使用只读 CDP 截图轮询；工作台隐藏时 Client 断开 SSE。未命中的 `/api/ego/*` 与 `/ego/api/*` 不由本包注册，不能访问上游 settings、login、watch、resize、close 或 FFmpeg 路由。

`POST /api/ego/navigation` 接受 JSON `{sessionId,targetId?,action,url?}`，`action` 仅为 `navigate`、`reload`、`back`、`forward`；`navigate` 必须带绝对无凭据 HTTP(S) 或严格本地 `file:///` URL，其他动作不得带 URL。Host 拒绝多余字段与跨会话 target，确认目标仍存在并清洗转发到 worker 封闭的 `POST /api/navigation`；worker 对已有 target 分别执行 CDP `Page.navigate`、`Page.reload`、`Page.getNavigationHistory` + `Page.navigateToHistoryEntry`，无历史项或 CDP 失败返回 `ok:false`，不调用模型工具。仅在该会话没有登记页面且没有提供 `targetId` 的 `navigate` 请求中，Host 用 ego-lite CLI 的 `taskSpaces.useOrCreate`/`ego.createTab` 在本会话空间创建页面，再复核目标归属；CLI 脚本以 `page` 为预置变量，Host 的局部变量不得与其同名。其他缺少目标的请求均拒绝。人工操作不写入模型输入或其他会话。

浏览器 Profile/状态由 ego-lite 在用户目录保存，不在 Coding 项目根：Unix/macOS 默认分别为 `~/.local/share/ego-lite-linux/profile` 与 `~/.local/state/ego-lite-linux/`，Windows 默认 `%LOCALAPPDATA%/ego-lite-linux/`；可使用 `XDG_DATA_HOME`、`XDG_STATE_HOME`、`EGO_LINUX_STATE_DIR` 与 `EGO_LINUX_PROFILE` 设置实际位置。这些目录可能含网站登录态、浏览记录和空间 target 信息，**不要提交或分享**。Host 强制 `EGO_ISOLATE_SPACES=1`，每个任务空间使用独立 Chromium context；context 创建失败会拒绝运行而不是降级共用页面。运行时依赖本机已经安装的浏览器，不下载浏览器或 FFmpeg。临时目录中隔离的真机 Edge 测试不会触碰默认 Profile。

## 运行位置与交互细节

- **默认无窗口**：`headless` 默认开启，浏览器只在工作台面板里出现，不会把独立窗口弹到用户前台。配置为 `false` 才回到可见窗口。启动模式记录在浏览器状态文件里：复用一个旧状态（没有记录）或与当前配置不一致的实例时先关闭再按配置启动，因此切换设置或升级后不会继续沿用旧窗口；`--open` 打开的窗口有自己的意图记录，下一次工具调用不会把它关掉。用户在面板里主动要求换窗口时走 `POST /api/ego/window`（JSON `{sessionId}`，会话有效才执行），Host 用运行时的 `--open` 换成同 Profile 的可见窗口，登录扫码与人机验证都在这个入口完成。
- **页面光标标签**：`cursorName` 默认 `Agent`，通过 `EGO_LINUX_CURSOR_NAME` 传给运行时；模型渠道是逐会话选择的，因此默认标签只描述角色，不写具体厂商。面板的窗口入口复用同一份环境（由上游按当前设置计算），因此换成可见窗口后光标标签与启动模式仍与配置一致。
- **CSS 选择器范围**：`ego_click`、`ego_hover` 对 CSS 目标先在顶层文档定位；找不到时回退到穿透 open shadow root 与同源 iframe 的查找，再按元素中心发真实鼠标事件。多匹配、无效选择器与不可见目标仍以原错误失败，不会改点别的元素。
- **标签页错误**：`ego_tabs` 的 `switch`/`close` 先读取当前任务空间实际存在的 id；目标不属于该空间时返回可操作的说明与现存 id 列表，`open` 失败返回底层原因。脚本只声明一次空间变量，避免整条工具调用因重复声明而失败。

## 验证

从仓库根运行：

```sh
pnpm exec tsc -b packages/browser/browser-ego-host/tsconfig.json
pnpm exec vitest run packages/browser/browser-ego-host/tests
DSH_EGO_EDGE_SMOKE=1 pnpm exec vitest run packages/browser/browser-ego-host/tests/edge-smoke.spec.ts
```

修改 `third-party/host/worker/` 后，从包目录重建已跟踪的 worker 入口（不编辑 `bin/` 生成代码）：`pnpm exec tsdown third-party/host/worker/ego-cast-worker.ts --no-config --out-dir bin --no-clean --format esm --platform node --target es2024 --no-dts --no-sourcemap`。运行时入口是 `bin/ego-cast-worker.mjs`，源码变更须与其一同交付；它只依赖 Node 22.19+/24 自带的 `WebSocket`，无需运行时安装 `ws`。

仅在 macOS 安装 Edge 时运行第三条验证命令，自动创建独立临时 XDG 数据目录并在结束后停止该次浏览器；其它测试不要求浏览器。来源、原始授权、快照增补见 [许可来源说明](NOTICE.md)。

## Model Experience

### What the model sees

此包不直接向模型注册工具、提示词或上下文；消费方选择后的 `browser_*` 工具使用本包受限参数与规范 JSON 结果，只有成功调用才进入历史。非 `screenshot` 工具不输出模型图片；上游帮助、裸 JS/CDP/HTTP、Cookie 导入、任意空间操作不对模型开放。

### Token effect

此包单独挂载不增加模型请求 token；消费方注册有限工具后 schema 和调用结果按正常工具流水线计入 token。

### KV Cache effect

此包不修改模型请求前缀；仅消费方工具集合变化时改变工具 schema 前缀。

## Known Limitations and Deferred Work

- 上游全部 35 个工具均已注册；风险由消费方按会话审批与 Remote-SSH 拒绝兜底。上游 Web/TUI 的完整前端与 `src/client` 未移植，右侧面板是本项目自行实现，因此部分上游面板专属控件（动作历史抽屉、视频后端切换、设置页）只部分对齐。
- 视频采集需 `captureBackend=ffmpeg` 与本机 FFmpeg，默认 CDP 画面；上游 FFmpeg 下载服务未接入。
- `stream` 当前每秒采集本会话活动页；选择非活动页时 Client 应按需调用 `/api/ego/frame?sessionId&targetId`。没有该补充查询，非活动页没有流式画面。
- 本地 loopback worker 本身是上游进程，不能作为网络安全边界；Host 入口只信任 `connection` 与同源 loopback。不同 Host 实例共享同一上游 Profile 时应按部署单实例管理，避免 worker/状态文件互相抢占。
