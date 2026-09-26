# 使用 Coding 界面

浏览器使用方式请按[根目录 README](../../../README.md#run) 启动 Web UI，命令会打印访问地址；macOS arm64 桌面端由 [Electron 应用](../../../apps/desktop-electron/README.md)提供。本指南从界面已经打开的状态开始。`dsh` 进程会把启动时所在的目录作为默认文件系统位置；全新的界面不会选中任何 Workspace。

macOS 桌面窗口打开时默认最大化，不会进入全屏。双击顶栏空白处可在最大化与还原之间切换；还原后拖动空白处可移动窗口。顶栏按钮和输入框仍可正常操作。

## 配置模型

打开**设置 → 模型**，输入 [DeepSeek API 密钥](https://platform.deepseek.com/)并保存。模型路由会立即可用，不需要重启服务器。

[模型配置指南](./providers.md)介绍其他提供方和自定义 OpenAI 兼容端点。

## 选择开始方式

点击**选择工作区**即可搜索已列出的 Workspace。若要在本地项目中工作，可选择已有 Workspace，或选择**打开文件夹**并选取项目目录。Session 打开后，编辑器即可使用。

选择**不在项目中工作**会在 Host 用户 HOME 目录创建 Session，但不会注册 Workspace。只有没有当前 Session 时，编辑器才不可用。

新对话欢迎页右上角有两个面板按钮：左侧打开或收起横跨主内容的终端底栏，右侧打开或收起右侧文件侧栏。进入具体对话后，两个开关仍在对话页头右上角；工作台接管对话区时则在工作台顶栏操作，不会移到左侧栏。右侧按钮不控制左侧导航栏；通过欢迎页按钮打开一个面板时会收起另一个，再次点击则关闭该面板，不折叠导航栏。工作台中的普通面板开关可以同时显示两个面板。

终端底栏的 `+` 可新建独立终端，点击标签切换；标签上的关闭按钮结束该终端，右侧的关闭按钮只收起底栏，重新打开时仍可使用原有终端。

已有空白 Session 时，面板按钮会沿用该 Session；还没有当前 Session 时会先连接最近使用的 Workspace，没有 Workspace 则在 Host 用户 HOME 创建未分组 Session。发送第一条消息后，所选面板会在这次对话中保持打开。

在 Coding 桌面端中，选择**远程连接**，先选连接模式，再输入 SSH 主机、使用密码或私钥认证、确认未知主机密钥并选择远程目录。默认的**基础模式**只使用 SSH 与 SFTP，无需上传远端 agent 或允许 SSH TCP 转发；它支持远端目录浏览、文件读取／写入／编辑、`glob`／`grep` 搜索、前台与后台 Bash 命令、持久终端／PTY，以及 Code Mode 的 Bash 和远程文件工具。基础模式不支持 LSP；Windows 远端不支持基础模式的命令与 PTY 操作，执行请求会明确失败。

基础模式写入使用 SFTP：原子创建需要服务器支持 hardlink 扩展，覆写与编辑需要 `posix-rename@openssh.com`，缺少相应扩展会失败。按版本覆写会在提交前复核文件，但 SFTP 不提供原子的版本比较交换，并发写入仍可能发生在复核和发布之间。SSH 不提供前台进程组查询，终端的相应检查不可用；信号或终止请求不能保证远端进程树已经退出，状态不明时会报告失败，请检查远端状态后再操作。

需要 LSP 或 Go agent 提供的远端执行语义时，选择 **Agent 模式**。它也支持文件读写编辑、搜索、前后台 Bash、持久终端／PTY 与 Code Mode，会部署仅监听远端回环地址的小型 Go agent，并需要 SSH `direct-tcpip` 转发；目标侧不需要 Node。两种模式的 Code Mode 都经 esbuild 转换 TypeScript 并在隔离的 Goja 中运行，拥有声明的工具 binding，但没有 Node 内建模块、`process`、`require` 或 Host 环境；基础模式的 Goja 隔离进程在桌面 helper 本机，文件与 Bash binding 仍指向远端，不会回退到本机工作区或 Node worker。

两种模式的凭据都只保留在当前对话框／连接中，不会保存；未知主机密钥需要明确确认，已变更的主机密钥会使连接失败。应用重启后需要重新连接，才能复用已有的远程工作区；普通浏览器界面不能发起 SSH 连接。本地 Host 仍负责工具审批和持久 Session 日志。远程 Bash 需要使用**完全访问**（`danger-full-access`）；这不是远端沙箱。连接断开、marker 过期或所选模式不支持操作时，请重新连接或选择合适模式；操作会失败，不会改在本机运行。

## 运行任务

启动一个会话并发送：

> Summarize this repository and identify its main packages.

Agent（智能体）可以读取和编辑工作区文件、运行命令、委派工作并维护计划。如果根据当前权限策略，某项操作需要审批，Web UI 会先询问你。

## 继续使用

- [配置模型](./providers.md)
- [使用 Python SDK](./python-sdk.md)
- [使用其他 CLI 模式](../../../apps/cli/README.md)
- [开发插件](../develop/basic/)
