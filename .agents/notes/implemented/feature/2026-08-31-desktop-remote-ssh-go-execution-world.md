# Agent Note: 桌面 Remote-SSH 使用 Go 执行世界 agent

Status: implemented

## 问题

远程 Workspace 必须保留本地 Coding Host 对 Session、持久日志、凭据、审批、设置、模型传输和 UI 的所有权，同时让文件系统路径、进程、终端、语言服务器、搜索和 Code Mode 针对所选远程目录执行。若 marker 只路由一部分工具，就会形成割裂的执行世界：通用 Consumer 要么失败，要么可能操作 marker 的本地别名。为了运行 TypeScript 而要求目标主机安装 Node，也会使远程部署远大于其提供的能力。

## 决策

[桌面 Remote-SSH 连接网关](2026-08-30-desktop-remote-ssh-tool-gateway.md)会部署一个仅监听回环地址的 Go agent。本地 Node Host 仍是产品控制平面；Go 二进制是远程执行平面。经认证的桌面 bridge 只转发 marker 根目录、远程根目录、连接 id 与 generation 均匹配当前已发布身份的请求；该身份不可用时，绝不回退到本地路径或进程。

对于 marker target，`dsh-fs-local` 会把语义文件系统操作保留在所选远程根目录中，并向 Consumer 提供远程规范进程路径和采用提供方平台语法的 `file:` URI。`dsh-subprocess-local` 会为可执行文件查找、普通受管进程和 PTY 分配复核同一个 marker 身份，然后向 Go agent 转发 argv、显式环境条目及 tombstone、字节流、终止和存活检查。因此，前台和后台 Bash、持久终端与 LSP 都使用所选的远程执行世界，而不是 marker 形式的本地目录。

在 marker Workspace 中，`glob` 和 `grep` 使用以所选根目录为范围的原生 Go 搜索 route。该 route 会在请求解析时执行根目录检查，并独立应用结果、读取和响应上限；不完整的远程搜索会失败，而不会把部分结果呈现为完整结果。

每次 Code Mode、普通进程和 PTY 启动都会携带新生成的 32 位小写十六进制 nonce。agent 会以规范根目录和启动输入指纹为键；因此响应丢失后的重试会返回最初发布的句柄，改变输入则被拒绝。发布前的恢复会复核当前 marker 身份，若已重新绑定就快速失败而不会使用旧连接；发布后，记录的 owner 也只可用于明确的终止或取消清理。读取、写入、启动、等待，以及 Code Mode 的 polling 或 reply 绝不会使用已退役的身份。

当 `CodeRunRequest.cwd` 指向当前 marker 时，`WorkerThreadCodeRuntime` 会选择远程实现。每次运行时，agent 都会重新执行一个受限子进程，并使用本地 Host 传入的正 `memoryLimitBytes` 与 `computeMs`；只有该子进程会通过 esbuild 转换 TypeScript 程序，并在全新的 Goja isolate 中运行。它不拥有 HTTP listener 或保留的 session 表，因此 OOM 或被强制结束的子进程只会结束当前运行，父 agent 仍可用。子进程只会将实际执行 Goja 程序和 promise continuation 的时间累计到 `computeMs`，等待本地 Host binding reply 的时间不计入；热循环会以 `timeout` 结束。其 polling session 会把 console 输出和 binding 调用发送给本地 Host；Host 仍会经普通工具管线执行每个工具调用，包括审批和持久的 Code Mode 分派日志，然后把 lossless JSON 结果或拒绝发送回 isolate。start、polling 和 reply 操作都会复核 marker，因此重新绑定不能让旧 session 控制新连接。start 已被接受并发布后，任何 marker、next 或 reply 失败、取消或拆卸都只能使用记录的 owner 尽力取消旧 session；它绝不会选择重新绑定后的连接，也不会运行 start、polling 或 reply。agent 会把已完成的 session 保留两分钟，并且最多接纳八个活动或保留中的 session；表已满时，新 start 会以 `code-session-limit` 失败。远程运行时不会暴露 Node 安装、Node 内建模块、Host 环境，或直接工具权限。

