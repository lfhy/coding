# coding-client-ui-browser-ego

## 目标与边界

本包向右侧工作台贡献会话级「Agent 浏览器」入口：所属会话的每个浏览器页面对应一个工作台顶栏标签，内容区仅显示当前页面的地址栏、导航按钮与画面（单帧 JPEG 或视频），没有第二层页面标签或底部操作栏。工作台标签只是一份页面视图：关闭它不向 Host 发送关闭页面命令，页面仍可由 Agent 使用；浏览器页面从 Host 目录消失时才移除相应视图。没有页面时手动入口显示空状态。本包还在设置页注册「Agent 浏览器」设置卡，读写 Host 的 `ego-browser` 设置命名空间。它不启动浏览器、不注册模型工具，也不复用旧浏览器的页面或截图。Host 流推送所属会话活动页画面，后台页按目标身份读取单帧。工作台通过 `sidebarRightTabs` 持有标签类型，通过 keyed `sidebar.right.pane.tab` 渲染内容；设置卡通过 keyed `settings.plugin.item` 挂到插件设置页。本包只在 Client 组合行挂载后生效；浏览器服务与 `/api/ego/*` 路由由 [Ego Host](../../browser/browser-ego-host/README.md) 提供。

## 数据与操作契约

页面显示时，Client 并行向同源路由读取会话数据：

- `GET /api/ego/spaces?sessionId=<id>` 返回 `{ ok: true, spaces, frameRelay? }`。`spaces` 每项含 `targetId`、`title`、`url`、`active`、可选 `viewportW`／`viewportH` 与可选 `humanCheck`；Client 只把 `humanCheck` 归一化为布尔事实（`null`／`false`／`{ detected: false }` 视为无需验证），不保存检测类别或选择器。
- `GET /api/ego/status?sessionId=<id>` 返回 `{ ok, running, browserConnected, spaces }`。Client 只保留运行与连接布尔值，不把路径、进程或堆栈送进视图；工作台不显示独立的浏览器状态栏。
- `GET /api/ego/history?sessionId=<id>` 返回 `{ ok, actions: [{ tool, at }] }`。Client 将工具名归入封闭动作类别，不把原始工具名送进视图；工作台没有历史动作抽屉。
- `GET /api/ego/video/status` 返回 `{ ok, mime? }` 或 `{ ok, capture: { backend, mime? } }`。Client 只取合法的 `video/*` 类型；没有合法类型即视为视频不可用，不影响单帧画面。

打开右侧工作台的共享 `+` 后选择「Agent 浏览器」会请求 `POST /api/ego/pages`（仅 `{ sessionId }`），在所属会话新建一张独立空白网页，确认目录归属后替换这次本地新标签；已有页面的地址和导航状态不变。首次打开会话空间复用其空白页。普通功能菜单选择「Agent 浏览器」仍查看已有页面，不额外新建网页；请求失败时保留新标签供重试，切换会话或关闭新标签后迟到响应不抢焦点。地址栏右侧的提交与弹出窗口按钮使用同组紧凑图标与悬停／键盘提示，工具栏的图标按钮静息时保持透明背景，只在悬停与键盘焦点时给出反馈；画面鼠标移动经当前页面所属目标查询标准光标、标题和链接，离开画面即清除，旧目标的迟到结果不得覆盖新画面；同一时刻只保留一条在途查询，事件到达时只记最新位置，查询返回后立即补发一次，鼠标快速划过不会堆积请求。

页面可见时订阅 `GET /api/ego/stream?sessionId=<id>`：`spaces` 事件是该会话的页面数组，`frame` 事件含 `targetId`、JPEG base64 `data`、视口 `vw`／`vh` 与时间戳 `ts`。页面目录按 `targetId` 同步成一页一个工作台顶栏标签；新出现的页面加入，页面从目录消失才移除视图。手动关闭顶栏标签只关闭 Client 视图，同一页面不会因下一次目录轮询又打开，Host target 不受影响；需真正关闭页面时由 Agent 使用浏览器工具。切到后台页或重新显示时按会话目标向同源 `GET /api/ego/frame?sessionId=<id>&targetId=<id>` 请求单帧；切页、隐藏和卸载取消旧读取并拒绝迟到帧。Host 按 `sessionId` 过滤列表、SSE、单帧与输入目标，操作前复核页面归属，不能用 Client 检查代替授权。

