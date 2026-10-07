---
description: "在 Session 工作台中呈现受控浏览器并提供人工导航控件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-browser

## 用法与行为

本包的 Client 半边占用 `workbench.browser` 内容和 `workbench.browser.tabs` 顶栏标签两个会话级 slot；[`ui-open-in-app`](../ui-open-in-app/README.md) 声明 slot 并拥有与文件、终端共用的工作台标签行及唯一新增入口。本包通过 `syncBrowserTabs()` 同步 Host 页面标签和当前页面，每个页面成为一个 `browser` 标签；`tabId` 指定标签条目在统一顶栏逐页绘制，不提供浏览器专用新增按钮。标签的 `shown` 跟随工作台显隐，`browserShown` 决定选中状态；内容的 `shown` 只在选中浏览器且工作台可见时为真。内容通过 `selectedTabId` 将工作台选中的浏览器页面对齐到 Host 当前页面；命令执行中或 Agent 占用浏览器时，以 Host 操作结果为准，不为旧的工作台选择追加切页命令。每个挂载的 Session 每约 750ms 从同源 Host GET `/browser-use/state?sessionId=` 读取观测；Web/CLI 状态有画面时再按 generation/revision GET `/browser-use/frame` 读取 PNG。桌面端由原生 guest 呈现页面，不请求镜像 PNG。切换右侧标签或隐藏工作台不会卸载当前 Session 的内容条目；切换 Session 时重新挂载对应的浏览器内容，Host 页面继续存续。成功的 `browser_navigate` 工具结果只为当前 Session 触发一次展示：同步 Host 实际页面标签后打开右侧工作台并选中该页面，直接工具调用与 Code Mode 调用一致；桌面原生导航超时且已安全停稳时，虽工具报告失败，仍须确认 Host 活动标签存活才展示。挂载时已有状态、其他工具结果、历史回放、审批拒绝、无效导航或无法安全停稳的失败不触发。等待状态期间用户手动选择页面或面板时，以用户选择为准，不另建空白页。

Assistant 正文中的 HTTP(S) 链接可通过可选的 `ctx.chatBrowserLinks.open(sessionId, url)` 打开：内容 slot 挂载期间登记所属会话，每次点击（包括相同 URL）被接纳时立即打开工作台、选中独立的 `browser-pending` 占位标签并显示目标 URL 与加载状态，返回的 Promise 随 UI 接纳兑现，不等待页面导航。同一会话按点击顺序执行 Host 原子新建并导航，每次各建一个页面；不同会话互不等待。占位 id 只属于 Client，绝不作为 Host 页面 id；Host 成功返回后同步页面集并仅替换对应占位标签，进行中的 Host 状态轮询不会提前显示空白页。最后获接纳的点击可自动保持焦点；点击后人工选择其他工作台内容则以人工选择为准。隐藏的工作台同样可用；点击不经过菜单的新标签请求、模型工具或审批。每会话最多接纳 32 个待完成点击，超过时明确拒绝，已接纳任务不受影响。导航中的占位标签不可关闭；Host 拒绝或命令失败在该标签内保留错误和重试入口，重试沿用占位 id，后续点击继续执行，不把已接纳失败抛回 Chat 弹窗。服务缺席、会话不可用或容量已满等接纳前失败仍拒绝 Promise；会话内容卸载时取消排队任务并清理占位与错误标签。未装配本插件时不提供该服务。

