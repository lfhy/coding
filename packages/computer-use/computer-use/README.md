# `@deepseek-ai/dsh-computer-use`

本机 macOS 界面的观察与操作能力：在宿主层提供 `ctx.computerUse`，由包内 macOS 提供方驱动一个固定协议的 Swift helper，供[模型可见的工具消费方](../tool-computer-use/README.md)使用。
能力属于宿主平面：一个进程只有一份提供方，因此 helper 进程、观察缓存、按应用的租约与一次性确认令牌在全部会话之间共享；会话、agent 与 turn 的归属在服务内裁决，helper 自身不做会话隔离。
只有本地 macOS 宿主装载它，其他平台由组合层禁用该行；[基本组合包](../../bundle/base/README.md)默认启用托管 helper 的源码重建，因为本仓库不提交编译产物。

## 服务：`ComputerUseService`（ctx 键：`computerUse`）

- `status()`：当前平台、提供方名、代次、helper 路径与最近一次健康结果，不触发探测。
- `health(signal)`：重新执行不修改权限与界面的健康检查，失败时抛出并把原因记入状态。
- `openPermissionSettings(kind, signal)`：响应用户的显式设置操作打开 macOS 隐私面板；插件不自行授予权限。
- `listApps(context)`：列出有界的运行中用户应用，不读取界面内容，因此不需要读取租约。
- `observe(request, context)`：在读取租约通过后取得新鲜观察，冻结观察 id、有界树文本、元素表、可选截图产物与当时的权限状态。
- `confirm(request, context)`：为精确的高影响动作申请一次性令牌，申请本身不执行任何动作。
- `act(action, context)`：执行绑定既有观察的动作，并始终返回动作之后的新观察；动作按应用串行排队，直到后置观察完成。
- `releaseAgent(agent)`：释放该 agent 的全部观察、租约与确认令牌。

提供方接缝是 [`ComputerUseBackend`](src/backend.ts)：`resolveApp`、`listApps`、`observe`、`act`、`actDragWithCursor`、`activateForCursor`、`visualizeCursor`、`health`、`openSettings`、`dispose`。
`providers/macos.ts` 用 native helper 实现它；`providers/unsupported.ts` 在非 macOS 平台报告不支持。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `observationTtlMs` | `0` | 观察可复用的生命周期；`0` 表示不过期，上限 24 小时 |
| `confirmationTtlMs` | `300000` | 一次性确认令牌的生命周期 |
| `actionTimeoutMs` | `15000` | 单次原生动作的硬超时，1000 至 120000 毫秒 |
| `settleMs` / `maxSettleMs` | `250` / `5000` | 动作后状态检查的间隔与总预算 |
| `maxNodes` / `maxDepth` / `maxTextBytes` | `500` / `14` / `64000` | 可访问性遍历与模型可见文本上限 |
| `maxScreenshotBytes` | `33554432` | PNG 产物字节上限 |
| `artifactRoot` | `.dsh-computer-use/artifacts` | 会话工作区内的截图目录 |
| `provider` | `native` | 后端选择：`native` 用包内 Swift helper，`cua-driver` 用 trycua/cua 的驱动 CLI |
| `cuaDriver.bin` | 省略 | `cua-driver` 可执行文件路径；省略时依次看环境变量 `CUA_DRIVER_BIN` 与官方安装器路径 |
| `cuaDriver.session` | `dsh-computer-use` | 传给驱动的会话名，驱动用它保持同一套虚拟光标会话 |
| `helper.path` | 省略 | 显式外部 helper 可执行文件；省略时使用包内托管 helper |
| `helper.allowSourceBuild` | `false` | 托管 helper 缺失时是否允许按仓库内 Swift 源码重建 |
| `interaction.focusPolicy` | `preserve` | `preserve` 不激活目标应用；`activate` 允许为键盘输入激活 |
| `interaction.keyboardPolicy` | `preserve` | 键盘事件是否在投递前把目标应用带到前台 |
| `interaction.pointerInputPolicy` | `targeted` | 定向指针输入；`deny` 关闭坐标点击、滚动与拖拽回退 |
| `interaction.cursorVisualization` | `visible` | 独立 Agent 光标；`hidden` 只关闭提示，不影响输入 |
| `interaction.cursorSpeedPxPerSecond` / `cursorAccelerationPxPerSecondSquared` / `cursorClickDelayMs` / `cursorAutoHideMs` | `1600` / `6000` / `90` / `0` | Agent 光标的速度、加速度、落点停顿与空闲隐藏 |
| `allowAllApps` | `false` | 向所有运行中的应用授予读取与控制；开启后忽略精确 `grants` |
| `grants[].bundleId` / `read` / `control` | — | 精确、无通配符的按应用授权；`control` 隐含读取 |

