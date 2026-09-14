# 客户端 UX 与界面设计规范

本文是 `packages/client` 可见界面的中文参考。它描述当前产品的体验方向和视觉约束；共享 token、CSS Modules 和主题工程规则以 [`docs/web-styling.md`](../../docs/web-styling.md) 及 [`ui-theme` 样式源](ui-theme/src/styles/)为准。修改客户端可见 UI 前先阅读本文，再阅读所属组件和上述样式参考。

## 产品气质

客户端是面向重复工作的 AI 工作台，不是营销页面。首屏优先呈现会话、工作区和输入动作；信息密度要支持扫描和比较，装饰只在帮助识别状态或层级时出现。

界面使用克制的平面层级和少量阴影，不采用柔和拟态、玻璃卡片或互相嵌套的卡片。一个区域只保留一个主要容器，重复条目才使用卡片或列表边界。空会话输入区后可保留一个低透明度的业务色背景提示；它不是卡片或光效层，也不参与交互。

交互状态必须可见且可恢复：悬停、按下、选中、禁用、加载、成功和错误使用明确的颜色或文案区分；状态改变不应依赖颜色单独传达。

## 页面层级

主应用由外壳、侧边栏、会话内容和输入区组成。外壳负责稳定的区域尺寸，侧边栏负责导航和工作区账目，会话区负责阅读和操作，输入区负责当前会话的下一步动作。

空会话 Hero 只展示与开始工作直接相关的品牌标识、时段问候、标准模式、工作区和输入框，不保留固定产品标题或预览状态徽标。问候按本地时间在早上、中午、下午和晚上四个时段切换；模式选择器先于工作区选择器；工作区 chip 是紧凑的透明触发器，不绘制普通边框。

设置使用独立的全视口模态层：遮罩、单个高层面板、导航栏和内容列。导航切换不改变面板尺寸；只让内容列滚动，避免指针下的布局跳动。基准实现见 [`SettingsRoot.module.css`](ui-settings-general/src/client/SettingsRoot.module.css)。

菜单、提示和确认框是局部操作层，不应伪装成第二个页面。菜单贴近触发器，确认框只保留完成当前决定所需的说明和动作。

## 配色与 token

颜色只从 `--dsw-*` 语义 token 取得；功能包不得复制静态色板或写入颜色字面量。下表列出当前最常用的角色和代表值，具体定义以 [`design-platform.css`](ui-theme/src/styles/design-platform.css)为准。

| 角色 | 亮色 | 暗色 | 用途 |
| --- | --- | --- | --- |
| `bg-base` | `neutral-bluish-00`，`rgb(255,255,255)` | `neutral-bluish-950`，`rgb(21,21,23)` | 应用画布 |
| `bg-layer-1` | `neutral-bluish-00` | `neutral-bluish-875`，`rgb(35,35,36)` | 输入、次级表面 |
| `bg-layer-2` | `neutral-bluish-00` | `neutral-bluish-850`，`rgb(44,44,46)` | 面板和主要容器 |
| `bg-layer-3` | `neutral-bluish-00` | `neutral-bluish-800`，`rgb(53,54,56)` | 菜单、较高层级浮层 |
| `bg-mask-1` | `rgba(0,0,0,.24)` | `rgba(0,0,0,.50)` | 模态遮罩 |
| `label-primary` | `neutral-bluish-1000` | `neutral-bluish-50` | 标题、主要正文 |
| `label-secondary` | `neutral-bluish-700` | `neutral-bluish-300` | 辅助说明 |
| `brand-primary` | `neutral-bluish-1000` | `neutral-bluish-50` | 主要按钮、当前步骤 |
| `state-business-primary` | `deepseek-500`，`rgb(65,118,230)` | `deepseek-400`，`rgb(103,158,254)` | 业务强调、运行状态 |
| `state-success-primary` | `green-500` | `green-500` | 成功和完成 |
| `state-warn-primary` | `amber-500` | `amber-500` | 需要确认的风险 |
| `state-error-primary` | `red-600` | `red-400` | 错误和拒绝 |

