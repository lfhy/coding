---
description: "会话页头的本地打开入口，以及 Session 文件工作台和保留式底栏终端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-open-in-app

## 概述

本包拥有工作区打开能力的浏览器半边。会话页头紧邻 Session log 提供紧凑入口：本地工作区显示分体按钮，主按钮打开内置文件工作台，菜单可在内置工作台与本地应用之间切换；Remote-SSH 工作区或经 SSH 启动的 Host 只显示固定工作台按钮。终端底栏与文件侧栏开关位于会话页头右侧；工作台全屏或窄屏接管主内容时，开关位于工作台顶栏右侧。宽屏主内容从左到右是对话、文件标签与预览、可筛选的懒加载文件树，真实 xterm 终端位于横跨主内容的底栏。

## 使用本包

把本 Client 插件与 [`dsh-host-open-in-app`](../../host/open-in-app/README.md) 并排挂载。布局 owner 必须声明 Session 级 `workbench` 与 `workbench.bottom` slot，并通过 `ctx.layout` 提供按 Session 定位的工作台状态源、显隐、最大化、底栏与文件侧栏动作；会话壳须声明 `conversation.session.header.utilities` 与欢迎页的 `conversation.hero.actions`。Host shared 必须提供本地应用目标／启动路由、`sessionId + segments` 文件列表与读取路由，以及 Session 终端 WebSocket 路由和封闭帧类型。

## 行为

本地工作区的主按钮默认打开内置文件工作台，下拉菜单先列出内置页面，再列出 Host 已验证且 locale 词典认识的应用，选中项保存在 `dsh.open-in-app.choice`。选择应用后主按钮改为在 macOS、Windows 或 Linux 上启动它；选择内置页面，或记录的应用已经从 catalog 消失时，主按钮回到内置文件工作台。启动请求若发现执行世界已切换为远端，Client 会改为打开工作台，不会把远端路径交给本机应用。

Remote-SSH 与 SSH Host 入口直接为当前 Session 调用 `ctx.layout.openWorkbench(sessionId)`。本包不注册 `conversation.view`，也不增加文件 conversation tab；入口始终进入固定工作台。工作台顶栏左侧承载文件标签，右侧在全屏或窄屏接管主内容时提供两个面板开关及最大化、关闭；并排模式下开关仅在会话页头右侧。点击开关时若工作台未打开，会先打开工作台再显示对应面板：文件侧栏默认呈现内置文件管理，终端底栏默认呈现终端；文件侧栏默认打开，显隐按 Session 保存。空白会话使用欢迎页右上角入口；没有当前会话时该入口可先创建会话。

欢迎页右上角按从左到右的顺序注册终端底栏与文件侧栏入口到 `conversation.hero.actions`。打开任一入口只显示对应面板；再次点击关闭对应面板，不折叠导航栏。底栏独占时右侧工作台收起但终端继续保留在横跨主内容的底栏；会话页头与工作台顶栏的普通动作仍可同时显示两个面板。已有会话时直接切换对应面板；尚无会话时先连接最近工作区，若没有工作区则在 Host 用户 HOME 创建未分组会话。连接尚未完成时两个入口复用同一次创建，最后一次点击决定打开的面板。创建失败时按钮旁显示错误并允许重试；异步创建期间用户若已切换到另一会话，入口不会抢占选择。面板状态按 Session 保存，欢迎页发送首条消息后继续沿用。

欢迎页操作行只在空白阶段可见；有内容的会话使用页头右侧操作行。全屏与窄屏工作台遮住会话列时，工作台顶栏直接提供面板开关，侧边栏品牌行不显示重复入口。

面板按钮使用 [`ui-icons`](../ui-icons/README.md) 的语义图标：文件侧栏使用右向侧栏图形，底栏使用终端图形，旋转与第三方图标选择不进入本包。

桌面壳在工作台顶栏空白区域提供窗口拖拽，文件标签和最大化、关闭按钮保持可点击；浏览器没有拖拽区域。

