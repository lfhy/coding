---
description: "在 Session 工作台中显示 Host 受控浏览器画面与人工导航控件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-browser

## 用法与行为

本包的 Client 半边占用 `workbench.browser` 内容和 `workbench.browser.tabs` 顶栏标签两个会话级 slot；`ui-open-in-app` 声明 slot 并提供 `{ shown, openBrowser, closeBrowser }`。每个挂载的 Session 每约 750ms 从同源 Host GET `/browser-use/state?sessionId=` 读取观测，状态存在时再按 generation/revision GET `/browser-use/frame` 读取 PNG。工作台切换视图不会卸载内容条目；首次读取已有浏览器状态只作为基线，不抢用户的选择。挂载后出现新的模型操作画面时调用 `openBrowser()`。

选择浏览器视图时，如当前 Session 没有浏览器状态，会通过 `browser.control` 幂等建立一个 `about:blank` 标签；地址栏接受 HTTP(S) 网址或域名，回车导航，省略协议时补 `https://`。顶栏可新增、选取与关闭标签；工具栏按历史状态启用后退、前进和刷新。关闭最后一个标签返回功能菜单，并结束 Host 中该 Session 的浏览器上下文。命令进行时控件禁用，失败可重试；人工导航与模型 `browser_use` 共用该 Session 的浏览器状态，但人工命令不借用模型工具的一次性审批。

浏览器视图可见且有活动标签时，Client 按画布可用尺寸发送有界 `set-viewport` 命令，使 Host 页面视口与右栏同步，再按返回的观测尺寸显示截图和虚拟指针；隐藏视图或关闭标签不会触发调尺寸。尺寸约束由 [`apiproxy`](../../host/apiproxy/README.md) 的人工 RPC 契约规定，画面仍只是 PNG 镜像，不能通过截图点击目标网页 DOM。

状态 JSON 在 Client 边界校验 generation、单调 revision、HTTP(S)/`about:blank` 地址、文本长度、标签关联、画面尺寸、指针坐标和操作种类。截图只作为 Blob object URL 在控制器内保存，换帧、消失、卸载时撤销；旧请求和过期修订版不能覆盖新画面。未知或关闭的浏览器显示空状态。组件只绘制 Host 捕获的图片、标题、地址及 Agent 点击、输入、滚动时相对截图坐标的虚拟指针；页面不会作为 iframe、WebView 或可执行 HTML 装入 Client，人类不能直接点击或输入截图中的网页元素。

浏览器状态与画面由 Host provider 提供受 Origin 与本地访问约束的只读路由；人工命令经连接服务的回环同源 `browser.control` RPC，由 Host 校验已附着的本地 Session 并拒绝远程工作区 marker。本包没有公开配置，词典包含中文和英文；CSS Modules 使用共享语义 token，窄屏会收紧工具栏，减少动态效果设置会禁用指针脉冲动画。

## 模型体验

无。本包的页面观测与人工操作不进入模型工具或日志；模型工具、日志与提示词由浏览器能力提供方持有，本包不改写。

#### KV 缓存影响

无；本包不组装模型请求。

## 已知限制与延后工作

截图按轮询频率更新而非实时视频；人工操作只覆盖地址栏、历史与标签管理，不支持对截图中的网页内容直接点击、输入或滚动。远程 Session、非本机访问和未附着 Session 不能使用人工命令。

**运行时 invariant：** companion 只登记包名；请求栅栏、图片释放与 slot fiber 清理由包测试验证。