当前页面上方提供地址栏、后退、前进和网页刷新：输入网址后按回车或点击「打开网址」按钮提交，失焦不会清除尚未提交的草稿；页面目标或实际 URL 变化时同步地址。人工导航以 `POST /api/ego/navigation` 发送 `{ sessionId, targetId, action, url? }`。地址栏承诺无凭据的 HTTP(S) 地址；未写 scheme 的地址补 `https://`，非法地址在 Client 提示，不发送请求。`navigate` 带 URL；`back`／`forward`／`reload` 不带 URL，没有可用历史项或 Host 拒绝时只显示固定失败提示，不重复操作。Host 路由可在尚无页面时接纳省略 `targetId` 的导航以创建本会话首张网页，但面板是否开放此入口以可见页面状态为准。后端另接受严格本地 `file:///` 地址，不作为地址栏的产品承诺；Host 对人工导航执行回环同源请求校验、会话与目标归属检查，拒绝其他协议、越权目标与多余字段。

面板显示期间把自己的内容区尺寸（CSS 像素）与所在显示器的设备像素比去抖后写进同源 `POST /api/ego/viewport`（`{ sessionId, targetId, width, height, pixelRatio }`），Host 在目标页面的持久画面采集会话上设置实际 CSS 视口与对应像素比并核对尺寸，让窄侧栏和无窗口模式下的网页按面板重排、画面等比铺满，HiDPI 屏幕上按设备像素采集而不被放大发虚。`pixelRatio` 取 `devicePixelRatio` 并收敛到 1–3（读不到或低于 1 时按 1，等同旧行为）；窗口被拖到另一种像素比的显示器时布局尺寸不变，面板按 `(resolution: Ndppx)` 单独补报一次。同一页面同一尺寸与像素比在网页未变时只上报一次；导航或实测视口变化后允许重报，worker 在后续采帧前复核页面尺寸，避免导航重置模拟视口造成画面再次缩小。面板隐藏、切页或页面未就绪时不再上报，尺寸越界（宽 320–3840、高 200–2160）在 Client 侧就丢弃。Host 仍要复核会话存活、目标归属与范围后才转发；失败只做有界重试，不弹错误也不影响画面与输入。页面目录的宽高取最近一次成功采集的画面，不用可能滞后的布局指标清空有效帧。

人工输入只针对可见的工作台页面，向同源 `POST /api/ego/input` 发送 `{ sessionId, targetId, type, ... }`。点击投递 `mousePressed`／`mouseReleased`，滚动投递 `mouseWheel`；点画面后聚焦输入控件，可直接键入普通文字（`insertText`）及受限的回车、退格、删除、方向、Home／End 等按键（`keyDown`／`keyUp`），组合键、浏览器快捷键和任意 CDP 事件不在人工面板开放。同页输入按发起顺序投递，不能因前一请求未结束而丢弃后续按键；切页、导航或隐藏会取消该页待发输入。坐标按画面内容区映射到页面 CSS 视口；旧帧、留白、未知目标或无效尺寸不能触发输入，失败只用固定文案提示。Host 对请求还要检查连接信任、回环同源、会话存活、target 归属及输入字段和范围，不能依赖 Client 的检查。

页面上方的「在浏览器窗口中打开」按钮向同源 `POST /api/ego/window` 发送 `{ sessionId }`；用户主动点击后才把默认无窗口的浏览器呈现在前台，以便登录扫码或处理人机验证。请求被接受不等于画面已就绪；画面和目录仍以 Host 推送为准，失败只显示固定文案。

`spaces` 中当前页面的 `humanCheck` 为真时，画面顶部显示不拦截指针的人工验证提示，不展示检测类别和选择器。

自动打开使用独立的 `GET /api/ego/activity` SSE `tool-call` 事件，载荷只含 `{ count, sessionId, tool?, at? }`，不得承载页面和画面。Host 在连接时回放存活会话的最近活动，随后广播新调用；Client 每个会话首次收到活动时定向打开工作台浏览器入口，并按已知活动页面定位相应视图，此后不重复抢焦点。会话尚未载入时暂存活动并重试，活动流断开时重连；用户仍可从手动入口打开。隐藏最后一个浏览器视图时释放页面画面流、视频播放与人工输入，重新显示时刷新页面目录并重连，Host 浏览器及 target 继续运行。

## 视频画面

