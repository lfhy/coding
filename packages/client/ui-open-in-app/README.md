---
description: "会话页头的本地打开入口、按类型渲染标签的右侧工作台，以及独立保留的底栏终端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-open-in-app

## 概述

右侧工作台的标签、功能菜单与显隐按 Session 管理；文件管理器、文件预览、浏览器页面、终端和可选的外部插件内容使用同一标签栏。浏览器画面的平台差异由 [`ui-browser`](../ui-browser/README.md) 和对应提供方负责，工作台只提供内容位置和标签状态。

本包拥有工作区打开能力的浏览器半边、右侧工作台和底栏终端。工作台把文件、浏览器页面和终端会话放在同一行标签中，按标签类型绘制内容；底栏终端有独立入口和标签。会话页头紧邻 Session log 提供本地工作区分体按钮，主按钮打开内置工作台，菜单可选择本地应用；Remote-SSH 工作区或经 SSH 启动的 Host 只显示固定工作台按钮。终端底栏与右侧边栏开关位于会话页头右侧；全屏或窄屏接管主内容时，工作台顶栏另提供终端底栏开关。

## 使用本包

把本 Client 插件与 [`dsh-host-open-in-app`](../../host/open-in-app/README.md) 并排挂载。布局 owner 必须声明 root scope 的 `workbench` 与 `workbench.bottom` slot；工作台通过 `useSessions` 读取当前 Session，底栏接收 owner 的当前 Session id。布局通过 `ctx.layout` 提供按 Session 定位的工作台状态源、显隐、最大化与底栏动作；会话壳须声明 `conversation.session.header.utilities` 与欢迎页的 `conversation.hero.actions`。Host shared 必须提供本地应用目标／启动路由、`sessionId + segments` 文件列表与读取路由，以及 Session 终端 WebSocket 路由和封闭帧类型。

## 行为

本地工作区的主按钮默认打开内置工作台，下拉菜单先列出内置页面，再列出 Host 已验证且 locale 词典认识的应用，选中项保存在 `dsh.open-in-app.choice`。选择应用后主按钮改为在 macOS、Windows 或 Linux 上启动它；选择内置页面，或记录的应用已经从 catalog 消失时，主按钮回到内置工作台。启动请求若发现执行世界已切换为远端，Client 会改为打开工作台，不会把远端路径交给本机应用。

Remote-SSH 与 SSH Host 入口直接为当前 Session 调用 `ctx.layout.openWorkbench(sessionId)`。本包不注册 `conversation.view`，也不增加文件 conversation tab；入口始终进入固定工作台。每个 Session 首次打开工作台时显示五项功能菜单：审查、终端、浏览器、文件、侧边聊天。审查和侧边聊天因没有对应提供方而禁用；选择终端每次新建右侧终端标签，选择浏览器每次新建一个空白页面，选择文件则创建或激活当前 Session 唯一的文件管理器标签。文件管理器和文件预览是不同标签，目录树中点击文件仍会打开独立预览标签。顶栏同一行显示已打开的文件管理器、文件预览、浏览器页面和终端会话标签，选中标签决定内容类型；顶栏只有一个共享的 `+`，点击后显示相同的功能菜单，不会在点击 `+` 本身时直接新建页面或终端。可返回菜单继续打开功能；菜单出现时原标签与内容保持挂载。关闭最后一个右侧标签会返回菜单。

右侧工作台顶栏始终提供最大化与关闭按钮；全屏或窄屏接管主内容时另提供终端底栏开关，并排模式下终端与右侧边栏开关位于会话页头右侧。会话页头的终端底栏开关在右侧工作台关闭时只显示底栏；两个面板都显示时，关闭底栏不影响右列。页头的右侧边栏开关按整个工作台的显隐切换，再次点击可收起右列；关闭右列保留已显示的底栏，初次打开工作台仍先显示功能菜单。空白会话使用欢迎页右上角入口；没有当前会话时该入口可先创建会话。

`workbench.browser` 与 `workbench.browser.tabs` 是由本包 `workbench` entry 声明的 Session 级 single slot，分别容纳浏览器内容和顶栏标签。浏览器提供方通过 `syncBrowserTabs()` 把 Host 页面标签及当前页面同步到工作台，每个页面对应一个 `browser` 标签；顶栏仅以 `tabId` 指定逐页渲染的标签按钮，新增入口由工作台持有。菜单每次选择浏览器时，内容 owner 的 `newTabRequest` 序号递增，浏览器贡献者消费一次并通过人工控制命令新建页面；`focusBrowserTab` 将焦点交给新增标签。内容的 `shown` 表示当前选中浏览器且工作台可见；标签的 `shown` 表示工作台可见，`browserShown` 表示该浏览器标签是否选中。内容通过 `selectedTabId` 接收工作台选中的浏览器页面，浏览器提供方负责对齐 Host 当前页面。`openBrowser(tabId?)` 为所属 Session 打开工作台并选中浏览器页面；成功 Agent 导航触发的展示只选 Host 已有页面，不走菜单的新建页面请求。自动展示跨异步状态同步时以 Session 的人工交互次序为界，人工选取其他标签、菜单或关闭工作台优先；页面关闭后通过标签同步移除对应工作台标签，保留其他类型的标签。切换右侧标签或隐藏工作台不会卸载当前 Session 的浏览器内容；切换 Session 时浏览器内容按对应会话重新挂载，Host 页面继续存续。文件管理器、文件预览标签、筛选及展开状态按 Session 保留，浏览器和终端内容隐藏文件预览与目录树。

