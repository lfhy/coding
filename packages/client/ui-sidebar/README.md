# coding-client-ui-sidebar

侧边栏外壳插件：负责新对话行、布局持有的折叠控件、可感知滚动的区域 seat，以及固定在底部的 Settings seat。[ui-workspace](../ui-workspace/README.md) 持有渲染到 `sidebar.workspaces` 的 Workspace 与 Session 浏览器；本包既不派生其中的行，也不持有其视图偏好。折叠到布局拥有的 56px 轨道仍属于本地呈现行为。约定：slot 系统标准。

展开侧栏的第一行是新对话行：左侧是带图标与文字的「新对话」胶囊入口，右侧是 `sidebar.brand.action` 这个通用 list slot。该 list slot 在宽侧栏是横向图标行，56px rail 中纵向排列在新对话图标与展开按钮之间；注册者会收到 `wide`，且该 seat 在显示时必须适应宽栏图标行与 36px rail 控件盒。欢迎页操作行可见时该 seat 暂不渲染，折叠入口始终保留。侧栏不再渲染品牌字标，字标槽位随新对话入口一并移除。

收起按钮不由壳层渲染：壳层通过浏览区域的 owner share 交出 `collapseSidebar`，ui-workspace 把它排在标题行搜索的左侧；56px rail 没有标题行，展开按钮仍由壳层渲染在新对话图标下方。两个动作都按当前状态收敛（已展开时展开请求是空操作，已收起时收起请求是空操作），因此动画期间的误触不会反转折叠方向。

新对话入口会启动运行时的页面局部前端 Session Intent。运行时优先使用作用域操作明确指定的 Workspace，否则使用当前 Session 所属 Workspace，再否则使用最近活跃 Workspace；一个 Workspace 都没有时则清空选择，进入空白 New Session 页面。Workspace 专属控件与共享选择器由 ui-workspace 持有。

侧边栏的收起与展开最终都调用 `ctx.layout.toggleSidebar()`：宽侧栏由浏览区域标题行的按钮触发，收起 rail 中由壳层自己的按钮触发；侧栏图形经 [`ui-icons`](../ui-icons/README.md) 的语义入口渲染。

桌面壳注入窗口拖拽样式时，展开侧栏的新对话行空白处与 macOS 交通灯右侧顶部空白可拖动窗口；交通灯本身、新对话入口、操作按钮和折叠 rail 内的交通灯区域不接管原生拖拽。浏览器缺省无拖拽区域。

`SidebarRootComponentProps` 组合布局 owner share、全局 `useSessions` 和 `useWorkspaces` 钩子、`sidebar.brand.action` 这个 list slot、`sidebar.workspaces` 与 `sidebar.settings` 子 slot，以及注入的 `startSession` 与侧边栏切换回调。交给浏览区域的 owner share 只有折叠状态与两个折叠动作，区域自己不再读壳层的类名。这里没有插件 store。

实时收起时，外壳会把展开内容固定在当前宽度，并用 150ms 将其淡出。随后，轨道里的三个控件——新对话图标、并入新对话行的侧栏切换，以及通过 `sidebar.workspaces` 渲染的添加和搜索——共用一次 150ms 的淡入和 49px 左移，在布局的 300ms 栏滑动结束时一起进入 56px 轨道；每个 36px 控件盒都会沿同一条路径到达轨道左侧 10px 的内边距。固定在底部的 `sidebar.settings` 控件只共用淡入时序，不发生横向位移。页面初始即为收起状态时会静态渲染轨道；减少动态效果模式会禁用两段过渡。

栏内的滚动条是一种指针可供性：只要指针不在栏内，外壳就把 ui-theme 的[滚动条间接层](../ui-theme/README.md)重新绑定为 `transparent`；指针离开后滑块再保留 2 秒，因此没人指向的列表不会带着滚动条。避免行位移的空间预留属于滚动区域本身（[ui-workspace](../ui-workspace/README.md)），所以显示滑块不会引起重排。

页脚承载 `sidebar.settings`：侧边栏只渲染固定在底部的布局 slot，并共享其栏状态（`wide`）；ui-settings 在此注册触发行和设置面板。

`/client` 导出表层只包含插件主体（`apply`／`inject`）及约定类型；SidebarRoot、行组件和树派生仍由 slot 注册封装在包内。

## 模型体验

无。侧边栏渲染浏览器会话列表；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包（package）既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **Session 状态点渲染由 [ui-workspace](../ui-workspace/README.md) 持有**：没有可用的 done/error 通知数据源。
- **Workspace 浏览行为由组合持有**：分组、排序、搜索与行状态都属于 [ui-workspace](../ui-workspace/README.md)，不属于此外壳。
- **「New task completed」未读标记是本地查看状态**：完成时间 > 上次查看时间这一事实永远不会到达宿主。