远程文件系统与搜索目标，以及受管进程的工作目录，都会在每次请求解析时针对所选根目录检查，包括词法穿越和经已解析符号链接的逃逸。该根目录只是执行坐标和路径策略，不是文件系统或 OS 沙箱；它不能防御目标侧并发替换已检查的符号链接或祖先目录。文件系统的 `workspace-write` 会保留语义路径围栏，而远程 shell 或语言服务器在拥有同执行世界的远程沙箱 Provider 出现前仍需要 `danger-full-access`。连接 id、进程句柄、终端 session 和 Code Mode polling session 都只存在于内存中；bridge 或桌面端关闭会使其失效，用户必须重新连接，系统不会从持久状态中恢复它们。

本记录在桌面 marker target 上落实[文件系统与子进程执行世界之上的可移植 Consumer](../architecture/2026-07-28-portable-execution-world-consumers.md)的通用提供方规则。较早的连接网关记录仍负责 SSH 认证、主机密钥确认、marker 重新绑定和本地 bridge 认证。

## 考虑过的替代方案

**保留前台文件系统与 Bash 网关。** 未采用，因为后台句柄、PTY、语言服务器、搜索和 Code Mode 要么会失败，要么需要 Consumer 专属的远程适配器，违反执行世界约定。

**部署 Node 运行时并原样迁移现有 worker。** 未采用，因为远程 Code Mode 除了 JavaScript 引擎，还需要回调协议和工具权限路由。Goja 与 esbuild 随 Go agent 一同交付，不要求目标侧 Node 运行时；携带权限的回调部分仍由本地 Host 保留。

**嵌入 [ts-engine](https://github.com/viveke22/ts-engine)。** 未采用，因为本次评估的解释器未实现 async/await 或箭头函数，而 Code Mode 的顶层 await 与生成的 SDK 都需要它们。它还刻意暴露 `fetch`、文件系统 API 和 HTTP 模块，与仅通过 binding 获得远程权限的边界冲突。收窄并扩展它仍需要实质性 fork 和同一套回调协议。

**在远端运行完整 Coding Host。** 未采用，因为它会迁移 Session 持久化、凭据、设置、模型传输和 UI 所有权，而桌面选择器的目的正是在本地保留这些所有权。

**通过临时 shell 命令实现远程文件系统和搜索。** 未采用，因为它会丢失通用 Consumer 已使用的类型化文件系统身份、带版本的变更语义、有界字节传输和进程／终端生命周期保证。

## 后果

Remote-SSH 向所选远程 Workspace 提供与文件系统、进程、终端、LSP、搜索和 Code Mode 对应的同类能力，而无需上传 Node。本地 Host 仍是模型可见执行、审批和 Session 日志的唯一所有者；远程程序不能通过直接工具 binding 绕过该所有权。

Goja 实现是 TypeScript 执行基质，不是 Node 兼容层。依赖 Node 全局变量、内建模块、原生 addon 或进程内 Host 状态的程序会失败，而不会获得未声明的远程能力。远程进程与终端生命周期只在所选 SSH 连接和桌面 bridge 存活时可用；Coding 不持久化凭据、不自动重连，也不会在重启后恢复活动句柄。

聚焦的 Go 覆盖固定请求解析时的根目录检查、严格 wire 解码、受管进程与 PTY 生命周期、原生搜索上限以及 Code Mode 的 polling／reply／取消。它还证明一个受内存上限约束的子进程可以结束，同时 `/v1/health` 与后续代码运行仍可用。聚焦的 TypeScript 覆盖固定 marker target 路由、远程 stream 与 handle 行为、LSP Workspace 解析、搜索渲染，以及远程 Code Mode binding 在本地执行的行为。
