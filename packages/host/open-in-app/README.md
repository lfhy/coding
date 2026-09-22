---
description: "Host 工作区协议：提供跨平台本地应用启动、Session 绑定文件预览，以及本地和 Remote-SSH 用户终端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-open-in-app

## 概述

本包决定人类如何打开和浏览一个工作区。普通本地工作区可以在已验证的编辑器、Git GUI、终端或文件管理器中启动。Remote-SSH marker、损坏的 marker 或经 SSH 启动的 Host 都会 fail-closed 到固定工作台，绝不交给本地应用。文件列表和预览绑定 live Session，并经 `ctx.fs` 进入其文件执行世界；用户终端绑定同一 Session 的 live Agent，从 `agent.ctx` 取得 `subprocess` provider，因此本地 POSIX、本地 Windows 与 Remote-SSH 都在 Agent execution world 内运行。

## 目录

- [使用本包](#use-this-package)
- [路由与安全](#routes-and-security)
- [应用解析](#application-resolution)
- [工作区文件](#workspace-files)
- [用户终端](#browser-terminal)
- [模型体验](#model-experience)
- [已知限制与延后工作](#已知限制与延后工作)

-----

<a id="use-this-package"></a>
## 使用本包

把本包挂进携带 `webServer`、`connection`、`subprocess` 与 `fs` 的组合，通常与 [`dsh-client-ui-open-in-app`](../../client/ui-open-in-app/README.md) 并排。

```yaml
- name: '@deepseek-ai/dsh-host-open-in-app'
  config:
    probeTimeoutMs: 10000
    iconTimeoutMs: 10000
    launchWatchMs: 1000
```

| 字段 | 含义 |
|---|---|
| `probeTimeoutMs` | 应用发现命令的逐命令期限，包括 Windows 注册表读取。 |
| `iconTimeoutMs` | macOS 与 Windows 图标提取命令的逐命令期限。 |
| `launchWatchMs` | 早期失败窗口；关闭时仍存活的启动器视为已启动，且不会被终止。 |
| `previewMaxBytes` | 单个预览允许读取的完整文件字节数；默认 2 MiB，最大 32 MiB。 |

<a id="routes-and-security"></a>
## 路由与安全

每条 HTTP 路由和 WebSocket upgrade 都先调用 composition connection 服务的 `requestRejection()`。该接口只接受 loopback Host，并在浏览器提供来源标记时要求同源；`trustedHosts` 不会扩大这组宿主原生能力，拒绝发生在读取载荷、查找 Session 或分配 PTY 之前。它是 DNS rebinding／跨站可达性栅栏，不是用户认证。POST 路由还要求精确的 `application/json` essence，把 body 限制在 64 KiB，拒绝多余或畸形字段，且不会返回继承凭据或 provider target key。

| 路由 | 契约 |
|---|---|
| `GET /open-in-app/apps` | 按菜单顺序返回已安装 catalog id。 |
| `POST /open-in-app/target` | 把绝对 `cwd` 分类为 `local` 或 `files`；本地响应包含已安装 id。 |
| `GET /open-in-app/icon/<id>` | 返回缓存的 PNG/SVG 应用图标，或 404。 |
| `POST /open-in-app/open` | 启动已验证的本地应用；目标已变成远端时返回 `action: files`。 |
| `POST /open-in-app/files` | 用 `{ sessionId, segments }` 在 Session 工作区内列出一层目录。 |
| `POST /open-in-app/read` | 用 `{ sessionId, segments }` 返回有界文本、图片或 unsupported 预览。 |
| `WS /open-in-app/terminal` | 用唯一的 `sessionId`、`cols`、`rows` query 启动连接独占用户终端。 |

target 与 open 路由会在读取应用可用性前检查 Remote-SSH marker。有效 marker、无效 marker 或继承的 SSH 启动都不能进入本地启动分支。该顺序保证 Windows marker 目录不会交给 Explorer，POSIX marker 也不会交给 Finder。

<a id="application-resolution"></a>
## 应用解析

编译期 catalog 覆盖文件管理器、编辑器与 IDE、Git GUI 和终端。一趟惰性解析把每个条目落实为 Host 实际持有的构件：

- **macOS：**检查已知 `.app` 位置并跟随 `xcode-select -p`；以 argv 启动，绝不使用 Shell 字符串。
- **Windows：**批量读取 `App Paths` 与 Uninstall 注册表、验证已知安装路径和版本化 JetBrains 目录，并处理 GitHub Desktop 自带 CLI。PATH/PATHEXT 名称经 `ctx.subprocess.resolveExecutable` 解析。Explorer 使用共享原生路径打开器，因为直接 `explorer.exe <dir>` 不能可靠地抬起窗口。
- **Linux：**使用 PATH 解析和已验证的 XDG desktop 条目；纯 GUI 条目要求显示服务器。

应用 argv 进程使用清理过凭据的 subprocess 环境并 detached 启动。Windows GUI 默认保持可见，只有显式适配器隐藏 CLI helper。可执行文件缺失时只刷新该 catalog 条目并重试一次。macOS bundle、Windows 可执行文件与 Linux desktop 图标按需提取并缓存。

<a id="workspace-files"></a>
## 工作区文件

文件路由先用 `sessionId` 查找当前 live Session，再只从其 `header.cwd` 解析根；客户端除了 Session id 只能提交 provider 返回的 `segments`，不能提供根目录或展示路径。每个路径段只能精确匹配 `ctx.fs.listDir` 返回的子项，并在进入下一层或读取文件前用 `ctx.fs.contains` 复核 containment；浏览器字符串从不拼成 OS 路径。因此同一协议覆盖本地、SSH Host、Remote-SSH marker、Windows 盘符与 UNC 展示路径。

只有目录 target 可以推进名称链，预览的最后一段必须仍是普通文件。列表响应包含 `displayPath`、普通 entry 元数据和 `truncated`，单层最多 2,000 项。预览在 `previewMaxBytes` 内完整读取：Markdown、代码和其他严格 UTF-8 文本返回 `kind: text`；支持的图片返回 `kind: image`、MIME 与 base64；含 NUL、无效 UTF-8 或超限文件返回 `kind: unsupported`，不返回原始内容。超限响应以 `truncated: true` 明确区分。

<a id="browser-terminal"></a>
## 用户终端

终端 upgrade 只接受一次 `sessionId`、`cols` 和 `rows`，并要求该身份同时拥有相互对应的 live Session 与 live Agent。进程从 `agent.ctx.get('subprocess')` 取得执行 provider，在 `Session.header.cwd` 所在执行世界中启动，不回退到无法证明同一执行世界的 Host provider。Shell 按 `zsh`、`bash`、`fish`、`pwsh`、`powershell`、`cmd` 顺序探测；POSIX Shell 使用 `-i`，PowerShell 使用 `-NoLogo`，`cmd` 不附加 POSIX 参数。

server-to-client 帧封闭为 `ready`、`output`、`exit`、`error`，client-to-server 帧封闭为 `input`、`resize`、`close`。输入、消息和终端尺寸都有固定上限；二进制、额外字段和越界值会关闭连接。合法 resize 会调用统一的 `SubprocessTerminalHandle.resize()`：本地 `node-pty` 覆盖 POSIX 与 Windows，本地 Remote-SSH provider 把请求交给 Go agent 的 Unix PTY 或 Windows ConPTY，其他 provider 由 seam 的同一方法承担。每条 WebSocket 独占一个 PTY，显式 `close`、网络断开、Session 工作台 slot 卸载或插件释放都会调用 `terminate()` 并等待完整会话清理；仅把已挂载底栏视觉收起不会关闭 socket。

## 进一步探索

- [Client 包](../../client/ui-open-in-app/README.md)——页头分流、固定文件工作台与 xterm 底栏。
- [文件系统子系统](../../../docs/subsystems/filesystem.md)——provider target 身份与 Remote-SSH 路由。
- [原生命令工具](../../util/native-command/README.md)——免 Shell 命令与平台路径打开。
- 功能决策——包归属与替代方案。

<a id="model-experience"></a>
## 模型体验

无，因为这些经认证的人类界面路由不会改变提示词、工具、Session 事件或模型结果。

#### KV 缓存影响

无；本包从不组装或发送 provider 请求。

## 已知限制与延后工作

- **应用 catalog 在构建期固定。** 自定义 handler 需要独立的设置与命令校验契约。
- **macOS 发现只检查已知应用根。** 改名或移出这些根的 bundle 不会被找到。
- **图标保真度取决于平台标准 API。** Windows 提取为 32 px；Linux 跟随 hicolor/pixmaps 而非当前主题。
- **文件协议只读且不分页。** 最多列出 2,000 个直接子项；超限预览不提供局部内容，文件 mutation 不属于本包。
- **终端不跨连接保留。** 收起底栏或视觉关闭工作台会保留当前连接，但 Session scope 卸载、浏览器网络断开或插件释放会终止进程；跨连接恢复、共享和后台保留需要独立的 Session 终端控制器。

**运行时 invariant：** companion 只保留包归属，不增加关系。真实 Loader/WebServer 测试覆盖认证路由、upgrade 注册及释放；聚焦测试固定 Session containment、预览上限、封闭帧、Shell 参数和 PTY 清理。
