---
description: "会话页头的本地打开入口，以及 Session 文件工作台和保留式底栏终端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-open-in-app

## 概述

本包拥有工作区打开能力的浏览器半边。会话页头紧邻 Session log 提供紧凑入口：本地工作区显示应用分体按钮；Remote-SSH 工作区或经 SSH 启动的 Host 打开固定工作台。宽屏主内容从左到右是对话、文件标签与预览、可筛选的懒加载文件树，真实 xterm 终端位于横跨主内容的底栏。

## 使用本包

把本 Client 插件与 [`dsh-host-open-in-app`](../../host/open-in-app/README.md) 并排挂载。布局 owner 必须声明 Session 级 `workbench` 与 `workbench.bottom` slot，并通过 `ctx.layout` 提供 `openWorkbench`、`closeWorkbench` 和 `toggleWorkbench`。Host shared 必须提供本地应用目标／启动路由、`sessionId + segments` 文件列表与读取路由，以及 Session 终端 WebSocket 路由和封闭帧类型。

## 行为

本地工作区的主按钮显示记住的应用图标，点击后由 Host 在 macOS、Windows 或 Linux 上启动对应应用；下拉菜单只展示 Host 已验证且 locale 词典认识的应用。所选 id 保存在 `dsh.open-in-app.choice`。启动请求若发现执行世界已切换为远端，Client 会改为打开工作台，不会把远端路径交给本机应用。

Remote-SSH 与 SSH Host 入口直接调用 `ctx.layout.openWorkbench()`。本包不注册 `conversation.view`，也不增加文件 conversation tab；入口始终进入固定工作台。工作台顶栏承载文件标签，右上角依次提供最大化、终端底栏和文件侧栏按钮；文件侧栏开关是组件私有 viewing state，关闭工作台按钮位于标签栏和空态中。

文件树只把当前 Session id 与 Host 返回的 provider segment 数组回传给 list/read 路由，不提交工作区根，也不拼接 Windows、POSIX 或 UNC 路径。目录按文件夹优先排序，展开时才读取下一层；筛选只作用于已加载层，点击文件会打开或激活中间标签。Markdown 使用共享 `MarkdownText`，代码和普通文本保留换行，图片使用 Host 校验后的 MIME 与 base64 内容，其它类型显示明确的 unsupported 状态。

底栏使用 `@xterm/xterm` 与 `@xterm/addon-fit`，首次显示时才按当前 Session 建立 Host WebSocket。Client 发送输入和 fit 后的 resize 帧，接收 ready、output、exit 与 error 帧；连接结束后可重新建立一条终端。隐藏底栏或关闭工作台只改变固定布局可见性，不断开已激活终端。组件卸载会释放 xterm、ResizeObserver 和 WebSocket；Host 随 socket 生命周期终止对应 PTY。本地 POSIX、本地 Windows 和 Remote-SSH 的实际 resize 与进程树语义由 Session Agent 的 subprocess provider 实现。

响应式行为以 768px 与 375px 参考视口固定：两者都由布局壳让工作台接管 rail 外主内容；768px 下文件树固定为 260px 并隐藏大小列，375px 下顶栏和按钮收紧，文件树打开时覆盖整个预览区，关闭文件侧栏后回到文件标签与预览。终端底栏继续横跨主内容，并按每次可见尺寸重新 fit。

## 实现

`OpenInAppController` 持有页面级目标缓存、应用选择和 HTTP／WebSocket URL 组装，并在浏览器 wire 边界校验 Host 响应。文件标签使用 Session scope 的 slot store；文件树展开、筛选和文件侧栏可见性属于组件本地状态。终端连接 effect 在首次显示后不再依赖底栏 `shown`，因此收起底栏不会触发清理。

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
- 已激活终端只在当前组件与 WebSocket 生命周期内保留；Session scope 卸载、网络断开或插件释放会终止该 PTY，重新连接会创建新终端而不是接回旧进程。

**运行时 invariant：** companion 只保留包归属，不安装额外关系。真实 SlotRegistry 测试验证页头、工作台和底栏 entry 会随插件 fiber 一起释放。
