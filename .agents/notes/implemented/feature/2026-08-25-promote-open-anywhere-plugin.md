# Agent Note: 将工作区打开能力转正为本地与 Remote-SSH 第一方功能

Status: implemented

## 问题

Web 客户端的工作区打开能力最初来自外部 `@dsh-plugins/open-anywhere` 插件：一份无类型 JavaScript，自行探测应用、派生命令、绘制菜单并猜测产品版本兼容性。第一方客户端需要类型化 wire 校验、经认证的 Host 归属、生命周期安全的 UI 组合、各平台可验证的启动器证据和确定性测试。

单纯的“在本地打开”对 Remote-SSH 工作区也是错误表述。它的 `cwd` 是本地 marker，而文件与进程位于桌面 Go agent 之后。把该 marker 交给 Finder、Explorer 或远端 GUI，要么只会打开 marker 目录，要么会在错误机器上启动应用。Host 自身经 SSH 启动且没有有人值守的桌面时，fallback 也必须保持可用。

## 决策

工作区打开是一个由两个第一方包组成的功能：

- [`dsh-host-open-in-app`](../../../../packages/host/open-in-app/README.md)拥有应用发现、图标、目标分类、启动和 provider 文件列表路由。
- [`dsh-client-ui-open-in-app`](../../../../packages/client/ui-open-in-app/README.md)拥有会话页头入口、持久化应用选择和 utility 自持的内置文件管理面板。

Web bundle 同时挂载两包。路由常量与 JSON 载荷类型唯一的浏览器安全归属是 `@deepseek-ai/dsh-host-open-in-app/shared`；动态 Client bundle 只可内联这一子路径。

### Host 权威的目标分流

`POST /open-in-app/target` 对每个绝对 `cwd` 分类。普通现存目录为 `local`。有效 Remote-SSH marker、无效 marker，或继承进程层携带非空 `SSH_CONNECTION`／`SSH_TTY` 的 Host 都为 `files`。共享的 [`launchedThroughSsh()`](../../../../packages/util/launch-environment/README.md) 会忽略项目与用户 `.env` 层。

open 路由会在启动前立刻重复分类。Client 探测后才变成 marker 的路径返回 `action: files`，绝不进入应用适配器。marker 失败必须 fail-closed；把不可读 marker 当作本地目录会向 Finder 或 Explorer 暴露它的实现目录。

### 一个跨平台文件管理面板

Client 在会话页头右侧注册紧凑的工作区入口，位置紧邻 Session log。Remote-SSH 目标点击后直接打开该 utility 自己拥有和渲染的文件管理面板；面板状态与目录导航不扩展到会话页面 owner，也不成为全局导航目标。浏览器与桌面界面共用这一响应式实现。

文件路由经 `ctx.fs` 解析工作区根，不拼接浏览器路径字符串。每个请求 segment 都通过列出当前 provider target、精确选取 provider 返回的同名目录、检查 containment，再从该子 target 继续。浏览器保存的是名称链而非 Windows／POSIX 语法。因此 Windows 桌面可浏览 POSIX 远端，POSIX 桌面也可通过同一契约浏览 Windows 远端。Provider target key、marker 身份、bridge 地址与凭据都不会跨 wire。

文件管理面板只读，每层最多列出 2,000 个直接子项。面包屑导航、刷新、加载、失败、键盘焦点、长名称截断与窄屏布局属于已交付 UI 契约。文件预览和 mutation 需要独立的归属与授权决策。

### 已验证的本地应用

一趟惰性解析产出 catalog id 到已验证启动器的映射。点击直接使用该映射；spawn `ENOENT` 只刷新失效条目并重试一次。编译期 catalog 是维护过的白名单，因为操作系统注册信息无法证明任意应用能接收工作区目录，也无法给出它所需的 argv 协议。

