# coding-client-ui-browser-ego

## 目标与边界

本包在右侧工作台注册一个会话级「Agent 浏览器」外部标签，并在设置页注册「Agent 浏览器」设置卡。面板负责显示所属会话的页面标签、浏览器状态、历史动作、活动页实时画面（单帧 JPEG 或视频）和基础人工操作；设置卡负责读写 Host 的 `ego-browser` 设置命名空间。它不启动浏览器、不注册模型工具，也不复用旧浏览器的页面或截图。Host 流推送活动页画面；人工选择其他标签时按该会话的目标身份读取单帧画面或切换到视频流。工作台通过 `sidebarRightTabs` 持有标签类型，通过 keyed `sidebar.right.pane.tab` 渲染内容；设置卡通过 keyed `settings.plugin.item` 挂到设置页的插件页，key 即设置命名空间。本包只在其 Client 组合行被挂载后生效；Host 浏览器服务、`/api/ego/*` 路由与 `ego-browser` 命名空间的注册由其他包提供。

## 数据与操作契约

页面显示时，Client 并行向同源路由读取会话数据：

- `GET /api/ego/spaces?sessionId=<id>` 返回 `{ ok: true, spaces, frameRelay? }`。`spaces` 每项含 `targetId`、`title`、`url`、`active`、可选 `viewportW`／`viewportH` 与可选 `humanCheck`；Client 只把 `humanCheck` 归一化为布尔事实（`null`／`false`／`{ detected: false }` 视为无需验证），不保存检测类别或选择器。
- `GET /api/ego/status?sessionId=<id>` 返回 `{ ok, running, browserConnected, spaces }`。面板只取 `running` 与 `browserConnected` 两个布尔值用于顶部状态区，页面数量以当前页面列表为准；状态路由缺失、失败或形状不符时显示中性说明，不展示路径、进程或堆栈。
- `GET /api/ego/history?sessionId=<id>` 返回 `{ ok, actions: [{ tool, at }] }`。工具名只在浏览器边界归入封闭的动作类别（如打开网页、点击页面、等待人工操作），原始工具名不进入视图或界面。
- `GET /api/ego/video/status` 返回 `{ ok, mime? }` 或 `{ ok, capture: { backend, mime? } }`。Client 只取可播放的 `video/*` 类型；没有合法类型即视为视频不可用，不影响单帧画面。

同时订阅 `GET /api/ego/stream?sessionId=<id>`：`spaces` 事件是同一会话的页面数组，`frame` 事件含 `targetId`、JPEG base64 `data`、视口 `vw`／`vh` 和单调时间戳 `ts`。选中或刷新后台页面时向同源 `GET /api/ego/frame?sessionId=<id>&targetId=<id>` 读取同一结构的单帧 JSON；切页、隐藏和卸载会取消在途读取并拒绝晚到的旧目标。Host 必须按 `sessionId` 过滤列表、SSE、单帧与输入目标，不能让其他会话的页面或画面进入该流；输入时还须复核目标是否仍归该会话，不得依赖 Client 的校验代替授权。

页面标签上的关闭按钮向同源 `POST /api/ego/close` 发送 `{ sessionId, targetId }`。成功后重新读取页面目录；失败只在共享 Toast 中显示固定文案，不显示响应内容或原始错误。关闭期间该会话的关闭按钮保持禁用，避免重复提交。

基础人工操作只在标签与页面均可见且画面已匹配时向同源 `POST /api/ego/input` 发送 `{ sessionId, targetId, type, ... }`；点击使用一对 `mousePressed`／`mouseReleased`，滚动使用 `mouseWheel`，在已点击的位置输入文字使用 `insertText`。坐标是截图内容区的 CSS 视口像素；加载中的旧画面、画面外点击、未知目标、无效尺寸与过期帧均不能触发输入。Host 对 POST 仍须做同源和本机请求校验、会话权限、目标及输入边界校验。

`spaces` 中 `humanCheck` 非空的当前页面会在画面顶部显示一条不拦截指针的提示条，说明需要在画面中完成人工验证；提示不包含检测类别、选择器等原始数据。

历史动作收在画面下方的「历史动作」抽屉里：按钮带 `aria-expanded`，抽屉内最多 8 条、按时间倒序显示动作类别与相对时间；点条目只保留选中态并收起抽屉，不触发任何页面操作，抽屉为空时显示「还没有浏览器操作」。相对时间每秒更新，面板隐藏或无动作时不安排计时器。

自动展开使用独立、只含 `{ count, sessionId, tool?, at? }` 的 `GET /api/ego/activity` SSE `tool-call` 事件，不能通过该流传输页面与画面。Host 只广播新调用，不回放历史事件；Client 每会话收到首条新活动时通过 `sidebarRight.openTabForSession(sessionId, 'ego-browser:watch')` 定向打开，此后只记录更高计数，不重复抢焦点。面板可见时还会把同一会话的新活动计入历史动作，已经出现的重复通知只记一次；活动流暂不可用时保留 HTTP 历史与手动入口，不影响面板渲染。浏览器面板隐藏时停止画面流、视频播放、活动流与人工输入，重新显示时刷新页面并重连；宿主负责浏览器及其页面的生命周期。

