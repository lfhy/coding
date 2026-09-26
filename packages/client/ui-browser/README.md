---
description: "在 Session 文件工作台中显示 Host 受控浏览器的只读画面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-browser

## 用法与行为

本包的 Client 半边占用 `workbench.browser` 会话级 slot；`ui-open-in-app` 声明该 slot 并提供 `{ shown, openBrowser, closeBrowser }`。每个挂载的 Session 每约 750ms 从同源 Host GET `/browser-use/state?sessionId=` 读取观测，状态存在时再按 generation/revision GET `/browser-use/frame` 读取 PNG。工作台文件视图切换不会卸载该条目；首次读取已有浏览器状态只作为基线，不抢用户的文件选择。挂载后出现新状态或修订版时调用 `openBrowser()`，关闭按钮只返回文件视图，不关闭 Host 浏览器上下文。

状态 JSON 在 Client 边界校验 generation、单调 revision、HTTP(S)/`about:blank` 地址、文本长度、画面尺寸、指针坐标和操作种类。截图只作为 Blob object URL 在控制器内保存，换帧、消失、卸载时撤销；旧请求和过期修订版不能覆盖新画面。错误可重试，未知或关闭的浏览器显示空状态。组件只绘制 Host 捕获的图片、标题、地址、操作状态与相对截图坐标的虚拟指针；页面不会作为 iframe、WebView 或可执行 HTML 装入 Client，也没有页面控制端点。

浏览器必须由 Host provider 提供受 Origin 与本地访问约束的只读路由。本包没有公开配置，词典包含中文和英文；CSS Modules 使用共享语义 token，窄屏会收紧工具栏，减少动态效果设置会禁用指针脉冲动画。

## 模型体验

无。页面观测只读显示；模型工具、日志与提示词由浏览器能力提供方持有，本包不改写。

#### KV 缓存影响

无；本包不组装模型请求。

## 已知限制与延后工作

截图按轮询频率更新而非实时视频；页面交互由模型工具执行，不提供人类点击、输入或导航控件。

**运行时 invariant：** companion 只登记包名；请求栅栏、图片释放与 slot fiber 清理由包测试验证。
