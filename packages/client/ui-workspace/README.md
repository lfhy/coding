# @deepseek-ai/dsh-client-ui-workspace

共享 Workspace 浏览器与选择器插件。`WorkspaceBrowser` 填充侧边栏的 `sidebar.workspaces` slot，`WorkspacePicker` 则填充页面局部 Session Intent 主视觉区的 `conversation.hero.workspace` slot；两个界面使用同一套 Workspace 菜单和添加流程。

该浏览器通过全局运行时钩子将 Session 行渲染为分组或扁平形式，并负责 Workspace 添加／重命名／重排序以及 Session 重排序。每个 Workspace 会记住自身是关闭还是显示 Session；打开后默认显示五条 Session，其余条目通过临时的**展开其余**控件显示，而关闭并重新打开整个 Workspace 后会恢复为五条。从 Workspace 行创建 Session 时会先展开该分组，使该 Session 转为可见行时直接落在展开的分组内。空白会话（`SessionSummary.blank`，即还没有跑过任何轮次的会话）不作为行进入侧边栏会话树：分组与单列表都不渲染它的行，顶部「新会话」和工作区行的「＋」因此不会在分组下产生一条被选中的空行；工作区行本身以 `containsCurrent` 高亮当前会话的归属，空白会话则按工作区复用（同一工作区再次新建会话会回到它的那条空白会话），也不进入内容搜索。空白会话唯一可见的入口是会话页的空态 Hero，也就是本包填入 `conversation.hero.workspace` 选择器的那块界面。Workspace 列表基线就绪后，浏览器持久化的展开状态与 Session 顺序记录只保留当前 Workspace id、Ungrouped 和单列表记账。视图选项把分组方式和每个记账各自的一份浏览器持久化 Session 顺序放在一起：真实 Workspace 从 `WorkspaceView.sessionIds` 初始化，Ungrouped 和跨 Workspace 的单列表则从最近更新时间顺序初始化。**手动排序**和**最近更新**在两种呈现方式下都可用。进入最近更新时会执行一次完整的时间排序，后续 user prompt 或 steer 会将对应 Session 置顶一次；进入手动排序则保留所有当前位置并停用后续置顶。两种模式下的拖拽都会编辑当前顺序；真实 Workspace 在手动模式下的拖拽还会更新 Host Session 记账，而 Ungrouped 和单列表因没有单一 Workspace 记账，其顺序始终只保存在浏览器本地。单列表没有父级层次，因此不显示空的左侧状态槽；Session 存在可见状态时仍保留该槽。无论采用哪种 Session 顺序，Workspace 拖拽顺序都由 Host 持久化。

折叠搜索是视图和添加操作旁的一枚区头按钮。在轨道中，添加和搜索会渲染为沿外壳共用横向进入路径移动的 36px 控件。激活搜索后，输入框会扩展并占据区头；点击外部只会收起经清除首尾空白后为空的查询——但轨道搜索手势仍在进行期间（直至列滑动结束、焦点落入输入框）除外，这样触发展开的那次点击不会收起它刚打开的搜索——而清除控件总会重置并收起搜索。非空白查询会以单一扁平结果列表替代任一浏览模式：不区分大小写的标题和 Workspace 子串匹配项会立即显示，经 250 ms 防抖的 Host 请求则会加入经过排序的当前对话内容匹配项及其摘要片段。英文搜索输入框及其防御性请求路径会移除 NUL，将查询限制在传输 schema 规定的 500 个 UTF-16 代码单元内且不会拆分代理项对，并保留现有的防抖与取消行为。每次新查询都会中止前一个请求；内容搜索失败时，元数据匹配项仍会显示，同时给出警告。列表最多显示 20 条结果，并会在查询过宽时提示用户缩小范围；打开所选 Session 时既不会清除查询，也不会跳转至特定事件。

Hero 选择器通过全局 `useWorkspaces` hook 列出真实的 Host Workspace 实体，并在输入时按标题或路径筛选。选择 Workspace 会调用 slot owner 的 `onPick` 回调，重新定位前端 Session 对象。不同的规范化路径即使 basename 和显示标题相同，仍会作为由 id 区分的独立 Workspace；侧边栏的悬停详情把 POSIX 家目录及其后代显示为 `~`／`~/…`，Windows 路径保持原样。其固定操作为**打开文件夹**、**连接 Remote-SSH**和**不在项目中工作**。第一项仅在目录流 slot 已被占用时渲染。连接 Remote-SSH 会打开三步桌面向导：输入 SSH 及密码或私钥认证、观察连接和 agent（智能体）启动进度、选择远程目录。Wails 通过每窗口内存 token 授权 bridge，Electron 通过 preload 注入的无 token 受限 API 授权；普通浏览器没有远程桥接调用面。认证信息只保留于当前对话框／连接；未知 `known_hosts` 密钥必须由用户明确确认，已变更的密钥会作为连接失败报告。桌面端持有 SSH 连接和仅监听远端回环地址的 Go agent；首次连接上传的是小型 agent，不是 Node。选择目录会先创建不含凭据的本地 marker，再创建 Workspace，使本地 Host 能把远程文件系统、进程、终端、搜索、语言服务器与 Code Mode 执行世界路由到该目录。应用重启后不会恢复连接；重新执行同一 Remote-SSH 流程会在不保存凭据的前提下把既有 marker 与 Workspace 重新绑定。无项目操作会在 Host 用户 HOME 目录创建并打开一个未分组 Session，因此「不在项目中工作」表示没有 Workspace 注册记录，而不是没有工作目录。侧边栏的仅添加入口仍只执行目录操作。

