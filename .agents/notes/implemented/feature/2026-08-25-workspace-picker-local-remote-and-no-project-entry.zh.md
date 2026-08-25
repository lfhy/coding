# Agent Note: 工作区选择器提供本地、远程与无项目入口

Status: implemented

[English](2026-08-25-workspace-picker-local-remote-and-no-project-entry.md) | 中文

## 问题

Hero Workspace 选择器把选择已注册本地 Workspace 作为开始输入的唯一持久路径。想添加文件夹、打开已经可达的 Host，或在 Host 默认目录中工作的用户，要么得发现另一条入口，要么无法从同一个主要控件开始。

## 决策

`WorkspacePicker` 渲染可搜索的已注册 Workspace 列表，并保留三项固定 Hero 操作。**打开文件夹**只委托给既有目录流 slot，因此同一个原生或应用内选择器仍拥有本地路径选择。**远程连接**打开地址对话框。`remoteHostUrl` 接受完整且不含凭据的 `http://` 或 `https://` URL，随后选择器调用 `location.assign()`；HTTPS 部署和既有的 SSH 本地端口转发都是有效目标。目标页面拥有连接、认证和诊断。

**不在项目中工作**调用 `IWorkspaces.startSessionWithoutWorkspace()`。`WorkspaceRuntime` 经由 `SessionRuntime.createUnscoped()` 创建 `session.create({})`，并打开返回的、可在列表中寻址的 Session。Host 提供其正常的默认 cwd；缺少 `workspaceId` 会使该 Session 不写入任何 Workspace 账目。这个 Session 存在后，即使 Hero chip 显示无项目状态，常驻编辑器仍可编辑。

侧边栏的仅添加按钮仍只用于本地文件夹。它不暴露远程导航，也不创建未分组 Session，因为它是添加 Workspace 的快捷操作，而不是 Hero 的完整开始菜单。[无 Session 编辑器入口](2026-08-07-workspace-picker-composer-entry.md)、[添加 Workspace 的唯一路径](../simplification/2026-07-31-one-route-to-add-a-workspace.md)、[Workspace 产品流程](2026-07-25-workspace-ui-product-flow.md)、[目录选择器能力 seam](../architecture/2026-07-28-directory-picker-capability-seam.md)和[目录选择器自适应默认值](2026-07-29-directory-picker-adaptive-default.md)仍各自保留其所有权规则。

## 考虑过的替代方案

- **在选择器中实现 SSH 建连、发现或认证。** 未采用：这些能力需要传输、凭据和网络安全的所有权，超出浏览器菜单；地址导航无法安全地推断它们。
- **把远程 Host 注册为 Workspace。** 未采用：Workspace 是本地 Host 的目录／记账记录，而远程操作改变的是拥有整个 Host 连接的页面。
- **继续锁定无 Workspace 视图。** 未采用：使用 Host 默认 cwd 的 Session 已是具体且安全的工作上下文；在它存在后仍禁止输入，会把注册记录与工作目录混为一谈。
- **把所有开始操作放进侧边栏。** 未采用：侧边栏控件既有含义是接纳本地 Workspace，向其中加入页面导航或 Session 创建会弱化这一聚焦操作。

## 后果

主要选择器呈现三种开始路径，同时不降低本地目录选择的可组合性。远程导航只适用于用户提供的、已经可达的端点，并有意把 TLS、局域网暴露、SSH 隧道、发现、认证和目标验证留在此 UI 之外。无项目 Session 以未分组状态可见，并在 Host 默认 cwd 中运行；它不是没有文件系统或持久化的模式。

## 验证

组件测试覆盖搜索、三项 Hero 操作、远程输入失败和无项目创建失败。运行时测试固定未分组的 `session.create({})` 调用及其即时选中；地址测试拒绝不完整、非 HTTP(S) 和携带凭据的 URL。
