# Agent Note: 桌面窗口外壳保留标题栏手势并避让侧边栏安全区

Status: implemented

## 问题

Coding 桌面壳使用 Wails `FullSizeContent`，因此 WebView 承担可见的顶部外壳，而原生 macOS 交通灯悬浮在这层内容之上。外壳需要保留原生标题栏手势，同时不能让浏览器 Client 依赖桌面 API；侧边栏底部在插槽占用者变化时也必须保持贴边。

## 决策

[`apps/desktop/main.go`](../../../../apps/desktop/main.go) 将 Wails 窗口起始状态设为 `options.Maximised`。`OnDomReady` 桥接会等非交互顶部内容发生移动后才发送拖拽消息。macOS 本地事件监听会处理同一顶部区域的静止双击，并直接调用 `NSWindow` 的原生缩放切换：Host 使用随机回环端口，不能通过 Wails 的绑定来源校验发送窗口消息。

桌面 bundle identifier 与 Wails 单实例标识统一为 `com.coding.desktop`；DeepSeek Harness 的包作用域仍是运行时实现细节，不属于 Coding 的产品身份。

官方浏览器图标品牌 slot 使用 `BrandMark`，它渲染公开的 `/favicon.png` 资源。展开侧边栏只显示 `Coding` 名称；源码 commit 元数据仅用于构建。客户端标题和 PWA manifest 使用同一产品名称。

侧边栏根节点让折叠 rail 的顶部内边距也叠加 `--app-safe-area-inset-top`，与展开列保持一致。footer 使用自动顶部外边距，设置触发器在宽列和 rail 两种状态都移除底部外边距；根节点不再保留底部内边距，让触发器贴到视口底边。

收起 rail 顶部控件始终渲染用于展开侧边栏的面板图标。品牌图标不再替换交互控件。

[macOS 菜单栏常驻](../feature/2026-08-24-macos-menu-bar-resident-desktop.md)拥有隐藏窗口生命周期；本记录仍只涵盖标题栏手势与 Client 安全区。

## 备选方案

- **恢复原生标题栏。** 不采用：桌面壳刻意使用 full-size content，并需要由 WebView 提供共享的顶部拖拽区域。
- **在侧边栏组件中写死桌面顶部偏移。** 不采用：同一组件也发布到普通浏览器，写死偏移会产生无法解释的空隙；由壳层提供自定义属性可以把平台差异留在边界上。
- **绝对定位设置触发器。** 不采用：footer 有动态插槽占用者，使用 flex 可以让设置项贴边而不耦合具体操作集合。

## 影响

桌面启动时默认最大化，顶部空白区域双击可以切换该状态，同时不会把 macOS 交通灯当作标题栏。浏览器构建继续使用安全区变量的 0 回退值。rail 控件会避开 macOS 交通灯，设置控件贴到侧边栏底边，footer 贡献仍可组合。

## 测试

侧边栏和设置 CSS 契约由定向 Vitest 用例覆盖。`CGO_ENABLED=1 go test ./...`、带标签的桌面生产构建和 Web 构建均通过；重新构建的桌面 Host 几何核对确认宽列和 rail 的设置触发器都贴到视口底边。

基础组件、侧边栏、品牌和 PWA 检查固定共享图标、没有 commit 徽标以及 Coding 浏览器身份。
