# Agent Note：Coding Go 客户端共享一个 Node Host

Status: proposed

[English](2026-08-20-coding-go-clients-shared-node-host.md) | 中文

## Problem

Coding 需要 macOS 与 Windows 原生 GUI，以及 Linux 交互式终端 UI；而现有 Node/Cordis Host 已经拥有会话、Agent、工具、凭据、设置、插件和浏览器 RPC 协议。若在 Go 中重写这些服务，会形成两个不兼容的持久化与协议所有者。

## Proposal

Coding 保留 TypeScript/Cordis Node 进程作为唯一业务 Host。Go 应用只拥有原生启动与呈现：`apps/desktop` 用 `webview_go` 承载现有 Web GUI，`apps/tui` 消费现有 `/api` unary HTTP 及 `events.mux`、`events.host` 下行流。两个应用共享 `$DSH_HOME`，并通过 `host.json` 连接一个兼容的本地 Host。

由 Go 管理的 Host 启动会绑定 OS 分配的回环端口，并在完整 Web 树结算后输出结构化 JSON 就绪信息。Host 记录包含端口、PID、运行时版本和协议版本。启动器会先验证连通性和兼容性再连接；只有记录的所有者已经退出时，才会替换陈旧或不兼容的记录。Host 只删除自己拥有的记录，并会在没有客户端且没有活跃 Agent/后台工作五分钟后退出。

发布启动器内嵌 Node SEA 引导资产。它会先将经过校验的生产闭包和所需原生侧车物化到 `$DSH_HOME/runtime/<version>`，再启动 Host。成功启动后删除旧运行时目录，启动失败则保留它们。这让最终用户无需预装 Node，同时不承诺把必须依赖文件的原生侧车塞进纯单文件中。

Coding 的产品名和公开 Linux 命令不会重命名内部 `@deepseek-ai/dsh` 包、插件、协议或数据目录标识。现有语义仍是兼容性边界，面向产品的产物使用 Coding。跨会话交付记录 [TODO.md](../../../TODO.md) 负责分阶段实施状态和详细验收工作。

## Alternatives considered

**将 Host 移植到 Go**：拒绝，因为这会重复实现 Agent、持久化、插件和 RPC，并要求长期维护跨语言功能对等。

**使用 Wails 或桌面 HTTP 代理**：拒绝，因为 `webview_go` 可以直接导航到回环 Host，在不增加同源层的前提下保留现有 Web 传输和回环信任策略。

**要求用户安装 Node**：拒绝，因为 SEA 引导器可以打包 Host 闭包，同时在 Node 模块需要文件时保留物化的原生依赖。

**恢复已删除的 Node TUI**：拒绝，因为旧包已由[移除 TUI 包的决策](../../implemented/simplification/2026-08-04-remove-tui-package.md)作为未发布前端刻意删除。新的 Go TUI 是消费既有 HTTP/WebSocket 协议的独立产品客户端，不会恢复旧前端依赖图。

## Acceptance criteria

- Host 可以发布并清理带版本的本地发现记录，Go 客户端仅在 PID、协议、版本和回环 RPC 检查成功后连接。
- `apps/desktop` 在 macOS arm64 或 Windows amd64 原生 WebView 中打开现有 Web 应用，不引入第二条 HTTP 传输。
- `apps/tui` 是 Linux amd64 的 Bubble Tea 应用，校验既有 RPC 信封，并按 generation 重连两条下行流。
- 发布产物将已校验 SHA-256 的 Host 运行时物化到 `$DSH_HOME/runtime/<version>`，不需要全局安装 Node 可执行文件。
- 第一方工作流仍由 Node Host 拥有；仅浏览器可用的第三方客户端视图在 TUI 中显示为不可执行占位。

## Risks

- Host 发现属于跨进程所有权协议。需要启动器锁和记录 token 清理，避免并发启动器为同一 `$DSH_HOME` 创建竞争写入者。
- Node SEA 将 JavaScript 打包到一个可执行文件中，但原生模块仍需要文件。运行时组装必须保留平台侧车并验证每个目标平台，不能声称存在纯通用单文件。
- Go TUI 没有自动生成的 TypeScript 契约绑定。它必须防御性解码稳定 wire 信封，并在 fixture 支撑的兼容性套件覆盖完整第一方 API 前明确支持范围。

Host 测试覆盖就绪记录、陈旧记录接管、运行时版本兼容性和空闲退出。SEA 测试覆盖冷物化、损坏恢复以及仅在就绪后执行清理。桌面端与 TUI 测试覆盖连接已有 Host、重连行为和各自呈现的第一方客户端工作流。
