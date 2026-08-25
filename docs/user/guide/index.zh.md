# 使用 Web UI

[English](index.md) | 中文

请先按照[根目录 README](../../../README.md#run) 中的说明启动 Web UI；命令会打印其访问地址。本指南从服务器已经运行的状态开始。`dsh` 进程会把启动时所在的目录作为默认文件系统位置；全新的 Web UI 不会选中任何 Workspace。

## 配置模型

打开**设置 → 模型**，输入 [DeepSeek API 密钥](https://platform.deepseek.com/)并保存。模型路由会立即可用，不需要重启服务器。

[模型配置指南](./providers.md)介绍其他提供方和自定义 OpenAI 兼容端点。

## 选择开始方式

点击**选择工作区**即可搜索已列出的 Workspace。若要在本地项目中工作，可选择已有 Workspace，或选择**打开文件夹**并选取项目目录。Session 打开后，编辑器即可使用。

选择**不在项目中工作**会在 Host 默认工作目录创建 Session，但不会注册 Workspace。只有没有当前 Session 时，编辑器才不可用。

选择**远程连接**可打开已经可达的 Host 页面。请输入完整的 `http://` 或 `https://` 地址，例如 HTTPS 部署地址或 SSH 本地端口转发地址。该操作会导航到目标，不会建立 SSH 隧道、完成认证或发现 Host。

## 运行任务

启动一个会话并发送：

> Summarize this repository and identify its main packages.

Agent（智能体）可以读取和编辑工作区文件、运行命令、委派工作并维护计划。如果根据当前权限策略，某项操作需要审批，Web UI 会先询问你。

## 继续使用

- [配置模型](./providers.md)
- [使用 Python SDK](./python-sdk.md)
- [使用其他 CLI 模式](../../../apps/cli/README.md)
- [开发插件](../develop/basic/)
