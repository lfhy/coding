---
description: "客户端固定布局壳：导航、对话、详情、会话工作台和横跨主内容的工作台底栏。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-layout

## 概述

本包拥有浏览器根布局、瞬时面板几何和 `ctx.layout`。AppFrame 保留导航栏、对话区和既有详情栏，并声明独立的会话级 `workbench` 与 `workbench.bottom` slot。宽屏工作台遵循导航栏自己的展开偏好，主内容上方形成左侧对话与右侧固定工作台；工作台占用者再把自己的区域拆成中间预览和右侧文件树。包内主题呈现器把 `ctx.theme` 的已解析快照投影到 document；功能插件只负责填充 slot，不直接操作根网格。

<a id="use-this-package"></a>
## 使用本包

把本插件作为唯一 `root` entry 挂载。一次注册声明以下子 slot：

| Slot | Scope | Owner 数据 |
| --- | --- | --- |
| `sidebar` | `root` | `collapsed`、实际 `width` |
| `conversation` | `session-maybe` | 空 owner share |
| `details` | `session` | 空 owner share |
| `workbench` | `session` | 可见、全屏、底栏与文件侧栏状态和控制回调 |
| `workbench.bottom` | `session` | `shown` |
| `shell.overlay` | `root` | 无 owner 数据的有序 list |

`ctx.layout` 提供全局的 `toggleSidebar()`、`openDetails()`、`closeDetails()`，以及接收 `SessionId` 的 `openWorkbench()`、`closeWorkbench()`、`toggleWorkbench()`、`toggleWorkbenchFullscreen()`、`toggleWorkbenchBottom()` 和 `toggleWorkbenchFiles()`。`workbench(sessionId)` 返回会话页头入口、工作台顶栏与侧边栏品牌行开关可订阅的工作台显隐投影。打开工作台会关闭详情栏；打开详情栏会暂时覆盖工作台，关闭详情栏后恢复该 Session 的工作台状态。工作台未打开时 `toggleWorkbenchBottom()` 与 `toggleWorkbenchFiles()` 会先打开工作台并让对应面板可见。关闭工作台不会改写宽度、底栏与文件侧栏偏好。

空白会话同样拥有按 Session 隔离的工作台状态。欢迎页打开底栏后发送首条消息，不会重建布局状态；侧边栏的全局收起状态也不受会话阶段影响。

## 布局行为

宽屏工作台由用户选择宽度的导航栏、左侧对话和右侧工作台组成。在默认 280px 导航栏和 1110px 视口下，求解器保留 400px 对话并把 430px 交给工作台；工作台宽度偏好可在 300--2400px 间拖拽，空间不足时先收缩到 300px，再由对话承担剩余让步。低于 1024px 时导航自动收成 56px rail，工作台采用全屏呈现：对话继续保持挂载但进入 `inert`，工作台占据 rail 之外的全部主内容；显式最大化使用同一路径。

工作台底栏横跨对话与工作台，不覆盖导航栏，默认高度 260px，拖拽范围为 160--480px。视口过矮时实际高度会向上方工作区让步，尺寸偏好保持不变。工作台、底栏、详情和对话始终保留固定 React 树位置；视觉关闭通过零尺寸、`visibility`、`aria-hidden` 和 `inert` 实现，因此收起底栏或关闭工作台不会仅因布局切换而卸载已激活的终端占用者。

每个尺寸分隔条使用 pointer capture，并把高频移动合并到 animation frame。pointer cancel、capture 丢失、窗口失焦和卸载都会取消待处理帧并结束拖拽。分隔条暴露 `separator` 角色、方向和值域，可用方向键、Home 和 End 调整；轨道动效遵守 `prefers-reduced-motion`。

详情栏沿用既有让步链：先缩到下限，再在对话区空间不足时自动隐藏。切换到另一个非空 Session 会关闭详情栏，并按目标 Session 自己的状态决定是否显示工作台；切回原 Session 会恢复其打开状态、最大化、宽度、底栏开关、文件侧栏开关和底栏高度。布局只负责 1024px 的主内容接管；工作台占用者在 768px 参考宽度收窄文件树，在 375px 手机宽度把文件树改成覆盖预览的单面板呈现。

## 主题呈现

ThemePresenter 设置根元素的 `color-scheme`、body 暗色属性和主题别名变量，并维护一个跟随实际 body 背景色的 `meta[name="theme-color"]`。dispose 只撤回自己写入的属性、变量和 metadata 节点。

<a id="model-experience"></a>
## 模型体验

无，因为布局状态只影响浏览器呈现，不会写入 Session log 或改变模型请求。

#### KV 缓存影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延后工作

- **布局状态仅保存在当前页面。** 刷新会恢复默认导航宽度、关闭详情与工作台，并重置工作台和底栏尺寸。
- **工作台 slot 只定义固定壳。** 文件树、文档预览和终端由各自插件注册，本包不拥有这些业务状态。
- **挤压重排不提供滚动锚定。** 面板尺寸变化可能移动对话区当前阅读位置。

**运行时 invariant：**布局 store 不发送 Cordis 事件；尺寸范围、互斥转换、响应式求解和服务转发由本包单元测试直接约束。