交互填充使用 `interactive-bg-hover` 和 `interactive-bg-active`；细线使用 `border-l1` 或 `border-l2`。不要用纯黑或纯白阴影制造浮雕，也不要用品牌色填满非主要动作。

## 表面、阴影与模态框

普通内容留在 `bg-base` 或 `bg-layer-1`，面板使用 `bg-layer-2`，菜单等更高层级内容使用 `bg-layer-3`。层级由表面和上下文共同表达，不通过多重内阴影堆出拟态效果。

模态框使用共享 [`Modal.module.css`](ui-primitives/src/Modal.module.css) 的全视口遮罩、`--dsw-mask-blur`、24px 圆角和 `--dsw-shadow-lv3`。浅色主题的 `border-inverted` 可呈透明；暗色主题保留 token 提供的细边界。模态层 z-index 为 1000，遮罩点击和 Escape 的关闭行为由拥有者明确决定。

设置面板的基准几何为宽 800px、高度 `min(800px, 100vh - 48px)`、最大宽度 `100vw - 48px`；导航栏约 188px，选中项 12px 圆角，内容列以 24px 内边距滚动。

Remote-SSH 向导必须复用设置面板的容器语言：宽度优先使用 800px 的约束，单一 layer-2 表面、lv3 阴影和 24px 圆角；步骤栏只用轻分隔线或透明底色，当前步骤使用导航选中填充。字段边框、目录列表边界和主机密钥警告只在表达输入、滚动或风险时保留，不得再套一层装饰性面板。实现位于 [`RemoteSshWizard.module.css`](ui-workspace/src/client/RemoteSshWizard.module.css)。

## 几何与排版

间距以 4px 为基本单位，常用节奏为 4、8、12、16、24px。标题、正文和说明必须成对指定字号与行高；优先使用现有主题排版变量，不为单个组件发明近似值。

圆角按语义分级：输入和小控件通常 8px，导航项 12px，chip 16px，主要面板 24px，胶囊按钮按共享 Button 几何执行。相邻控件保持同一圆角家族，不在一个区域混用大量半径。

按钮优先使用共享 `Button` 和图标；图标按钮必须有可访问名称和悬停提示。文本按钮只表达清晰的命令，能用熟悉符号完成的撤销、关闭、保存等动作不重复塞入长文本。

## 交互与可访问性

所有可点击元素都要有悬停和键盘焦点反馈，焦点不能只靠颜色微差表达。表单控件使用关联 label，异步状态使用 `role="status"` 或 `aria-live`，错误使用 `role="alert"`；对话框提供稳定的标题和关闭路径。

加载、连接和目录读取必须保留当前上下文，禁止因状态刷新重排主要动作。异步操作在完成、失败、取消和组件卸载时都要有明确的所有权；禁用按钮要阻止重复提交并保留原因可见性。

动效只服务于层级、反馈和空间连续性，使用主题时长与缓动 token，通常为 150--300ms。遵守 `prefers-reduced-motion: reduce`，减少动态效果时不能丢失状态反馈。

## 响应式行为

桌面面板在视口四周保留至少 24px 安全边距；窄屏改为 `calc(100vw - 24px)`，内容列允许滚动而不溢出。Remote-SSH 在 620px 以下把步骤导航改为横向滚动条，隐藏辅助说明，表单和操作区保持可触达。

固定尺寸的按钮、输入、列表和工具栏使用稳定的高度、最小宽度或网格轨道；长路径、标题和错误文案在父容器内截断或换行，不得遮挡相邻内容。

## 实现前检查

- 先读本文、所属包的 `AGENTS.md`、组件 README，以及 [`docs/web-styling.md`](../../docs/web-styling.md)。
- 确认颜色、阴影、遮罩、字体和主题分支都来自 `--dsw-*` token；组件 CSS 不写主题选择器。
- 确认新增容器确实承担布局或重复条目职责；不要为装饰再嵌套卡片或拟态框。
- 确认键盘焦点、无障碍名称、加载／错误／空状态和 `prefers-reduced-motion` 都有可观察行为。
- 在 375px、768px、1024px 和桌面宽度检查文字、按钮、列表和模态层没有重叠；可见行为变更补充 GUI 测试和必要的 ARIA golden。
