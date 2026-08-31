# Agent Note: 桌面 Remote-SSH 连接网关

Status: implemented

[English](2026-08-30-desktop-remote-ssh-tool-gateway.md) | 中文

## 问题

Workspace 选择器必须在保留本地 Coding Host、Session 日志、凭据、设置和 UI 的同时打开远程目录。把完整 Host 放到远端会拆分本地产品状态，或要求第二套部署。桌面连接需要一个所选根目录身份和经过认证的传输，既不向浏览器暴露凭据，也不让浏览器直接访问远程 Host。

## 决策

Coding 桌面端提供有界 Remote-SSH 工具网关。选择器为当前连接收集一次密码或私钥，依据应用私有 `known_hosts` 校验主机，部署小型 Go agent，并让用户选择远程目录。agent 只监听远端回环接口；桌面进程通过经过认证的 SSH 连接访问它。浏览器只会得到每窗口的 Wails 能力 token、连接进度、主机密钥确认元数据、目录列表和不敏感的连接 id。待确认主机密钥只保留公钥和目标身份，绝不保留密码或私钥。

选择目录会在 `DSH_HOME` 下创建 v2 本地 marker：`{ version: 2, remoteRoot, connectionId, generation }`。其目录名由 SSH 目标身份和规范化远程路径的摘要组成，因此重新连接同一目标会以幂等方式解析既有 Workspace。每次正式选择都会先原子发布新的内存连接 id 和单调递增的 generation，再路由请求。target key 与 bridge 请求共同标识 marker 根目录、远程根目录、连接 id 和 generation；未发布或陈旧的身份会快速失败，绝不会选择旧连接或本地执行世界。marker 不保存地址或认证材料。连接和 id 只在当前进程中有效：桌面端重启后，打开既有远程 Workspace 会快速失败，直到用户再次执行连接 Remote-SSH。Coding 不会持久化凭据，也不会在后台重新连接。

桌面端启动回环 HTTP bridge，使用与 WebView token 不同的 token，并仅通过环境变量把 URL 和 token 传给本地 Node Host。已经运行的共享 Host 无法取得这项瞬时能力，因此桌面端启动时会先替换兼容的受管 Host，再进行连接。bridge 只接受固定的路由和方法允许列表、有界请求体、当前四部分 marker 身份，以及经过认证的回环请求。

marker 与 bridge 是[桌面 Remote-SSH 使用 Go 执行世界 agent](2026-08-31-desktop-remote-ssh-go-execution-world.md)的传输和所选根目录基础。该决策负责让文件系统、子进程、终端、搜索、LSP 和 Code Mode 在 Go agent 上执行；本记录继续负责连接建立、marker 生命周期以及浏览器／Host 的凭据边界。

远程变更会在发布开始前检查取消，随后等待 agent 的确定响应，不会在提交可能已经发生后中止传输。请求和完整响应上限会计入 JSON/base64 或 before/after 包装，因此已经提交的变更不会仅因确认响应大于请求而被重新归类为传输失败。

本决策只取代[工作区选择器提供本地、远程与无项目入口](2026-08-25-workspace-picker-local-remote-and-no-project-entry.md)中的地址导航分支。该记录仍拥有三项 Hero 操作布局和无项目行为。Go 执行世界决策会在 marker target 上落实[文件系统与子进程执行世界之上的可移植 Consumer](../architecture/2026-07-28-portable-execution-world-consumers.md)中的提供方规则。

## 考虑过的替代方案

**导航到单独可达的远程 Host。** 未将其作为唯一桌面路径，因为它会改变 Session、设置和凭据的所有者，而不是在当前本地产品中打开远程目录。在本选择器流程之外，独立部署的 Host 仍是有效部署方式。

**持久化 SSH 凭据以自动重连。** 本轮未采用，因为这需要凭据引用格式、OS 密钥存储所有权、轮换与吊销行为，以及启动重连状态机。手动重连牺牲便利性，换取更小的持久安全面。

**在重新连接后持久化活动远程句柄。** 未采用，因为 SSH 重连无法安全重建正在运行的进程树、PTY 前台组、待处理的代码回调或保留的输出 cursor。因此，执行世界 agent 会把 bridge 丢失视为内存句柄的结束。

## 后果

远程目标无需安装 Node 运行时，本地 Host 仍是产品状态的唯一所有者。系统会拒绝已变更的主机密钥，要求显式确认未知密钥，并从远程命令中清除环境里形似凭据的变量。请求解析时的校验会拒绝从所选根目录进行词法穿越或经已解析符号链接逃逸；这种路径策略不是 OS 沙箱，也不能防御目标侧并发替换已检查的符号链接或祖先目录。

桌面端启动时会先替换兼容的受管 Host，使其继承瞬时 bridge。既有浏览器会短暂失去该 Host，远程 Workspace 在桌面端重启或 SSH 断开后需要手动重连。已上传 agent 的清理、持久凭据引用和自动重连仍属于独立决策。

聚焦 TypeScript 测试覆盖 marker 校验、bridge 认证与响应上限、远程文件／二进制操作、变更取消、沙箱子目录约束和 marker 路由。Go 测试覆盖严格协议解码、请求解析时的根目录与符号链接逃逸检查、不保留凭据的主机密钥确认、bridge 与 Wails binding、连接清理、确定性 marker 重绑定，以及打包产物选择。桌面构建会打包每个受支持的 agent 目标；Web 场景固定 Remote-SSH 入口，组件测试则固定向导可见文案。