`captureBackend` 为 `ffmpeg` 且视频状态报告了可播放类型时，画面区用 `<video muted autoplay playsinline>` 与 Media Source Extensions 消费同源 `GET /api/ego/video` 的 fMP4。分片队列有上限，播放跟随缓冲末尾并清理旧区间。浏览器不支持 MSE／媒体类型、建源失败、视频流请求失败或中断时停止播放器并回退到单帧 JPEG，仅显示中性提示；隐藏视图、换页或改回 `auto`／`cdp` 时也停止拉流。视频画面可用于点击、滚动和聚焦后输入文字、受限按键；指针坐标按视频实际尺寸与页面 CSS 视口换算，尺寸缺失或点击留白区时不发送指针输入。

## 设置卡

设置卡把 Host 的 `ego-browser` 命名空间当作插件页的一项：本包以 `settings.plugin.item`、key `ego-browser` 注册，设置页在服务该命名空间时派发这张卡。Client 通过 `ctx.settingsScope.bind({ namespace: 'ego-browser' })` 推导有效值，字段只在用户点击保存时按改动逐项写入 `settingsScope.set`／`settingsScope.unset`；Host 是校验与归一化的唯一权威，保存后从设置节读回，未被接受的值保留草稿供修正。命名空间未服务时不渲染卡片；设置文档只读时显示一行说明并禁用全部控件与保存。

字段分组与用途：

| 分组 | 字段 |
| --- | --- |
| 画面采集 | `captureBackend`（`auto`／`cdp`／`ffmpeg`，选 `ffmpeg` 时提示依赖）、`streamProfile`（`low`／`balanced`／`high`） |
| 单帧画面 | `cdpFps`（5–30）、`cdpQuality`（1–100）、`cdpMaxWidth`（320–2560） |
| 视频画面 | `ffmpegFps`（5–30）、`ffmpegMaxWidth`（320–1920）、`ffmpegBitrateKbps`（500–20000）、`ffmpegEncoder`（自动／软件／各平台硬件编码） |
| 运行方式 | `headless`（默认开：只在面板里运行，不弹窗、不抢焦点）、`cursorName`（页面光标标签，默认 `Agent`）、`disableFrameRelay`、`residentExecutor`、`sessionScopedSpaces`、`idleTimeoutMin`（0–1440） |
| 页面视口 | `viewportWidth`（0–3840）、`viewportHeight`（0–2160）、`deviceScaleFactor`（0–4） |
| 位置与下载 | `chromePath`、`ffmpegPath`、`egoBin`、`githubMirror` |

数字字段超出区间或非数字时阻止保存；空文本表示恢复组合层默认值；每条字段带覆盖徽标与「恢复默认」。路径字段只接受用户输入，标签与提示不写死任何本机路径。单帧画面的 `cdpQuality`／`cdpMaxWidth` 由 Host 在每次取帧时下发给采集 worker，保存后下一次取帧即生效，不需要重启浏览器；面板按设备像素 1:1 显示画面，所以这两个值直接决定文字边缘与渐变的保真度。

## 验收

修改本包行为时，定向验证应覆盖一页一工作台标签、视图关闭不关闭 Host target、后台页画面、地址栏与历史导航、键盘输入、同源与跨会话拒绝，以及视频回退和设置读写。Client 测试可运行 `pnpm exec vitest run packages/client/ui-browser-ego`；Host 与工作台契约分别运行其所属测试。

## 模型体验

无。本包不提供模型工具、模型输入或持久化 Session 事件。

#### KV 缓存影响

无。本包不组装模型请求。

## 已知限制与延后工作

面板处理当前会话的浏览器画面与人工操作，顶部工作台标签关闭不结束浏览器 target；共享 `+` 入口本身不创建空白网页。面板只调整目标页面在采集会话中的 CSS 视口，不控制独立浏览器窗口大小；没有独立的尺寸控件、预设设备菜单或“恢复默认分辨率”入口。关闭面板后该页面保留最后一次采集视口；Agent 自己通过 CDP 改动窗口或模拟视口时面板不会反向跟随。没有登录态导入、上传／下载、原始脚本、内部页面标签、底部文字输入栏或动作历史抽屉。视频画面可进行指针和受限键盘输入；无有效视口时拒绝指针输入。状态、历史和视频可用性尚无主动推送，需要显示或刷新视图时更新。设置卡仅覆盖面板与采集相关字段，不展示 Host 其余字段（如额外启动参数）；Host 路由未接线时不能仅靠本包启动浏览器。