配置在设置服务可用时按命名空间 `computer-use` 注册为可实时更新；替换提供方代次会使既有观察与待用确认令牌失效。

## 后端选择

`provider: 'cua-driver'` 把同一组工具接到 [trycua/cua 的 `cua-driver`](https://github.com/trycua/cua)：每次调用都是一次固定 argv 的子进程（`cua-driver call <tool> <json>`），驱动负责可访问性观察、截图与后台投递，本包只做接缝映射与失败收窄。
该后端要求驱动已按官方安装器装好（`cua-driver doctor` 可查权限与守护进程状态），缺失时工具以带安装指引的提供方失败结束，不会退回内置 helper。
驱动上游默认上报匿名遥测，本客户端在每次调用时把 `CUA_DRIVER_RS_TELEMETRY_ENABLED` 设为 `0`，用户在自己的环境里显式设置该变量时以用户为准。
驱动的能力边界就是该后端的能力边界：元素点击、坐标点击、拖拽、滚动、输入、按键、观察与截图可用；设置元素值、执行可访问性动作没有对应驱动调用，会明确拒绝；驱动不画独立 Agent 光标，因此该后端下 `interaction.cursorVisualization` 默认为 `hidden`，显式要求 `visible` 会在配置校验时被拒绝。

## 权限、租约与确认

观察与截图需要读取租约，投递界面输入需要控制租约，两者都按精确 bundle id 区分：静态 `grants` 直接生效，其余走 DSH 审批，读取批准在整个 Session 内有效、控制批准只在当前 turn 内有效，拒绝在该 Session 内保持最终结果。
持久化决定写在本包拥有的 `computer_use_state` 存储域中，并按会话 header 的创建时间与 cwd 绑定生命周期；存储域缺席时只有静态授权可用，需要持久化的交互决定会明确失败而不是静默缩短授权。
高影响动作必须在执行前取得一次性令牌，令牌绑定应用、观察、目标与动作；审批提示被禁用时不提供确认，动作被拒绝而不是绕过。

## 原生 helper 与完整性

helper 是一个只接受固定 argv 与 JSON 行协议的 Swift 可执行文件，源码位于 [`native/macos/`](native/macos)，构建脚本为 [`scripts/build-native.mjs`](scripts/build-native.mjs)。
托管 helper 在使用前必须通过文件类型、可执行位与 `native/macos/manifest.json` 中的 SHA-256 校验；manifest 缺失或不匹配都按失败处理，不会退回未校验的二进制。
`pnpm --filter @deepseek-ai/dsh-computer-use run build:native` 重建 helper 并写入新的 manifest，`run check:native` 复核二进制只做目标进程指针路由、不做系统光标 warp 或全局指针注入。
helper 只被普通进程启动，模型不能提供 shell 片段、脚本、原生 selector 或任意可访问性常量。

## Model Experience

Indirectly, through [`@deepseek-ai/dsh-tool-computer-use`](../tool-computer-use/README.md)：本包不注册工具、不贡献提示词段，因此没有直接的模型可见文本。

### 提供方失败诊断

#### What the model sees

工具层把本包的稳定错误码与原因转发给模型，例如 helper 完整性失败、平台不支持、目标应用身份歧义、观察过期或元素消失。这些诊断只包含动作、目标与失败种类，不含截图内容、其他会话数据或 helper 内部标识。

#### Token effect

仅在调用失败时以单条文本结果出现；成功调用不携带本包的任何文本。

#### KV Cache effect

无直接效果：本包不改动请求内容。

## Known Limitations and Deferred Work

- **只有 macOS 提供方**：Windows 与 Linux 没有实现，非 macOS 宿主上组合层禁用本行，服务本身仍可注入并把状态报告为不支持。
- **编译产物不入库**：仓库不提交 helper 二进制，因此首次使用需要本机具备 `xcrun swiftc`（Xcode 命令行工具）并在数分钟内完成一次构建；缺失工具链时按 helper 不可用失败。
- **源码重建替代了上游的固定二进制校验**：manifest 的哈希在本地构建时写入，信任锚是仓库内容而不是签名的发行产物；需要防篡改发行时需要另行设计签名链路。
- **定向指针依赖平台行为**：目标进程拒绝定向事件时坐标回退失败关闭，不会退化成全局输入。
- **没有暂停与人工接管协议**：多控制器争用的语义只有本进程内的租约，跨设备的接管尚未定义。
- **cua-driver 后端未在真实驱动上复测**：`provider: 'cua-driver'` 的调用形状、参数名与坐标换算是按驱动 CLI 的既有集成实现推导的，本仓库只在可执行替身上验证过程序路径；装好驱动后需要按真实回包复测一次再依赖它。
- **驱动后端缺三类动作**：设置元素值、执行元素声明的可访问性动作、独立 Agent 光标都没有驱动侧支持，只能明确拒绝而不是另找技术路线。
