# coding-client-ui-browser-ego

## 目标与边界

本包在右侧工作台注册一个会话级「Agent 浏览器」外部标签，负责显示所属会话的页面标签、浏览器状态、最近动作、活动页实时画面和基础人工操作。它不启动浏览器、不注册模型工具，也不复用旧浏览器的页面或截图。Host 流推送活动页画面；人工选择其他标签时按该会话的目标身份读取单帧画面，不修改 Host 活动标签。工作台通过 `sidebarRightTabs` 持有标签类型，通过 keyed `sidebar.right.pane.tab` 渲染内容。本包只在其 Client 组合行被挂载后生效；Host 浏览器服务和 `/api/ego/*` 路由由其他包提供。

## 数据与操作契约

页面显示时，Client 并行向同源路由读取三份会话数据：

- `GET /api/ego/spaces?sessionId=<id>` 返回 `{ ok: true, spaces, frameRelay? }`。`spaces` 每项含 `targetId`、`title`、`url`、`active`、可选 `viewportW`／`viewportH` 与可选 `humanCheck`；Client 只把 `humanCheck` 归一化为布尔事实（`null`／`false`／`{ detected: false }` 视为无需验证），不保存检测类别或选择器。
- `GET /api/ego/status?sessionId=<id>` 返回 `{ ok, running, browserConnected, spaces }`。面板只取 `running` 与 `browserConnected` 两个布尔值用于顶部状态区，页面数量以当前页面列表为准；状态路由缺失、失败或形状不符时显示中性说明，不展示路径、进程或堆栈。
- `GET /api/ego/history?sessionId=<id>` 返回 `{ ok, actions: [{ tool, at }] }`。工具名只在浏览器边界归入封闭的动作类别（如打开网页、点击页面、等待人工操作），面板仅展示最近 8 条与相对时间，原始工具名不进入视图或界面。

同时订阅 `GET /api/ego/stream?sessionId=<id>`：`spaces` 事件是同一会话的页面数组，`frame` 事件含 `targetId`、JPEG base64 `data`、视口 `vw`／`vh` 和单调时间戳 `ts`。选中或刷新后台页面时向同源 `GET /api/ego/frame?sessionId=<id>&targetId=<id>` 读取同一结构的单帧 JSON；切页、隐藏和卸载会取消在途读取并拒绝晚到的旧目标。Host 必须按 `sessionId` 过滤列表、SSE、单帧与输入目标，不能让其他会话的页面或画面进入该流；输入时还须复核目标是否仍归该会话，不得依赖 Client 的校验代替授权。

页面标签上的关闭按钮向同源 `POST /api/ego/close` 发送 `{ sessionId, targetId }`。成功后重新读取页面目录；失败只在共享 Toast 中显示固定文案，不显示响应内容或原始错误。关闭期间该会话的关闭按钮保持禁用，避免重复提交。

基础人工操作只在标签与页面均可见且画面已匹配时向同源 `POST /api/ego/input` 发送 `{ sessionId, targetId, type, ... }`；点击使用一对 `mousePressed`／`mouseReleased`，滚动使用 `mouseWheel`，在已点击的位置输入文字使用 `insertText`。坐标是截图内容区的 CSS 视口像素；加载中的旧画面、画面外点击、未知目标、无效尺寸与过期帧均不能触发输入。Host 对 POST 仍须做同源和本机请求校验、会话权限、目标及输入边界校验。

`spaces` 中 `humanCheck` 非空的当前页面会在画面顶部显示一条不拦截指针的提示条，说明需要在画面中完成人工验证；提示不包含检测类别、选择器等原始数据。

自动展开使用独立、只含 `{ count, sessionId, tool?, at? }` 的 `GET /api/ego/activity` SSE `tool-call` 事件，不能通过该流传输页面与画面。Host 只广播新调用，不回放历史事件；Client 每会话收到首条新活动时通过 `sidebarRight.openTabForSession(sessionId, 'ego-browser:watch')` 定向打开，此后只记录更高计数，不重复抢焦点。面板可见时还会把同一会话的新活动计入最近动作，已经出现的重复通知只记一次；活动流暂不可用时保留 HTTP 历史与手动入口，不影响面板渲染。浏览器面板隐藏时停止画面流、活动流与人工输入，重新显示时刷新页面并重连；宿主负责浏览器及其页面的生命周期。

## 验收

运行 `pnpm exec vitest run packages/client/ui-browser-ego/tests` 验证输入校验、SSE 会话过滤、关闭标签、状态与历史、活动归类、相对时间、人机验证提示、面板显隐和槽位注册／注销；运行包专属 `pnpm exec tsc -b packages/client/ui-browser-ego --pretty false` 检查源码类型，`pnpm exec oxlint packages/client/ui-browser-ego` 检查静态规则。接入装配后还需由工作台所属测试验证真实挂载、Web 端回放以及 Host 路由的跨会话、跨站拒绝；当前目录的测试不能代替这些跨包检查。

## 模型体验

无。本包不提供模型工具、模型输入或持久化 Session 事件。

#### KV 缓存影响

无。本包不组装模型请求。

## 已知限制与延后工作

仅支持 JPEG 活动页面的实时画面、后台页面的按需单帧、点击、滚动、定点文字插入、关闭页面以及状态与最近动作展示；最近动作只保留最近 8 条，状态没有推送通道，需在显示、手动刷新或关闭页面后更新。上游视频采集、后台页面持续实时流、浏览器窗口、登录态导入、上传／下载与原始脚本仍没有面板控件，也不在本包范围内。画面可见性随当前会话工作台挂载，隐藏或切换时需要重新取得最新画面。Host 未接线前菜单中没有此标签，不能单独启动本包成为可用浏览器。
