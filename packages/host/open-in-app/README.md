---
description: "Host 工作区打开路由：在 macOS、Windows、Linux 上提供已验证的本地应用启动器，并经 provider 浏览本地、SSH Host 与 Remote-SSH 工作区文件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-open-in-app

## 概述

本包决定人类如何打开一个工作区。普通本地工作区可以在已验证的编辑器、Git GUI、终端或文件管理器中启动。Remote-SSH marker、损坏的 marker 或经 SSH 启动的 Host 都会 fail-closed 到 Client utility 自持的内置文件管理面板，绝不交给本地应用。同一文件列表路由经 `ctx.fs` 处理本地与远端根；Remote-SSH 文件系统 provider 会把调用转发给通过认证的桌面 Go agent。

## 目录

- [使用本包](#use-this-package)
- [路由与安全](#routes-and-security)
- [应用解析](#application-resolution)
- [工作区文件](#workspace-file-management)
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

<a id="routes-and-security"></a>
## 路由与安全

每条路由都会先执行 composition connection 服务的 Host/Origin 栅栏与浏览器认证。POST 路由要求精确的 `application/json` essence，把 body 限制在 64 KiB，拒绝多余或畸形字段，且不会返回继承凭据或 provider target key。

| 路由 | 契约 |
|---|---|
| `GET /open-in-app/apps` | 按菜单顺序返回已安装 catalog id。 |
| `POST /open-in-app/target` | 把绝对 `cwd` 分类为 `local` 或 `files`；本地响应包含已安装 id。 |
| `GET /open-in-app/icon/<id>` | 返回缓存的 PNG/SVG 应用图标，或 404。 |
| `POST /open-in-app/open` | 启动已验证的本地应用；目标已变成远端时返回 `action: files`。 |
| `POST /open-in-app/files` | 在工作区根内经 provider 列出一层目录。 |

target 与 open 路由会在读取应用可用性前检查 Remote-SSH marker。有效 marker、无效 marker 或继承的 SSH 启动都不能进入本地启动分支。该顺序保证 Windows marker 目录不会交给 Explorer，POSIX marker 也不会交给 Finder。

<a id="application-resolution"></a>
## 应用解析

编译期 catalog 覆盖文件管理器、编辑器与 IDE、Git GUI 和终端。一趟惰性解析把每个条目落实为 Host 实际持有的构件：

- **macOS：**检查已知 `.app` 位置并跟随 `xcode-select -p`；以 argv 启动，绝不使用 Shell 字符串。
- **Windows：**批量读取 `App Paths` 与 Uninstall 注册表、验证已知安装路径和版本化 JetBrains 目录，并处理 GitHub Desktop 自带 CLI。PATH/PATHEXT 名称经 `ctx.subprocess.resolveExecutable` 解析。Explorer 使用共享原生路径打开器，因为直接 `explorer.exe <dir>` 不能可靠地抬起窗口。
- **Linux：**使用 PATH 解析和已验证的 XDG desktop 条目；纯 GUI 条目要求显示服务器。

应用 argv 进程使用清理过凭据的 subprocess 环境并 detached 启动。Windows GUI 默认保持可见，只有显式适配器隐藏 CLI helper。可执行文件缺失时只刷新该 catalog 条目并重试一次。macOS bundle、Windows 可执行文件与 Linux desktop 图标按需提取并缓存。

<a id="workspace-file-management"></a>
## 工作区文件

文件路由先经 `ctx.fs` 解析一次根，然后逐段列出当前 provider target，并按 provider 返回的子项名称精确选择。它绝不把浏览器字符串拼成 OS 路径。这样既能保持 symlink containment，也支持所有 Host／远端平台组合，包括 Windows 到 POSIX、POSIX 到 Windows 的 Remote-SSH。

只有目录 target 可以推进名称链。响应包含展示路径与普通 entry 元数据，不包含 `FsTargetKey`、marker 身份、bridge URL 或 token。单层最多 2,000 项，超出时返回 `truncated: true`。

## 进一步探索

- [Client 包](../../client/ui-open-in-app/README.md)——页头分流与 utility 自持的文件管理面板。
- [文件系统子系统](../../../docs/subsystems/filesystem.md)——provider target 身份与 Remote-SSH 路由。
- [原生命令工具](../../util/native-command/README.md)——免 Shell 命令与平台路径打开。
- [功能决策](../../../.agents/notes/implemented/feature/2026-08-25-promote-open-anywhere-plugin.md)——包归属与替代方案。

<a id="model-experience"></a>
## 模型体验

无，因为这些经认证的人类界面路由不会改变提示词、工具、Session 事件或模型结果。

#### KV 缓存影响

无；本包从不组装或发送 provider 请求。

## 已知限制与延后工作

- **应用 catalog 在构建期固定。** 自定义 handler 需要独立的设置与命令校验契约。
- **macOS 发现只检查已知应用根。** 改名或移出这些根的 bundle 不会被找到。
- **图标保真度取决于平台标准 API。** Windows 提取为 32 px；Linux 跟随 hicolor/pixmaps 而非当前主题。
- **文件路由只读且不分页。** 最多列出 2,000 个直接子项；文件读取与 mutation 不属于本包。

**运行时 invariant：** companion 只保留包归属，不增加关系。真实 Loader/WebServer 测试覆盖五条认证路由及其释放；resolver 测试固定 Windows、macOS、Linux 的发现与启动行为。
