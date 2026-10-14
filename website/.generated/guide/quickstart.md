---
editSource: "docs/user/guide/index.md"
---

# 使用 Web UI

请先按照[根目录 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md#run) 中的说明启动 Web UI；命令会打印其访问地址。本指南从服务器已经运行的状态开始。`dsh` 进程会把启动时所在的目录作为默认文件系统位置；全新的 Web UI 不会选中任何 Workspace。

## 配置模型

打开**设置 → 模型**，输入 [DeepSeek API 密钥](https://platform.deepseek.com/)并保存。模型路由会立即可用，不需要重启服务器。

[模型配置指南](./providers.md)介绍其他提供方和自定义 OpenAI 兼容端点。

## 选择开始方式

点击**选择工作区**即可搜索已列出的 Workspace。若要在本地项目中工作，可选择已有 Workspace，或选择**打开文件夹**并选取项目目录。Session 打开后，编辑器即可使用。

选择**不在项目中工作**会在 Host 默认工作目录创建 Session，但不会注册 Workspace。只有没有当前 Session 时，编辑器才不可用。

在 Coding 桌面端中，选择**连接 Remote-SSH**，即可输入 SSH 主机、使用密码或私钥认证、确认未知主机密钥并选择远程目录。凭据只保留在当前对话框／连接中，不会保存；应用重启后需要重新执行连接流程。普通浏览器界面不能发起 SSH 连接。

Remote-SSH 会通过紧凑的 Go agent 在所选目录中运行语义文件系统操作、`glob`／`grep`、前台和后台 Bash、持久终端／PTY、LSP 与 Code Mode。目标侧不需要 Node；本地 Host 仍负责工具审批和持久 Session 日志。在拥有同执行世界的远程沙箱 Provider 出现前，远程 Bash 需要使用**完全访问**（`danger-full-access`）。Code Mode 会经 esbuild 转换 TypeScript，并在 Goja 中运行，因此它拥有声明的工具 binding，但没有 Node 内建模块、`process`、`require` 或 Host 环境。过期 marker 或已断开的连接会失败，而不会在本机运行操作。

## 运行任务

启动一个会话并发送：

> Summarize this repository and identify its main packages.

Agent（智能体）可以读取和编辑工作区文件、运行命令、委派工作并维护计划。如果根据当前权限策略，某项操作需要审批，Web UI 会先询问你。

## 查看会话概览

会话打开后，Chat 视图右侧的信息卡按“协作”和“运行统计”分组，汇总当前会话的子代理、后台任务数量，以及轮次、步骤、LLM／工具耗时、首 token 延迟、生成速度和 token 用量；卡片不重复显示“会话概览”标题，输入框下方也不显示这些统计。统计来自整个会话；尚未产生样本的项目不会显示。页头原有的子代理和后台任务菜单仍可查看具体条目。Chat 页头右侧的列表形按钮在宽屏默认展开信息卡，侧栏占用空间或窗口变窄时默认收起；点击按钮可切换显示，展开的卡片也可从右上角收起。切换到轨迹等其他视图时，卡片与按钮隐藏，回到 Chat 后恢复先前的展开状态。

## 继续使用

- [配置模型](./providers.md)
- [使用 Python SDK](./python-sdk.md)
- [使用其他 CLI 模式](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)
- [开发插件](../develop/basic/index.md)
