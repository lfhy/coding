# Agent Note: 将工作区打开能力转正为本地与 Remote-SSH 第一方功能

Status: implemented

## 问题

Web 客户端的工作区打开能力最初来自外部 `@dsh-plugins/open-anywhere` 插件：一份无类型 JavaScript，自行探测应用、派生命令、绘制菜单并猜测产品版本兼容性。第一方客户端需要类型化 wire 校验、经认证的 Host 归属、生命周期安全的 UI 组合、各平台可验证的启动器证据和确定性测试。

单纯的“在本地打开”对 Remote-SSH 工作区也是错误表述。它的 `cwd` 是本地 marker，而文件与进程位于桌面 Go agent 之后。把该 marker 交给 Finder、Explorer 或远端 GUI，要么只会打开 marker 目录，要么会在错误机器上启动应用。Host 自身经 SSH 启动且没有有人值守的桌面时，fallback 也必须保持可用。

## 决策

工作区打开是一个由两个第一方包组成的功能：

- [`dsh-host-open-in-app`](../../../../packages/host/open-in-app/README.md)拥有应用发现、图标、目标分类、启动、live Session 文件协议和 Agent execution world 用户终端。
- [`dsh-client-ui-open-in-app`](../../../../packages/client/ui-open-in-app/README.md)拥有会话页头入口、持久化打开方式选择、文件标签／预览／文件树和 xterm 底栏。

Web bundle 同时挂载两包。路由常量与 JSON 载荷类型唯一的浏览器安全归属是 `@deepseek-ai/dsh-host-open-in-app/shared`；动态 Client bundle 只可内联这一子路径。

### Host 权威的目标分流

`POST /open-in-app/target` 对每个绝对 `cwd` 分类。普通现存目录为 `local`。有效 Remote-SSH marker、无效 marker，或继承进程层携带非空 `SSH_CONNECTION`／`SSH_TTY` 的 Host 都为 `files`。共享的 [`launchedThroughSsh()`](../../../../packages/util/launch-environment/README.md) 会忽略项目与用户 `.env` 层。

open 路由会在启动前立刻重复分类。Client 探测后才变成 marker 的路径返回 `action: files`，绝不进入应用适配器。marker 失败必须 fail-closed；把不可读 marker 当作本地目录会向 Finder 或 Explorer 暴露它的实现目录。

### 固定的跨平台工作台

Client 在会话页头右侧注册紧凑入口，位置紧邻 Session log。本地工作区显示主按钮与下拉菜单组成的分体按钮：主按钮默认打开内置文件工作台，菜单先列出内置页面，再列出已验证应用；Remote-SSH 或 SSH Host 目标只显示工作台按钮。两种入口都打开由 `ui-layout` 持有固定几何的 Session 工作台。本功能不注册 `conversation.view`，也不使用文件 conversation tab、临时浮层或模态框。

打开方式选择持久化在 `dsh.open-in-app.choice`，字段同时承载应用 id 与内置页面 id。应用启动因此是用户在下拉菜单中的显式选择，而不需要在本机应用与内置页面之间添加配置项；记录的应用从 catalog 消失时，主按钮回到内置文件工作台。

宽屏主内容保留左侧对话，工作台中间是可关闭、可激活的文件标签及 Markdown、代码、普通文本和图片预览，右侧是可筛选、按展开懒加载的文件树，底部是真实 xterm。工作台右上角提供最大化、终端底栏和文件侧栏按钮；关闭工作台、最大化和底栏由 layout owner 回调控制，文件侧栏保持功能内部 viewing state。768px 参考视口隐藏文件大小并把文件树固定为 260px；375px 手机视口把文件树覆盖到预览区，关闭侧栏后回到标签与预览。

文件请求以当前 live Session 的 id 绑定根目录，只把 provider 返回的 segment 链传回 Host。Host 从 `Session.header.cwd` 经 `ctx.fs` 解析根，每个 segment 都必须精确匹配上一层 provider 条目，并在进入或读取前再次检查 containment；浏览器不提交根目录，也不构造 Windows、POSIX 或 UNC 路径。Provider target key、marker 身份、bridge 地址与凭据不会跨 wire。每层最多列出 2,000 个直接子项；预览在配置上限内完整返回，严格 UTF-8 文本按 Markdown／代码／普通文本分类，支持的图片返回校验后 MIME 与 base64，其余内容返回不携带原始字节的 unsupported。

终端底栏使用 `@xterm/xterm` 与 fit addon，首次显示后在视觉收起和工作台关闭期间保持连接。Host 的 loopback trust 栅栏先拒绝不可信 upgrade，再要求 Session 与 live Agent 对应，并从 `agent.ctx` 取得 `subprocess` provider；终端因此运行在 Agent execution world，而不是无条件使用 Host provider。xterm 尺寸通过封闭 resize 帧进入 `SubprocessTerminalHandle.resize()`，覆盖本地 POSIX、本地 Windows、Remote-SSH Unix PTY 与 Remote-SSH Windows ConPTY。组件或连接真正结束时，Host 终止该 WebSocket 独占的 PTY 并等待清理。

### 已验证的本地应用

一趟惰性解析产出 catalog id 到已验证启动器的映射。用户在菜单中选中应用后，该 id 直接使用这份映射；spawn `ENOENT` 只刷新失效条目并重试一次。编译期 catalog 是维护过的白名单，因为操作系统注册信息无法证明任意应用能接收工作区目录，也无法给出它所需的 argv 协议。

