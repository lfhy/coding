# `@deepseek-ai/dsh-tool-computer-use`

Computer Use 的模型可见消费方：登记一份技能、一个全局引导工具，并在 agent 加载该技能之后，把执行工具只暴露给这个 agent。
本包在 agent 预设层装配，标准预设与 PTC／Code Mode 预设各装配一份，两者提供同一套工具名；提供方、helper 进程与租约属于宿主层的 [`@deepseek-ai/dsh-computer-use`](../computer-use/README.md)。

## 渐进式暴露

- 挂载时全局只注册 `computer_use_activate`，并把 `dsh-computer-use` 技能（兼容别名 `computer-use`）登记进技能目录。
- 技能被加载后，本插件为该 agent 注册执行工具，并用工具遮蔽隐藏引导工具；其他 agent 仍然只看得到引导工具。
- “已加载技能”是一条持久事实，来自会话日志：技能工具写入的 `skill-invocation` 用户消息，或 Code Mode 里 `tool/code-dispatch`（旧名 `tool/code-dispatch`／`tool/ptc-dispatch`）返回同一份技能正文的那次派发。没有这两类证据时，引导工具拒绝执行并提示先加载技能。
- 插件只负责暴露与转发；是否允许某次本机输入由服务层的租约、审批与一次性确认令牌决定。
- 本包只需要 `tools`、`skills`、`agents` 与 `computerUse`；服务缺席时预设挂载会失败，而不是静默给出没有能力的工具。

## 工具

| 工具 | 用途 |
| --- | --- |
| `computer_list_apps` | 列出有界的运行中应用、前台状态与权限诊断 |
| `computer_observe` | 取得新鲜观察（可含截图产物），冻结元素索引与目标句柄 |
| `computer_click` | 优先按可访问性动作点击，可回退到被观察窗口内的坐标 |
| `computer_set_value` | 设置或清空可编辑元素的可访问性值，不使用剪贴板 |
| `computer_type_text` | 支持时经可访问性插入文本，否则回退到定向键盘输入 |
| `computer_press_key` | 按封闭词表发送按键或组合键 |
| `computer_scroll` | 在已解析元素或坐标处滚动 |
| `computer_drag` | 在两个坐标之间拖拽 |
| `computer_perform_action` | 执行元素声明过的可访问性动作 |
| `computer_wait` | 轮询有界的文本、角色或标题条件，不修改界面 |
| `computer_confirm` | 为精确的高影响动作取一次性令牌 |

任何工具都不接受 AppleScript、shell、脚本、原生 selector 或任意可访问性常量。

## 技能

`dsh-computer-use` 技能说明观察协议、可访问性优先的动作顺序、坐标语义、视觉证据的转交方式与敏感动作的确认要求；它按需加载，`LEGACY` 别名 `computer-use` 供既有会话引用。技能本体不授予任何权限。

## Model Experience

### 引导工具与技能目录

#### What the model sees

任何挂载了本插件的 agent 初始都只看到 `computer_use_activate`：它说明必须在加载 `dsh-computer-use` 技能之后调用，并在成功后从该 agent 的工具列表中消失。技能目录里同时可见 `dsh-computer-use`（含描述与适用条件），正文只在加载后进入上下文。

#### Token effect

引导工具的 schema 在技能加载前占用固定请求 token；技能正文只在显式加载时一次性进入上下文，正文长度由 [`skill.ts`](src/skill.ts) 固定。

#### KV Cache effect

同一 agent 的引导工具 schema 保持前缀稳定；加载技能会同时改变系统提示词前缀内的工具列表与追加的用户消息，两者都使后续请求不能复用之前的缓存前缀。

### 执行工具 schema

#### What the model sees

工具说明、参数与结果形状见生成的[工具目录](../../../docs/tool-catalog.md#deepseek-aidsh-tool-computer-use)。模型只能提供结构化动作与观察 id，不能提供脚本、选择器或其它 UI 自动化技术；每次成功动作都返回动作后的新观察，元素消失或观察过期以稳定错误码失败。

#### Token effect

schema 仅在技能加载后对该 agent 可见并占用固定请求 token；每次观察返回有界树文本（默认上限 64000 字节），只有显式请求截图才额外携带一张 PNG 产物。

#### KV Cache effect

同一工具集内 schema 前缀稳定；加载技能、切换 agent 或工具可见性变化都会改变请求前缀，随后的观察与动作结果只追加到会话历史。

## Known Limitations and Deferred Work

- **只有主 agent 应当获得执行工具**：暴露按 agent 生效，但把本插件装配到子 agent 预设同样会生效；当前组合只把它挂在标准与 Code 两个预设上。
- **引导工具依赖会话日志**：技能事实完全来自持久证据，日志被裁剪或改写后需要重新加载技能。
- **没有面向模型的设置入口**：应用级静态授权写在配置里，权限状态与授权界面由宿主层组合决定，本包不贡献设置 UI。
- **不判断动作语义**：是否属于高影响动作由模型依技能要求调用 `computer_confirm` 决定，工具不代替模型分类。
