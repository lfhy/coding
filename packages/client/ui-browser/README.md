---
description: "在 Session 工作台中显示 Host 受控浏览器画面与人工导航控件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-browser

## 用法与行为

本包的 Client 半边占用 `workbench.browser` 内容和 `workbench.browser.tabs` 顶栏标签两个会话级 slot；[`ui-open-in-app`](../ui-open-in-app/README.md) 声明 slot 并拥有与文件、终端共用的工作台标签行。本包通过 `syncBrowserTabs()` 同步 Host 页面标签和当前页面，每个页面成为一个 `browser` 标签；`tabId` 指定标签条目在统一顶栏逐页绘制，省略时只绘制新增页面按钮。标签的 `shown` 跟随工作台显隐，`browserShown` 决定选中状态；内容的 `shown` 只在选中浏览器且工作台可见时为真。内容通过 `selectedTabId` 将工作台选中的浏览器页面对齐到 Host 当前页面；命令执行中或 Agent 占用浏览器时，以 Host 操作结果为准，不为旧的工作台选择追加切页命令。每个挂载的 Session 每约 750ms 从同源 Host GET `/browser-use/state?sessionId=` 读取观测，状态存在时再按 generation/revision GET `/browser-use/frame` 读取 PNG。切换右侧标签或隐藏工作台不会卸载当前 Session 的内容条目；切换 Session 时重新挂载对应的浏览器内容，Host 页面继续存续。首次读取已有浏览器状态只作为基线，不抢用户的选择；挂载后出现新的模型操作画面时，先同步最新完整状态中的页面标签，再通过 `openBrowser(tabId)` 打开对应页面。

选择浏览器时，如当前 Session 没有浏览器状态，会通过 `browser.control` 幂等建立一个 `about:blank` 页面；地址栏接受 HTTP(S) 网址或域名，回车导航，省略协议时补 `https://`。统一顶栏可新增页面、选取与关闭各页面标签，文件和终端标签同时保留；工具栏按历史状态启用后退、前进和刷新。关闭最后一个浏览器页面会结束 Host 中该 Session 的浏览器上下文；工作台选中其他类型标签，没有标签则返回菜单，关闭未选中的浏览器页面不会改变当前文件或终端的选择。人工可直接点击截图目标，用滚轮滚动；点击「输入」再选择截图位置，会在输入框提交文字并插入到目标，不会替换原有内容。命令进行时控件禁用，失败可重试；AI 自审批前占用浏览器至截图完成，期间地址栏、标签、页面与视口调整均暂停，完成后自动恢复。人工导航与模型的[七项浏览器工具](../../browser/tool-browser/README.md)共用该 Session 的浏览器状态，但人工命令不使用模型工具的审批，也不改变工具的会话权限规则。

浏览器视图可见且有活动标签时，Client 按画布可用尺寸发送有界 `set-viewport` 命令，使 Host 页面视口与右栏同步，再按返回的观测尺寸显示截图和虚拟指针；旧帧不会被放大超过其原生视口尺寸，较窄的侧栏会等比缩小画面。隐藏视图或关闭标签不会触发调尺寸。尺寸约束由 [`apiproxy`](../../host/apiproxy/README.md) 的人工 RPC 契约规定，画面仍只是 PNG 镜像，不能通过截图点击目标网页 DOM。

状态 JSON 在 Client 边界校验 generation、单调 revision、AI 占用标记、HTTP(S)/`about:blank` 地址、文本长度、标签关联、画面尺寸、指针坐标和操作种类；无资源的审批期只接受精确 `{operationActive:true}`。截图只作为 Blob object URL 在控制器内保存，换帧、消失、卸载时撤销；旧请求和过期修订版不能覆盖新画面。未知或关闭的浏览器显示空状态。组件只绘制 Host 捕获的图片、标题、地址及 Agent 点击、输入、滚动时相对截图坐标的虚拟指针；页面不会作为 iframe、WebView 或可执行 HTML 装入 Client。人工坐标仅从已加载、像素尺寸与观测一致的图片可见区域换算，并携带浏览器、标签、观测修订版与视口，Host 在执行时拒绝过期目标；截图不是可直接访问的网页 DOM。

浏览器状态与画面由 Host provider 提供受 Origin 与本地访问约束的只读路由；人工命令经连接服务的回环同源 `browser.control` RPC，由 Host 校验已附着的本地 Session 并拒绝远程工作区 marker。本包没有公开配置，词典包含中文和英文；CSS Modules 使用共享语义 token，窄屏会收紧工具栏，减少动态效果设置会禁用指针脉冲动画。

## 模型体验

无。本包的页面观测与人工操作不进入模型工具或日志；模型工具、日志与提示词由浏览器能力提供方持有，本包不改写。

#### KV 缓存影响

无；本包不组装模型请求。

## 已知限制与延后工作

截图按轮询频率更新而非实时视频；页面内人工交互只覆盖截图坐标点击、滚轮滚动与指定位置的文本插入，不支持 DOM 元素语义定位、文件选择或拖拽。远程 Session、非本机访问和未附着 Session 不能使用人工命令。

**运行时 invariant：** companion 只登记包名；请求栅栏、图片释放与 slot fiber 清理由包测试验证。
