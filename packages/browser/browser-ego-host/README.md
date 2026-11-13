# Ego 浏览器 Host

`coding-browser-ego-host` 将 [ego-lite](https://github.com/CitroLabs/ego-lite) 的 Node CLI/CDP 运行时接入 Host。需要 Node 22+、本机 Edge、Chrome 或 Chromium、`coding-session` 和 `coding-subprocess`；运行 Web 画面还需要 `coding-host-webserver` 与 `coding-client-connection`。包本身不注册任何 `ego_*` 模型工具：`ctx.egoBrowser.toolDefinitions()` 只返回经过会话检查的定义，由 [按 Agent 审批的消费方](../tool-browser-ego/README.md)决定是否注册为 `browser_*`。宿主不载入归档的上游 Host `apply`，故上游登录导入、设置网关、配对、FFmpeg 下载均不可通过本包访问。

## 当前能力

上游 v0.9.7 的 35 个工具全部移植：`status`、`auth_flush`、`login_import`、`space_open`、`space_close`、`snapshot`、`navigate`、`click`、`fill`、`js`、`cdp`、`screenshot`、`page_info`、`tabs`（列出/打开/切换/关闭）、`wait`、`wait_for_selector`、`wait_for_url`、`wait_for_response`、`key`、`hover`、`read_element`、`select`、`drag`、`scroll`、`upload`、`download`、`check`、`dialog`、`http`、`cli`、`captcha`、`wait_for_human`、`help`、`doctor`、`script`。消费方统一以 `browser_*` 注册，参数形状与上游 schema 一致；审批、Remote-SSH 拒绝与结果上限由消费方执行。Host 将省略的 `space`、空字符串与 `default` 都视为当前会话空间，并将 `space_open`／`space_close` 的 `name: "default"` 映射到本会话；显式指定其他空间仍拒绝，不能用空值绕过隔离。`cli`／`script` 执行前先进入当前会话空间，页面才会出现在该会话工作台。默认每个会话独立任务空间（上游 `sessionScopedSpaces`），浏览器 Profile 持久保存在用户目录，跨会话共享登录态但页面/标签隔离。

宿主的 `third-party/upstream/src/` 是上游 Host 源码，构建产物 `third-party/upstream/lib/index.js` 才是运行时入口；`apply()` 收集全部工具定义并由本包暴露，同时注册上游观察窗路由。上游 `/api/ego/*` 与 `/ego/api/*` 统一经过本项目 `connection.requestRejection` 与回环同源栅栏；`spaces`、`stream`、`frame`、`input`、`navigation`、`close`、`status`、`history` 使用本项目按会话过滤的实现，其余上游路由（设置网关、登录导入、watch、video 等）在通过同一栅栏后可用。

`webServer` 和 `connection` 同时可用时才注册 `/api/ego/spaces?sessionId`、`/api/ego/stream?sessionId`、`/api/ego/frame?sessionId&targetId`、`/api/ego/activity` 以及 `POST /api/ego/input`、`POST /api/ego/navigation`、`POST /api/ego/pages`、`POST /api/ego/hover`、`POST /api/ego/viewport`。所有入口在读取载荷或启动 worker 前调用 `connection.requestRejection(req)` 并要求 loopback 同源；`spaces` 与 SSE 只发布该 Session 的 target，`frame` 只发布属于该 Session 的目标 JPEG，`activity` 向新连接回放存活会话最近一次活动，再广播新工具启动的会话与计数，不携带页面或画面。`pages` 只接受所属 Session，空会话复用空白锚页，否则在该空间新建页面；冷启动时画面 worker 可能晚于 CLI 连上浏览器，Host 在有界等待中持续复核会话与归属，直到目录收录新目标才返回成功；同会话并发请求串行化且页面数不超过 30。`hover` 接受经过边界映射的 CSS 视口坐标，先按空间登记核验归属，再由持有页面的 worker 按该页视口边界拒绝越界坐标，返回受限标准光标、标题及无凭据 HTTP(S) 链接；跨源子帧无法读取其 DOM。页面侧真实鼠标移动按目标合并、最小间隔 80ms 异步投递（`Input.dispatchMouseEvent` 要等渲染器确认，单条约 16ms，而画面只有约 1fps），游标与悬停提示由一条约 1ms 的 `Runtime.evaluate` 直接读取，所以面板的指针反馈不再等输入命令返回，鼠标快速划过时也不会把请求排成队列。worker 的封闭 `GET /api/frame` 只采集当前存在页面的画面与实测 CSS 视口 `{targetId,data,mime,vw,vh,ts}`：静止取帧走无损 WebP（质量 100，合法无损帧 base64 超过 1,200,000 字符时先按 `quality` 重采有损 JPEG，即使无损结果超过最终输出上限也不提前失败；最终帧必须是非空合法 base64 且不超过 2,800,000 字符，否则返回 503），实时推流用 `format=lossy` 直接要 JPEG，`mime` 随帧下发。会话画面流按 `cdpFps` 自调度取帧：连续两帧完全相同就补发一张无损帧并把探测降到 4fps，静止画面因此没有编码台阶，页面一变又立即回到实时推流。查询串只接受 `targetId` 与可选的 `quality`（1–100）、`maxWidth`（320–2560 设备像素）、`format`（`lossy`），前三者由 Host 按 `ego-browser` 设置的 `cdpQuality`／`cdpMaxWidth` 逐帧下发，缺省时用 worker 自身配置（有损默认质量 92），其他查询参数、重复字段一律拒绝；单帧按设备像素采集（`Page.captureScreenshot` 不再折算回 CSS 像素，宽度上限 2560 设备像素），HiDPI 面板拿到的是原生像素画面，`vw`／`vh` 仍是 CSS 视口以保持人工输入换算不变；页面目录的视口尺寸仅来自同一目标最近一次成功采集的画面，不读取可能滞后的布局指标；会话归属由 Host 再核验。`viewport` 接受 `{sessionId,targetId,width,height,pixelRatio?}`（宽 320–3840、高 200–2160、像素比 1–3 且缺省为 1，多余字段拒绝），复核归属后在该页的持久采集会话上把 CDP 页面视口的 `deviceScaleFactor` 设成该像素比，并测量真实宽高；窗口最小宽度及无窗口模式均不阻止窄栏铺满，尺寸不符时失败而不报告虚假的成功。`input` 需要 JSON `{sessionId,targetId,type,...}`，严格核对目标存在且属于该 Session，鼠标坐标在视口内；文本输入有界，`keyDown`/`keyUp` 仅接受受限导航键的 `key`、`code`、`windowsVirtualKeyCode`、`modifiers` 并剔除其余 CDP 字段。错误不派发输入。画面使用只读 CDP 截图轮询；工作台隐藏时 Client 断开 SSE。未命中的 `/api/ego/*` 与 `/ego/api/*` 不由本包注册，不能访问上游 settings、login、watch、resize、close 或 FFmpeg 路由。

`POST /api/ego/navigation` 接受 JSON `{sessionId,targetId?,action,url?}`，`action` 仅为 `navigate`、`reload`、`back`、`forward`；`navigate` 必须带绝对无凭据 HTTP(S) 或严格本地 `file:///` URL，其他动作不得带 URL。Host 拒绝多余字段与跨会话 target，确认目标仍存在并清洗转发到 worker 封闭的 `POST /api/navigation`；worker 对已有 target 分别执行 CDP `Page.navigate`、`Page.reload`、`Page.getNavigationHistory` + `Page.navigateToHistoryEntry`，无历史项或 CDP 失败返回 `ok:false`，不调用模型工具。仅在该会话没有登记页面且没有提供 `targetId` 的 `navigate` 请求中，Host 用 ego-lite CLI 的 `taskSpaces.useOrCreate`/`ego.createTab` 在本会话空间创建页面，再复核目标归属；CLI 脚本以 `page` 为预置变量，Host 的局部变量不得与其同名。其他缺少目标的请求均拒绝。人工操作不写入模型输入或其他会话。

浏览器 Profile/状态由 ego-lite 在用户目录保存，不在 Coding 项目根：Unix/macOS 默认分别为 `~/.local/share/ego-lite-linux/profile` 与 `~/.local/state/ego-lite-linux/`，Windows 默认 `%LOCALAPPDATA%/ego-lite-linux/`；可使用 `XDG_DATA_HOME`、`XDG_STATE_HOME`、`EGO_LINUX_STATE_DIR` 与 `EGO_LINUX_PROFILE` 设置实际位置。这些目录可能含网站登录态、浏览记录和空间 target 信息，**不要提交或分享**。Host 强制 `EGO_ISOLATE_SPACES=1`，每个任务空间使用独立 Chromium context；context 创建失败会拒绝运行而不是降级共用页面。运行时依赖本机已经安装的浏览器，不下载浏览器或 FFmpeg。临时目录中隔离的真机 Edge 测试不会触碰默认 Profile。

## 运行位置与交互细节

- **默认无窗口**：`headless` 默认开启，浏览器只在工作台面板里出现，不会把独立窗口弹到用户前台。配置为 `false` 才回到可见窗口。启动模式记录在浏览器状态文件里：复用一个旧状态（没有记录）或与当前配置不一致的实例时先关闭再按配置启动，因此切换设置或升级后不会继续沿用旧窗口；`--open` 打开的窗口有自己的意图记录，下一次工具调用不会把它关掉。用户在面板里主动要求换窗口时走 `POST /api/ego/window`（JSON `{sessionId}`，会话有效才执行），Host 用运行时的 `--open` 换成同 Profile 的可见窗口，登录扫码与人机验证都在这个入口完成。
- **默认窗口与面板视口**：运行时以 `--window-size=2560,1080`、`--force-device-scale-factor=1` 启动，独立的 Agent 页面按宽桌面布局渲染（Xvfb 虚拟屏幕同步为 2560×1080）；工作台展示时，页面在 worker 的持久 CDP 会话里按栏宽高重排，无窗口模式与宽度小于 Chromium 最小窗口宽度时仍可铺满。右栏走单页 `GET /api/frame` 原生视口截图；设置中的 `cdpMaxWidth` 默认 2560，仅限制独立视频采集接口的单帧宽度，不决定右栏截图尺寸。
- **会话页面截图**：`captureSessionPage` 在同一 HTML 路径内容更新后再次调用时重读新文档，复用同会话标签但不复用旧 DOM；新文档未确认加载时不截图。截图不包含 Agent 光标覆盖层，捕获结束恢复显示。
- **页面光标标签**：`cursorName` 默认 `Agent`，通过 `EGO_LINUX_CURSOR_NAME` 传给运行时；模型渠道是逐会话选择的，因此默认标签只描述角色，不写具体厂商。面板的窗口入口复用同一份环境（由上游按当前设置计算），因此换成可见窗口后光标标签与启动模式仍与配置一致。
- **CSS 选择器范围**：`ego_click`、`ego_hover` 对 CSS 目标先在顶层文档定位；找不到时回退到穿透 open shadow root 与同源 iframe 的查找，再按元素中心发真实鼠标事件。多匹配、无效选择器与不可见目标仍以原错误失败，不会改点别的元素。
- **标签页错误**：`ego_tabs` 的 `switch`/`close` 先读取当前任务空间实际存在的 id；目标不属于该空间时返回可操作的说明与现存 id 列表，`open` 失败返回底层原因。脚本只声明一次空间变量，避免整条工具调用因重复声明而失败。
- **响应式与移动端验证**：视口覆盖由 CDP 会话语义决定，随一次 `ego-browser nodejs` 调用结束失效，因此 `ego_cdp` 单独设置 `Emulation.setDeviceMetricsOverride` 对后续调用和截图都不生效。Agent 要在别的宽度或 `mobile` 下验证，必须在同一次 `ego_script`／`ego_js` 调用里设置覆盖再取测量或 `page.screenshot`，截图尺寸是 CSS 像素（`deviceScaleFactor` 只影响布局与 `devicePixelRatio`）；面板画面与单帧由另一个 worker 的会话采集，不受该覆盖影响。设置卡的 `viewportWidth`／`viewportHeight` 则相反：每次工具调用都会在切换标签后重放固定视口，适合长时间固定在某一宽度工作。

## Host 生命周期与页面保留

Coding 组装在挂载时把 `keepBrowserRunning` 置为 `true`：Host 运行期间不注册上游的空闲停止定时器，并给每个浏览器子进程注入 `EGO_LINUX_SPACE_IDLE_MIN=0` 与 `EGO_KEEP_SESSION_PAGES=1`。因此「放一会儿页面自己消失」不再发生——页面的存活只取决于用户关闭、会话结束或 Host 退出，不取决于最近一次浏览器工具调用距今多久。上游设置项 `idleTimeoutMin` 仍被接受与解析，但在此组装下不生效，Agent 浏览器设置卡也不再展示它。

浏览器进程仍会在 Host 卸载时正常停止。之后再次启动时，运行时会发现该会话旧的 target 全部失效，把当时的网址（仅 `http`／`https`／`file`，去掉带凭据的地址，每会话最多 30 条）记入该空间的 `pendingRestore`；面板请求本会话目录时，Host 通过 `ego.restoreTaskSpace` 在会话自己的任务空间与隔离 context 中重建这些页面，然后照常返回目录。触发范围受限：只处理 `coding-ego-<hash>` 具名会话，`user` 持有的空间一律跳过，其它会话的页面不会被这一路径打开，同一会话最多每 30 秒尝试一次。页面内容、表单、登录态与滚动位置都不保存，恢复的是地址。

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
- 本地 loopback worker 本身不能作为网络安全边界；Host 入口只信任 `connection` 与同源 loopback。画面 worker 按 `EGO_LINUX_STATE_DIR` 各自保存记录，启动时不会终止别的状态目录中的进程；不同 Host 实例共享同一状态目录或 Profile 时仍需按部署单实例管理，避免页面或状态文件互相抢占。