文件树只把当前 Session id 与 Host 返回的 provider segment 数组回传给 list/read 路由，不提交工作区根，也不拼接 Windows、POSIX 或 UNC 路径。工作台视觉关闭时不请求目录；首次显示后才读取根目录，避免隐藏 entry 在 Session 尚未就绪时留下错误状态。目录按文件夹优先排序，展开时才读取下一层；筛选只作用于已加载层，点击文件会打开或激活中间标签。Markdown 使用共享 `MarkdownText`，代码和普通文本保留换行，图片使用 Host 校验后的 MIME 与 base64 内容，其它类型显示明确的 unsupported 状态。

底栏使用 `@xterm/xterm` 与 `@xterm/addon-fit`，首次显示时才为当前 Session 建立首个 Host WebSocket。`coding 1` 等终端标签可新增、切换和单独关闭；每个标签独占一个 WebSocket 与 PTY，切换标签保留输出和进程，关闭标签释放对应连接。最后一个标签关闭后底栏保持打开，可用加号再创建终端；底栏右端关闭按钮只隐藏底栏，不终止标签。Client 发送输入和 fit 后的 resize 帧，接收 ready、output、exit 与 error 帧；连接结束后可在原标签重新建立终端。隐藏底栏或关闭工作台只改变固定布局可见性，不断开已激活终端。xterm 的光标跟随主题前景色；点击标签、新建终端或重新展开底栏会聚焦终端，方向键切换标签则把焦点留在标签上，连接就绪不会抢占焦点。组件卸载会释放 xterm、ResizeObserver 和 WebSocket；Host 随 socket 生命周期终止对应 PTY。本地 POSIX、本地 Windows 和 Remote-SSH 的实际 resize 与进程树语义由 Session Agent 的 subprocess provider 实现。

响应式行为以 768px 与 375px 参考视口固定：两者都由布局壳让工作台接管 rail 外主内容；768px 下文件树固定为 260px 并隐藏大小列，375px 下顶栏和按钮收紧，文件树打开时覆盖整个预览区，关闭文件侧栏后回到文件标签与预览。终端底栏继续横跨主内容，并按每次可见尺寸重新 fit。

## 实现

`OpenInAppController` 持有页面级目标缓存、应用选择和 HTTP／WebSocket URL 组装，并在浏览器 wire 边界校验 Host 响应。会话页头与工作台 entry 共用一个 Session scope slot store，保存文件标签、当前文件、筛选、展开目录和已加载目录；文件侧栏显隐由布局按 Session 持有，经 `workbench` owner props 的 `filesOpen` 传入，不同 Session 的状态彼此独立。`WorkbenchPanelToggles` 作为 Session 级条目注册到 `conversation.session.header.utilities`；全屏顶栏直接读取工作台 owner props。终端标签属于 Session scope 的已挂载底栏，终端连接 effect 不依赖底栏 `shown`，因此收起底栏不会触发清理。

所有可见文案在 `open-in-app` namespace 中维护中文与英文词典。组件样式使用 CSS Modules 和共享 `--dsw-*` token；768px 规则固定平板文件树宽度，375px 手机视口落入 480px 以下的单面板覆盖规则。

## 模型体验

无，因为页头控件、文件读取和用户终端不会追加 Session 事件，也不会进入模型请求。

#### KV 缓存影响

无；本包不组装 provider 请求。

## 已知限制与延后工作

- 工作台只读，不提供上传、保存、重命名或删除。
- 文件内容由 Host 完整返回；大文件截断、大小上限和二进制分类由 Host 契约负责。
- 文件树不监听实时文件系统变更，用户可显式刷新根目录或文件预览。
- 预览只覆盖 Markdown、代码、文本和图片；PDF、Office 与 HTML 沙箱预览尚未接入。
- 已激活终端只在当前组件与 WebSocket 生命周期内保留；Session scope 卸载、网络断开或插件释放会终止对应 PTY，重新连接会创建新终端而不是接回旧进程。

**运行时 invariant：** companion 只保留包归属，不安装额外关系。真实 SlotRegistry 测试验证页头开关、欢迎页、工作台和底栏 entry 会随插件 fiber 一起释放。