菜单每次选择浏览器时，工作台内容 slot 的 `newTabRequest` 触发一次 `browser.control` 的 `new-tab`，首次无页面与已有页面均新建一个 `about:blank` 页面，并通过 `focusBrowserTab` 聚焦新标签。地址栏接受 HTTP(S) 网址或域名，回车导航，省略协议时补 `https://`。统一顶栏的 `+` 返回功能菜单，不直接新建页面；可选取与关闭各页面标签，文件管理器、文件预览和终端标签同时保留；工具栏按历史状态启用后退、前进和刷新。关闭最后一个浏览器页面会结束 Host 中该 Session 的浏览器资源；工作台选中其他类型标签，没有标签则返回菜单，关闭未选中的浏览器页面不会改变当前文件或终端的选择。Web/CLI 可点击 PNG 画面、滚动，或点击「输入」后指定位置插入文本，不替换原有内容；桌面端直接与原生页面交互，不显示截图坐标控件。命令进行时控件禁用，失败可重试；Agent 自审批前占用浏览器至操作完成，期间人工控制暂停。人工导航与模型的[七项浏览器工具](../../browser/tool-browser/README.md)共用该 Session 的浏览器资源，但人工命令不使用模型工具的审批，也不改变工具的会话权限规则。

Web/CLI 浏览器视图可见且有活动标签时，Client 按画布可用尺寸发送有界 `set-viewport` 命令，使 Host 页面 CSS 视口与右栏同步，再按返回的观测尺寸显示截图和虚拟指针；接受像素尺寸为 CSS 视口一倍或两倍的 PNG，渲染与人工坐标始终按 CSS 视口计算。旧帧不会被放大超过其原生视口尺寸，较窄的侧栏会等比缩小画面。隐藏视图或关闭标签不会触发调尺寸。尺寸约束由 [`apiproxy`](../../host/apiproxy/README.md) 的人工 RPC 契约规定。桌面端通过 preload 的受限呈现方法把工作台画布位置交给 Electron 主进程；原生 `WebContentsView` 在该位置呈现，切换或隐藏时卸载视图而不关闭 guest，尺寸变化由主进程更新视口。它不是 renderer `<webview>` 或可由页面脚本控制的 DOM 节点。

状态 JSON 在 Client 边界校验 generation、单调 revision、Agent 占用标记、HTTP(S)/`about:blank` 地址、文本长度、标签关联、画面尺寸、指针坐标和操作种类；无资源的审批期只接受精确 `{operationActive:true}`。Web/CLI 截图只作为 Blob object URL 在控制器内保存，换帧、消失、卸载时撤销；旧请求和过期修订版不能覆盖新画面。未知或关闭的浏览器显示空状态。Web/CLI 组件只绘制 Host 捕获的图片、标题、地址及 Agent 点击、输入、滚动时相对截图坐标的虚拟指针；页面不会作为 iframe、WebView 或可执行 HTML 装入 Client。人工坐标仅从已加载、像素尺寸与观测视口成一倍或两倍比例的图片可见区域换算，并携带浏览器、标签、观测修订版与 CSS 视口，Host 在执行时拒绝过期目标。桌面端不申请画面 Blob，也不把 guest DOM 交给 renderer。

浏览器状态与画面由 Host provider 提供受 Origin 与本地访问约束的只读路由；人工命令经连接服务的回环同源 `browser.control` RPC，由 Host 校验已附着的本地 Session 并拒绝远程工作区 marker。本包没有公开配置，词典包含中文和英文；CSS Modules 使用共享语义 token，窄屏会收紧工具栏，减少动态效果设置会禁用指针脉冲动画。

## 模型体验

无。本包的页面观测与人工操作不进入模型工具或日志；模型工具、日志与提示词由浏览器能力提供方持有，本包不改写。

#### KV 缓存影响

无；本包不组装模型请求。

## 已知限制与延后工作

Web/CLI 截图按轮询频率更新而非实时视频；其人工交互只覆盖截图坐标点击、滚轮滚动与指定位置的文本插入，不支持 DOM 元素语义定位、文件选择或拖拽。桌面原生 guest 的呈现依赖受限 preload 方法，桥断开时浏览器操作失败且不切换到 Web/CLI PNG 提供方。远程 Session、非本机访问和未附着 Session 不能使用人工命令。

**运行时 invariant：** companion 只登记包名；请求栅栏、图片释放与 slot fiber 清理由包测试验证。
