# 使用 Web UI

请先按照[根目录 README](../../../README.md#run) 中的说明启动 Web UI；命令会打印其访问地址。本指南从服务器已经运行的状态开始。`dsh` 进程会把启动时所在的目录作为默认文件系统位置；全新的 Web UI 不会选中任何 Workspace。

## 配置模型

打开**设置 → 模型**，输入 [DeepSeek API 密钥](https://platform.deepseek.com/)并保存。模型路由会立即可用，不需要重启服务器。

[模型配置指南](./providers.md)介绍其他提供方和自定义 OpenAI 兼容端点。

## 选择开始方式

点击**选择工作区**即可搜索已列出的 Workspace。若要在本地项目中工作，可选择已有 Workspace，或选择**打开文件夹**并选取项目目录。Session 打开后，编辑器即可使用。

选择**不在项目中工作**会在 Host 用户 HOME 目录创建 Session，但不会注册 Workspace。只有没有当前 Session 时，编辑器才不可用。

新对话欢迎页右上角可以打开或收起侧边栏，也可以打开终端底栏。打开底栏会沿用当前空白会话；还没有会话时会先连接最近使用的 Workspace，没有 Workspace 则在 Host 用户 HOME 创建未分组会话。发送第一条消息后，底栏与侧边栏状态继续保留在这次对话中。

在 Coding 桌面端中，选择**连接 Remote-SSH**，即可输入 SSH 主机、使用密码或私钥认证、确认未知主机密钥并选择远程目录。凭据只保留在当前对话框／连接中，不会保存；应用重启后需要重新执行连接流程。普通浏览器界面不能发起 SSH 连接。

Remote-SSH 会通过紧凑的 Go agent 在所选目录中运行语义文件系统操作、`glob`／`grep`、前台和后台 Bash、持久终端／PTY、LSP 与 Code Mode。目标侧不需要 Node；本地 Host 仍负责工具审批和持久 Session 日志。在拥有同执行世界的远程沙箱 Provider 出现前，远程 Bash 需要使用**完全访问**（`danger-full-access`）。Code Mode 会经 esbuild 转换 TypeScript，并在 Goja 中运行，因此它拥有声明的工具 binding，但没有 Node 内建模块、`process`、`require` 或 Host 环境。过期 marker 或已断开的连接会失败，而不会在本机运行操作。

## 运行任务

启动一个会话并发送：

> Summarize this repository and identify its main packages.

Agent（智能体）可以读取和编辑工作区文件、运行命令、委派工作并维护计划。如果根据当前权限策略，某项操作需要审批，Web UI 会先询问你。

## 继续使用

- [配置模型](./providers.md)
- [使用 Python SDK](./python-sdk.md)
- [使用其他 CLI 模式](../../../apps/cli/README.md)
- [开发插件](../develop/basic/)
