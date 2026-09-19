---
description: "会话页头工作区打开入口与内置文件管理面板：本地工作区在已安装应用中启动，Remote-SSH 工作区经当前文件系统 provider 浏览。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-open-in-app

## 概述

本包拥有工作区打开能力的浏览器半边。会话页头在渲染前探测当前 `cwd`：本地工作区得到应用分体按钮；Remote-SSH 工作区或经 SSH 启动的 Host 得到一个紧邻 Session log 的紧凑文件夹图标。点击远端入口会打开该 utility 自己拥有的内置文件管理面板，浏览器和桌面客户端在 macOS、Windows、Linux 上共用同一响应式实现。

## 目录

- [使用本包](#use-this-package)
- [行为](#behavior)
- [实现](#implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#已知限制与延后工作)

-----

<a id="use-this-package"></a>
## 使用本包

把本 Client 插件与 [`dsh-host-open-in-app`](../../host/open-in-app/README.md) 并排挂载。本包不接受配置。Host 必须提供目标判定、图标、启动和文件列表路由；Web bundle 默认同时挂载两半。

<a id="behavior"></a>
## 行为

本地工作区的主按钮显示记住的应用图标，tooltip 为**在本地打开**。点击立即启动；下拉箭头列出 Host 已验证的全部 catalog 应用。所选 id 持久化在 `dsh.open-in-app.choice`；选择已失效时回退到第一个可用应用。只有请求超过 250 ms 才显示等待态，启动失败会显示两秒错误状态。

对于 Remote-SSH，Client 不根据 marker 路径自行猜测。Host 的目标响应会选择文件动作；页头右侧紧邻 Session log 的紧凑图标直接打开本 utility 自持的文件管理面板。若本地路径在探测与点击之间变成远端 marker，启动响应也会切换到同一面板。

文件管理面板每次请求一层目录。面包屑保存 provider 返回的名称数组，而不在浏览器里构造平台路径。因此 Windows 桌面可浏览 POSIX 远端，POSIX 桌面也可浏览 Windows 远端，无需翻译路径分隔符。刷新时保留当前列表，加载与失败状态可见，键盘焦点完整；视口窄于 640 px 时隐藏大小列。

<a id="implementation"></a>
## 实现

插件通过 slot declaration injection 在 `conversation.session.header.utilities` 注册 `OpenInAppAction`。该 entry 订阅页面生命周期的目标与应用选择 store，并拥有远端文件管理面板的打开状态、目录导航和文件列表 carrier；它不向会话页面 owner 扩展导航回调。

`OpenInAppController` 在浏览器 wire 边界校验每份 Host 响应。目标请求按 `cwd` 合并，并把已落定结果缓存到页面结束。路由常量和 JSON 载荷类型来自浏览器安全的 `@deepseek-ai/dsh-host-open-in-app/shared` 子路径。

## 进一步探索

- [Host 包](../../host/open-in-app/README.md)——平台解析、路由安全、Remote-SSH 判定和文件系统遍历。
- [Remote-SSH 执行世界](../../../.agents/notes/implemented/feature/2026-08-31-desktop-remote-ssh-go-execution-world.md)——`ctx.fs` 为什么会把 marker 工作区交给桌面 Go agent。
- [转正决策](../../../.agents/notes/implemented/feature/2026-08-25-promote-open-anywhere-plugin.md)——归属与被拒的替代方案。

<a id="model-experience"></a>
## 模型体验

无，因为页头控件与文件管理面板不会追加 Session 事件，也不会改变模型请求。

#### KV 缓存影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延后工作

- **文件管理面板只读。** 当前只列出和进入目录；文件预览、上传、重命名、删除及其它 mutation 需要独立的用户可见契约，暂缓实现。
- **单层最多 2,000 项。** Host 会标记截断，页脚会提示；分页仍然延后。
- **目标结果按 `cwd` 缓存到页面结束。** 新安装应用需要重载页面并重启 Host；启动器丢失时 Host 仍会在点击路径上复核。
- **locale 词典把守应用 id。** 两份词典中没有 `app.<id>` 的 catalog id 保持隐藏。

**运行时 invariant：** companion 只保留包归属，不安装额外关系。Controller 与面板状态只有本 utility 一个 owner，slot 生命周期测试证明页头 entry 会随插件 fiber 消失。