## 视频画面

`captureBackend` 为 `ffmpeg` 且视频状态报告了可播放类型时，画面区改为 `<video muted autoplay playsinline>`，由 Media Source Extensions 消费同源 `GET /api/ego/video` 的 fMP4：分片先进入有上限的队列，`SourceBuffer` 追上后再继续读取，播放位置贴近缓冲末尾并移除过旧区间，避免长期积压。以下任一情况都会释放播放器、中止在途请求并回退到单帧 JPEG，同时在画面区显示中性提示，不展示编解码器错误文本：浏览器不支持 MSE 或该类型、媒体源建立失败、流请求失败或提前结束、解析出的媒体源已关闭。面板隐藏、切换页面、切换回 `auto`／`cdp` 时同样停止播放器，不会继续拉流。`auto` 与 `cdp` 保持原有 JPEG 实时画面；视频画面当前只用于观看，点击、滚动与文字插入仍以单帧画面为准。

## 设置卡

设置卡把 Host 的 `ego-browser` 命名空间当作插件页的一项：本包以 `settings.plugin.item`、key `ego-browser` 注册，设置页在服务该命名空间时派发这张卡。Client 通过 `ctx.settingsScope.bind({ namespace: 'ego-browser' })` 推导有效值，字段只在用户点击保存时按改动逐项写入 `settingsScope.set`／`settingsScope.unset`；Host 是校验与归一化的唯一权威，保存后从设置节读回，未被接受的值保留草稿供修正。命名空间未服务时不渲染卡片；设置文档只读时显示一行说明并禁用全部控件与保存。

字段分组与用途：

| 分组 | 字段 |
| --- | --- |
| 画面采集 | `captureBackend`（`auto`／`cdp`／`ffmpeg`，选 `ffmpeg` 时提示依赖）、`streamProfile`（`low`／`balanced`／`high`） |
| 单帧画面 | `cdpFps`（5–30）、`cdpQuality`（1–100）、`cdpMaxWidth`（320–1920） |
| 视频画面 | `ffmpegFps`（5–30）、`ffmpegMaxWidth`（320–1920）、`ffmpegBitrateKbps`（500–20000）、`ffmpegEncoder`（自动／软件／各平台硬件编码） |
| 运行方式 | `disableFrameRelay`、`residentExecutor`、`sessionScopedSpaces`、`idleTimeoutMin`（0–1440） |
| 页面视口 | `viewportWidth`（0–3840）、`viewportHeight`（0–2160）、`deviceScaleFactor`（0–4） |
| 位置与下载 | `chromePath`、`ffmpegPath`、`egoBin`、`githubMirror` |

数字字段超出区间或非数字时阻止保存；空文本表示恢复组合层默认值；每条字段带覆盖徽标与「恢复默认」。路径字段只接受用户输入，标签与提示不写死任何本机路径。

## 验收

运行 `pnpm exec vitest run packages/client/ui-browser-ego` 验证输入校验、SSE 会话过滤、关闭标签、状态与历史、活动归类、相对时间、人机验证提示、面板显隐、设置卡读写与只读、视频状态解析、MSE 失败回退与播放器释放、历史抽屉开合以及槽位注册／注销；运行包专属 `pnpm exec tsc -b packages/client/ui-browser-ego --pretty false` 检查源码类型，`pnpm exec tsx scripts/run-oxlint.ts packages/client/ui-browser-ego` 检查静态规则。接入装配后还需由工作台所属测试验证真实挂载、Web 端回放以及 Host 路由的跨会话、跨站拒绝；当前目录的测试不能代替这些跨包检查。

## 模型体验

无。本包不提供模型工具、模型输入或持久化 Session 事件。

#### KV 缓存影响

无。本包不组装模型请求。

## 已知限制与延后工作

单帧与视频路径都支持点击、滚动、定点文字插入、关闭页面以及状态与历史动作展示；视频模式按 `video.videoWidth/videoHeight` 与页面 CSS 视口映射坐标，缺少尺寸或落在留白内时拒绝输入。最近动作只保留最近 8 条，状态与视频可用性没有推送通道，需在显示、手动刷新或关闭页面后更新。浏览器窗口调整、登录态导入、上传／下载与原始脚本仍没有面板控件，也不在本包范围内。设置卡覆盖的是面板与采集相关字段，Host 的其余字段（如额外启动参数）不在本卡出现。画面可见性随当前会话工作台挂载，隐藏或切换时需要重新取得最新画面。Host 未接线前菜单中没有此标签，也不能单独启动本包成为可用浏览器。