工作台向逐页标签 slot 传入对应的 `tabDomId` 与 `panelDomId`。浏览器内容 slot 始终保留在同一棵 DOM 树中，当前页的面板使用对应 id 与 `aria-labelledby`，其他页面保留隐藏面板供标签的 `aria-controls` 关联；切换页面不会重新挂载内容或重建 Host 浏览器。

欢迎页右上角按从左到右的顺序注册终端底栏与右侧边栏入口到 `conversation.hero.actions`。右侧边栏入口按整个工作台的显隐切换；打开任一入口只显示对应面板，再次点击关闭对应面板，不折叠导航栏。底栏独占时右侧工作台收起但终端继续保留在横跨主内容的底栏；会话页头与工作台顶栏的普通动作仍可同时显示两个面板。已有会话时直接切换对应面板；尚无会话时先连接最近工作区，若没有工作区则在 Host 用户 HOME 创建未分组会话。连接尚未完成时两个入口复用同一次创建，最后一次点击决定打开的面板。创建失败时按钮旁显示错误并允许重试；异步创建期间用户若已切换到另一会话，入口不会抢占选择。面板状态按 Session 保存，欢迎页发送首条消息后继续沿用。

欢迎页操作行只在空白阶段可见；有内容的会话使用页头右侧操作行。全屏与窄屏工作台遮住会话列时，侧边栏品牌行不显示重复入口。

面板按钮使用 [`ui-icons`](../ui-icons/README.md) 的语义图标：右侧边栏入口使用右向侧栏图形，底栏使用终端图形，旋转与第三方图标选择不进入本包。页头与欢迎页右侧按钮的提示和无障碍名称随整个工作台的显隐在“打开右侧边栏”与“收起右侧边栏”之间切换。

桌面壳在工作台顶栏空白区域提供窗口拖拽，标签和最大化、关闭按钮保持可点击；浏览器没有拖拽区域。

文件树只把当前 Session id 与 Host 返回的 provider segment 数组回传给 list/read 路由，不提交工作区根，也不拼接 Windows、POSIX 或 UNC 路径。工作台视觉关闭时不请求目录；首次显示后才读取根目录，避免隐藏 entry 在 Session 尚未就绪时留下错误状态。目录按文件夹优先排序，展开时才读取下一层；筛选只作用于已加载层，点击文件会打开或激活中间标签。Markdown 使用共享 `MarkdownText`，代码和普通文本保留换行，图片使用 Host 校验后的 MIME 与 base64 内容，其它类型显示明确的 unsupported 状态。

右侧与底栏均使用 `@xterm/xterm` 与 `@xterm/addon-fit`。右侧菜单每次选择终端都会新建一个终端标签；底栏首次显示时才建立首个终端，底栏自己的 `+` 可继续新建。两处标签及选中状态独立，每个终端标签独占 WebSocket、PTY、xterm 和滚屏；右侧菜单不会打开底栏，页头、欢迎页与工作台顶栏的底栏入口继续显示底栏终端。根 scope 的两个占用者按 Session 保留已激活的终端树；切换标签、切换 Session 或隐藏所属面板只改变可见性，切回时沿用原连接与进程。关闭对应标签释放其连接，Host 随 socket 生命周期终止对应 PTY；会话从列表移除、插件卸载或页面关闭时释放对应终端树。

Shell 退出时，Client 在同一连接收到 exit 帧并断开后移除对应标签；意外断连或连接错误保留标签以供重连。关闭最后一个右侧终端标签时，工作台继续显示其他类型标签，没有标签则返回菜单；底栏状态不受影响。关闭最后一个底栏标签时收起底栏，重新展开空底栏会创建新终端；底栏右端关闭按钮只隐藏底栏。Client 发送输入和 fit 后的 resize 帧，接收 ready、output、exit 与 error 帧。xterm 的光标跟随主题前景色；点击标签、新建终端或重新显示所属面板会聚焦终端，方向键切换标签则把焦点留在标签上，连接就绪不会抢占焦点。组件卸载会释放 xterm、ResizeObserver 和 WebSocket。本地 POSIX、本地 Windows 和 Remote-SSH 的实际 resize 与进程树语义由 Session Agent 的 subprocess provider 实现。