每个注册各自声明一个**目录流子 slot**（`single` kind：`conversation.hero.workspace.directoryFlow`／`sidebar.workspaces.directoryFlow`），由组合的选择器包 client half 填入其选取交互——今天是 [`-native`](../../host/directory-picker-native/README.md) 后端的无渲染 OS 选择器驱动，`-browse` 组合下则是应用内浏览对话框。本包持有触发与接纳：占用方通过 slot 的属主交互约定（`open`/`busy`/`onPicked`/`onCancel`/`onError`）每次打开上报一个所选路径，owner 通过对象层接纳它，并等待 Workspace 列表投影刷新后才选中已提交的 Workspace；取消操作不会显示提示，错误落入可重试的文件夹对话框，其 **重新选择** 会重新打开流程。添加只有一条路径：占用者自带的新建文件夹能力已经覆盖了全新目录，因此不再单设按名称创建的对话框。运行时 Session 与 Workspace 服务负责物化。Workspace 行内的 Delete 操作会打开确认框，说明保留边界、阻止重复提交，并在失败时保持打开；成功后，该分组会被移除，其 Session 则留在 Ungrouped 下。Session 行内的 Rename 操作打开同款浏览器持有的对话框，并以该行的显示标题预填：客户端不设名称冲突规则（host 负责规范化，可能以 `title-invalid` 拒绝，错误渲染在对话框告警区）；确认未修改的标题是有意允许的——这正是把当前自动标题钉住、不再被重新生成覆盖的手势。Session 行内的 Archive 操作不经确认对话框直接提交（非破坏性：日志和 workspace 记账席位保持不变），通过 `ctx.workspaces.archiveSession` 归档；归档集合回声落地后，该行从所有分组视图——workspace 分组、Ungrouped、内容搜索和平铺列表——中消失，失败只作为控制台诊断输出，树保持不变。

Workspace 和 Session 悬浮卡片会复制对应行被截断的值：激活 Workspace 卡片会写入其完整目录路径，激活 Session 卡片则会写入其完整显示标题。只有浏览器接受剪贴板写入后，卡片才会显示由字典提供的已复制状态。

Session 行内的 fork 操作在源会话最后一个已完成轮次处 fork，在客户端递增继承的持久化标题后再打开子会话；尾部半角或全角括号编号会原样式递增，无编号标题追加 ` (1)`。源会话与子会话在 workspace 组内始终作为同级行展示，谱系只保留为 session 数据。Fork 或改名失败都不会改变当前选中项，改名失败时已创建的子会话仍会留在列表中。

Session 行渲染运行时的实时 `pendingInteraction` 分类：审批显示**等待审批**，计划审阅显示**计划待审**，普通问题显示**等待回答**。每个待处理交互都使用一枚琥珀色警告点，优先级高于运行指示器；普通行的悬浮卡片重复显示本地化状态，普通行和搜索结果行则都以相同文本提供面向辅助技术的视觉隐藏标签。运行状态使用蓝色指示器及其隐藏标签；空闲行会保留空的状态槽位。

两个目标 slot 都由其他插件声明，因此 `apply` 使用 `slots.inject()` 在各自的声明生命周期内完成注册，并在目标 slot 的声明恢复后重新注册。

共享侧边栏投影会隐藏持久化 Session 摘要中带有 `origin: 'subagent'` 的行；用户从所选父级的 subagent 页头目录进入这些对话。每个可见的普通行都会在经不间断的 subagent 谱系可达的任一后代运行时继承蓝色活动指示器；其悬停与无障碍文本会报告确切的运行中后代数量，同时不会把空闲 parent 描述为正在运行。普通 fork 仍然可见，并会终止此聚合，因为仅有谱系不会设置该 origin。待处理的用户交互优先于会话自身的运行中状态，二者无论哪一项存在都会保持为行的主要状态，而后代活动仍作为独立的悬停与无障碍状态保留。两者均不存在时，后代活动优先于绿色的未查看完成提醒；最后一个运行中的后代停止后，该提醒会重新出现。运行时仍保留隐藏行，供对话、标题与已寻址传输状态使用。

## 模型体验

无，因为本包只提供浏览器侧的 Workspace 浏览器与选择器，注册的内容都不进入模型请求。

#### KV 缓存影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延后工作

- **没有模糊内容搜索或事件深链接**：内容后端采用字面 token／短语匹配，选择结果会打开 Session，而不是匹配的事件。
- **没有 Session 删除与取消归档控件**：会话可以归档，但已归档会话没有查看或取消归档入口；删除 Workspace 注册记录不会删除 Session。
- **待处理的用户交互不会聚合到折叠的分组上**：折叠分组内正在等待的行不会点亮分组头指示，只有展开该分组后才可见。
- **原生文件夹选择依赖本地 Host 载体**：在 `-native` 组合下，进程内部署或远程浏览器部署无法打开本地操作系统对话框；模态框会显示平台故障，并允许重试。可远程的选取是 `-browse` 组合的应用内流程。
- **Remote-SSH 需要存活的桌面连接**：其 Go agent 会在所选目录上运行文件系统、进程、终端、搜索、语言服务器和 Code Mode 工作，不要求目标侧安装 Node。本地 Host 仍负责工具审批和持久 Session 日志。过期 marker 或断开的 bridge 会失败，不会把操作转向本机；桌面端重启后需要重新连接。
- **Remote-SSH 需要目标账号获准 TCP 转发**：SSH 登录成功后，服务器仍可能拒绝 agent 健康检查所需的转发；向导会提示登录已成功但服务器拒绝 TCP 转发（`port-forwarding-denied`）。请管理员核对适用于该账号的 `AllowTcpForwarding`、`DisableForwarding`、`PermitOpen` 和 `Match` 限制，按服务器策略调整并应用配置后重试，或改用获准转发的账号；无需全局放宽转发策略。
