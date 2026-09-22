# Agent Note: 无 Session 时从编辑器打开现有选择器

Status: implemented

## 问题

[Session scope 决策](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md)会在 Session 存在前保留同一个常驻编辑器，但 textarea 处于禁用状态，只有较小的 Workspace chip 能打开选择器。用户首次点击最显眼、也最熟悉的输入区域时，界面不会响应，尽管同一界面已有继续操作的入口。

## 决策

没有当前 Session 时，整张输入卡片都可通过鼠标点击激活现有的 `conversation.hero.workspace` 选择器——点击处理器归卡片所有，其禁用控件放行指针事件，因此整个胶囊是同一个目标；只读的常驻 textarea 也可经 Enter 或 Space 激活。`aria-haspopup="menu"` 和 `aria-expanded` 在共享选择器菜单挂载时描述其展开状态。选择器会列出并搜索已注册 Workspace，保留文件夹流程，同时由[本地、远程与无项目入口决策](2026-08-25-workspace-picker-local-remote-and-no-project-entry.md)提供三条明确的开始路径。虚线 l4 描边（SVG dash ring，因为原生 `dashed` 的间距不可调）配合 hover 时的 business 蓝，把卡片标记为选择入口。卡片会拦下 `pointerdown`，使已打开选择器的外点关闭无法与点击的重新打开竞态——先关后开会让 chip 的展开回显闪动。消息提交、命令、权限、模型及其他 Session 作用域控件会保持锁定，直到存在 Session，而不是直到选择 Workspace。

Workspace 选择继续使用现有 owner 和流程。`ConversationRoot` 打开选择器，`WorkspacePicker` 列出或创建 Workspace；该 Session 到达后，同一个 textarea DOM 节点变为可编辑状态。选择**不在项目中工作**会在 Host 默认 cwd 创建未分组 Session，同样抵达可编辑状态，但不写入 Workspace 注册记录。

## 考虑过的替代方案

**保持 textarea 禁用并突出 Workspace chip。** 这样能保留原有控件边界，但首次操作时最主要的编辑器区域仍然没有响应。

**在 textarea 上方放置透明按钮。** 按钮具备直接的触发器语义，但它会在常驻 textarea 上方增加第二个可聚焦元素，并使保留焦点、输入法和草稿行为的 DOM identity 过渡更复杂。

**在存在 Session 前接收草稿。** 这需要由 client 拥有的草稿 Session 或另一条 Session 前状态轴。此功能只需要提供一个更容易发现的现有选择器入口。

## 后果

用户首次点击编辑器即可进入清晰的开始流程，键盘用户也能激活同一路径。textarea 会如实报告只读状态，直到 Session 存在；相邻控件仍处于禁用状态。界面不引入 Session 前草稿状态；其选择器可以选择 Workspace、创建未分组 Session，或启动仅桌面端可用的 [Remote-SSH Workspace 流程](2026-08-30-desktop-remote-ssh-tool-gateway.md)。

组件测试会固定鼠标和键盘激活、覆盖整卡的点击目标、被拦下的 `pointerdown`、相邻控件锁定、选择器展开、无项目 Session 创建，以及同一节点变为可编辑 textarea 的过渡。组装后的 Web helper 会通过 textarea 开始，因此重放浏览器场景会覆盖实际交付路径。