响应式行为以 768px 与 375px 参考视口固定：两者都由布局壳让工作台接管 rail 外主内容；768px 下隐藏文件大小列，375px 下顶栏和按钮收紧。工作台容器自身宽度不超过 640px 时，文件管理器标签让文件树占满内容区，文件预览标签则独占内容区而不显示文件树；切回文件管理器标签或从功能菜单选择文件即可显示文件树。容器更宽时，文件管理器与文件预览标签均显示文件树。终端底栏继续横跨主内容，并按每次可见尺寸重新 fit。

### 外部标签扩展

其他 Client 插件可以向 `ctx.sidebarRightTabs.register(definition)` 注册右侧工作台的标签类型。`ctx.sidebarRight.openTab(kind, { params? })` 在当前 Session 打开类型入口；`openTabForSession(sessionId, kind, { params? })` 定向打开，`openResourceForSession(sessionId, address, { kind?, params? })` 则按地址路由。`focusTab`、`updateTab`、`closeTab` 操作的是指定 Session 中的实例 id，而不是定义 id。定义的 `id` 标识内容提供方，`kind` 标识默认单实例去重类别：重复打开同一 `kind` 会更新并选中已有标签；`multiple: true` 为每次打开分配新的实例 id。`params` 只接受可序列化的 JSON 值。类型可使用 URI `patterns`、`priority` 和 `canOpen` 选择地址，显式 `kind` 不检查 pattern，但仍须通过 `canOpen`；未找到可用类型时打开失败。定义的 `title(address)` 在打开时生成并保存实例标题，`updateTab` 可更新地址、参数和可选标题。

定义可提供按 `order` 排列的 `guide` 入口；这些入口和内置功能共用工作台的 `+` 菜单，`canOpen` 否决类型入口时该项不可用。内容注册到 Session 级 keyed slot `sidebar.right.pane.tab`，可选的标签标题注册到 `sidebar.right.pane.tab.title`，两者的注册键均为定义 `id`，不是实例 id；标题未贡献时使用保存的实例标题。owner 提供 `tab`（含实例 id、地址、参数和修订号）、`shown`、`tabDomId`、`panelDomId`、`selectTab` 与 `closeTab`，不传 React 节点或服务对象。`keepMounted: true` 使内容在当前 Session 切换标签或隐藏工作台时保留挂载；切换 Session 会重挂内容，未设置时仅绘制当前可见实例。工作台状态按 Session 隔离。注册用插件自身的 `ctx.effect()` 持有 disposer，slot 贡献用 `ctx.slots.inject(...)` 跟随声明和插件生命周期撤销；定义卸载时按定义 id 关闭各 Session 已打开的对应实例。

该扩展只在现有单个右侧工作台中显示标签，不提供分栏、浮动窗或跨 Session 移动。上游 Better Sidebar v0.24.1 仅作为交互设计参考：其二进制插件依赖 DSH 0.2 和本项目没有的 `ui-sidebar-right`，不能直接安装或加载。这里不引入 ego-browser 的独立 Chrome/CDP 画面路径；它也不是 WebView。工作台浏览器继续由 Host 浏览器提供方与桌面原生 guest 承担。

## 实现

`OpenInAppController` 持有页面级目标缓存、应用选择和 HTTP／WebSocket URL 组装，并在浏览器 wire 边界校验 Host 响应。工作台 entry 的 root scope store 按 Session 保存 `file`、`browser`、`terminal`、`external` 标签、选中项、筛选、展开目录和已加载目录；文件树是否显示由当前标签类型及窄屏文件预览布局决定。`WorkbenchPanelToggles` 作为 Session 级条目注册到 `conversation.session.header.utilities`；工作台顶栏直接读取工作台 owner props。底栏终端标签由独立的 root scope 占用者按 Session 保存；两处终端连接 effect 均不依赖 `shown`，切换标签、切换会话或隐藏面板不会触发清理。

所有可见文案在 `open-in-app` namespace 中维护中文与英文词典。组件样式使用 CSS Modules 和共享 `--dsw-*` token；768px 规则固定平板文件树宽度，375px 手机视口使用单面板布局。

## 模型体验

无，因为页头控件、文件读取和用户终端不会追加 Session 事件，也不会进入模型请求。

#### KV 缓存影响

无；本包不组装 provider 请求。

## 已知限制与延后工作

- 文件视图只读，不提供上传、保存、重命名或删除。
- 文件内容由 Host 完整返回；大文件截断、大小上限和二进制分类由 Host 契约负责。
- 文件树不监听实时文件系统变更，用户可显式刷新根目录或文件预览。
- 预览只覆盖 Markdown、代码、文本和图片；PDF、Office 与 HTML 沙箱预览尚未接入。
- 已激活终端只在当前页面与 WebSocket 生命周期内保留；Session 从列表移除、网络断开或插件释放会终止对应 PTY，重新连接会创建新终端而不是接回旧进程。

**运行时 invariant：** companion 只保留包归属，不安装额外关系。真实 SlotRegistry 测试验证页头开关、欢迎页、工作台和底栏 entry 会随插件 fiber 一起释放。