- macOS 检查已知 `.app` 根并跟随 `xcode-select -p`。
- Windows 批量读取 `App Paths` 与 Uninstall 注册表，验证已知路径与版本化 JetBrains 目录，处理 GitHub Desktop 自带 CLI，并经 `ctx.subprocess.resolveExecutable()` 解析 PATH/PATHEXT。
- Linux 解析 PATH 条目与已验证的 XDG desktop 条目；纯 GUI 启动器要求显示服务器。

应用 argv 进程以 `scrubbedParentEnv()` detached 启动；Windows GUI 保持可见，除非适配器显式隐藏 CLI helper。文件管理器使用共享 [`dsh-native-command`](../../../../packages/util/native-command/README.md) 路径打开器，因为直接 `explorer.exe <directory>` 不能可靠抬起窗口。该工具统一拥有 macOS、Windows、Linux 与 WSL 的路径交接，功能包不复制实现。

独立的 `probeTimeoutMs`、`iconTimeoutMs` 与 `launchWatchMs` 上限避免发现、图标提取与早期启动失败互相改变时序。图标来自 macOS bundle、Windows 可执行文件或 Linux desktop 条目；失败时 Client 保留通用图形。

### 路由安全与 UI 生命周期

每条路由都会先执行 composition connection 服务的 Host/Origin 栅栏与浏览器认证。POST body 要求精确 JSON 媒体类型、64 KiB 上限、封闭字段集和运行时校验。文件路由只暴露展示路径与直接子项元数据。

Client 使用标准 slot 系统、locale 服务、CSS Modules、设计 token 与 snapshot store。目标请求按 `cwd` 合并并缓存到页面结束；本地应用选择持久化在 `dsh.open-in-app.choice`。页头 entry 及其自持面板都会随插件 fiber 消失。

## 曾考虑的替代方案

**经本地或远端 OS 应用 catalog 启动 Remote-SSH 工作区。** 拒绝，因为 marker 路径与远端路径属于不同执行世界。本地启动只会打开实现数据；远端 GUI 可能不存在，且会绕过桌面交互边界。

**在浏览器中构造远端路径。** 拒绝，因为 Host 与远端可能使用不同路径语法，浏览器拼接也无法保持 provider target 身份或 symlink containment。按 provider 返回名称遍历会把这些决策保留在 `ctx.fs`。

**把文件管理做成常驻会话页面或独立右侧 Sidebar。** 不采用。该能力只在用户从页头打开远端工作区时需要；把它提升为全局页面或 pane 会引入无关的导航、持久化和 owner 契约。由入口 utility 自持临时面板能把状态与生命周期限制在功能内部。

**所有操作都使用 Typert Remote。** 拒绝，因为应用图标是二进制响应，而目标、启动和列表载荷是 JSON。让一个经认证的原始路由 owner 承担完整功能可避免双传输，同时仍在每个 JSON 边界校验。

**扩展 `host.openPath`。** 拒绝，因为该操作只为一个路径选择 OS 默认应用。本功能拥有应用选择、可用性、图标身份、失效启动器恢复与内置文件 fallback。

**枚举或配置任意已安装应用。** 不作为默认权威。OS catalog 无法证明工作区打开语义，任意命令还需要设置归属和命令校验。维护过的 preset 保持显式；custom handler 暂缓。

## 后果

只要至少一个可命名应用解析成功，本地工作区就在 macOS、Windows、Linux 上得到与主线一致的页头控件。Remote-SSH 与 SSH Host 工作区得到紧邻 Session log 的内置文件入口，而不是缺失或不安全的本地操作。文件管理面板使用与模型工具相同的 `ctx.fs` 执行世界，因此桌面 Remote-SSH 会抵达 Go agent，无需移动 Host 控制平面。

接受的成本是文件管理面板第一版只读、每目录 2,000 项上限、页面生命周期目标缓存，以及编译期应用 catalog。Resolver 与图标测试固定三个本地平台；路由测试固定认证、Remote-SSH fail-closed 分流、provider containment、启动刷新与 HMR 释放；Client 测试固定目标切换、面板导航、响应式语义与 wire 校验。