- macOS 检查已知 `.app` 根并跟随 `xcode-select -p`。
- Windows 批量读取 `App Paths` 与 Uninstall 注册表，验证已知路径与版本化 JetBrains 目录，处理 GitHub Desktop 自带 CLI，并经 `ctx.subprocess.resolveExecutable()` 解析 PATH/PATHEXT。
- Linux 解析 PATH 条目与已验证的 XDG desktop 条目；纯 GUI 启动器要求显示服务器。

应用 argv 进程以 `scrubbedParentEnv()` detached 启动；Windows GUI 保持可见，除非适配器显式隐藏 CLI helper。文件管理器使用共享 [`dsh-native-command`](../../../../packages/util/native-command/README.md) 路径打开器，因为直接 `explorer.exe <directory>` 不能可靠抬起窗口。该工具统一拥有 macOS、Windows、Linux 与 WSL 的路径交接，功能包不复制实现。

独立的 `probeTimeoutMs`、`iconTimeoutMs` 与 `launchWatchMs` 上限避免发现、图标提取与早期启动失败互相改变时序。图标来自 macOS bundle、Windows 可执行文件或 Linux desktop 条目；失败时 Client 保留通用图形。

### 路由安全与 UI 生命周期

每条 HTTP 路由和 WebSocket upgrade 都先调用 composition connection 服务的 `requestRejection()`。该接口固定执行 loopback Host 与浏览器同源检查，不因部署的 `trustedHosts` 放宽；这是 DNS rebinding／跨站可达性边界，不是假称存在用户认证。POST body 要求精确 JSON 媒体类型、64 KiB 上限、封闭字段集和运行时校验。文件协议只暴露展示路径、普通元数据和封闭预览内容。

Client 使用标准 slot 系统、locale 服务、CSS Modules、设计 token 与 snapshot store。目标请求按 `cwd` 合并并缓存到页面结束；打开方式选择（应用 id 或内置页面 id）持久化在 `dsh.open-in-app.choice`。文件标签归 Session scope store，树展开、筛选与侧栏可见性归组件本地状态。布局把工作台、底栏和对话保留在固定 React 树位置，因此视觉隐藏不等于终端卸载；插件 fiber 或 Session scope 释放才撤销 entry 和连接。

## 曾考虑的替代方案

**经本地或远端 OS 应用 catalog 启动 Remote-SSH 工作区。** 拒绝，因为 marker 路径与远端路径属于不同执行世界。本地启动只会打开实现数据；远端 GUI 可能不存在，且会绕过桌面交互边界。

**在浏览器中构造远端路径。** 拒绝，因为 Host 与远端可能使用不同路径语法，浏览器拼接也无法保持 provider target 身份或 symlink containment。按 provider 返回名称遍历会把这些决策保留在 `ctx.fs`。

**把文件管理做成 conversation 页面或独立右侧 Sidebar。** 不采用。页面方案会把工作区工具混入会话导航，独立 Sidebar 又会复制布局和持久化契约。固定工作台 slot 让 layout 只拥有组合几何和显隐，功能包拥有文件与终端业务状态。

**所有操作都使用 Typert Remote。** 拒绝，因为应用图标是二进制响应，而目标、启动和列表载荷是 JSON。让一个经认证的原始路由 owner 承担完整功能可避免双传输，同时仍在每个 JSON 边界校验。

**扩展 `host.openPath`。** 拒绝，因为该操作只为一个路径选择 OS 默认应用。本功能拥有应用选择、可用性、图标身份、失效启动器恢复与内置文件 fallback。

**为默认打开方式新增设置项。** 拒绝，因为菜单本身就是一次性显式选择：常看内置页面时不需要配置，偶尔启动外部应用时展开菜单即可。为单个页头按钮引入设置命名空间、迁移与设置面板文案，会把一次局部选择变成需要长期维护的用户可配置面。

**主按钮永远是内置文件工作台，不记忆应用。** 拒绝，因为它回退既有的一次点击路径：以外部应用为主的工作流每次都要展开菜单，而现有的记忆字段已经能表达这个选择。

**枚举或配置任意已安装应用。** 不作为默认权威。OS catalog 无法证明工作区打开语义，任意命令还需要设置归属和命令校验。维护过的 preset 保持显式；custom handler 暂缓。

## 后果

无论 Host 是否解析出可命名应用，本地工作区都在 macOS、Windows、Linux 上得到页头分体按钮：主按钮打开内置文件工作台，菜单列出当前可用的已验证应用。Remote-SSH 与 SSH Host 工作区得到紧邻 Session log 的固定工作台入口，而不是缺失或不安全的本地操作。文件协议使用 Session 的 `ctx.fs` 世界，终端使用 live Agent 的 subprocess 世界，因此桌面 Remote-SSH 会抵达 Go agent，Windows 与 POSIX 终端也共用一份浏览器协议，无需移动 Host 控制平面。

接受的成本是文件工作台只读、每目录 2,000 项上限、预览采用完整有界读取、终端以 WebSocket 连接为生命周期、页面生命周期目标缓存，以及编译期应用 catalog。Resolver 与图标覆盖固定三个本地平台；Host 契约固定 loopback trust、live Session／Agent 绑定、provider containment、预览分类、封闭帧、各执行世界 resize 与 PTY 清理；Client 契约固定目标切换、文件标签／树／预览、xterm 保留式显隐和 375px／768px 响应式语义。
