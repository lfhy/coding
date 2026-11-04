# coding-tool-ppt

## 概述

PPT 创作模式的七个模型工具：`ppt_create`、`ppt_open`、`ppt_read`、`ppt_edit`、`ppt_undo`、`ppt_redo`、`ppt_export`。工具只做参数校验、会话解析与结果投影；工程存储、版本历史与 `.pptx` 导出归 [`coding-ppt-workbench`](../ppt-workbench/README.md)，它提供 `pptProjects` 服务。

本包按 agent 组装：它属于 `ppt` 预设，不属于宿主组合。这样其它模式的请求前缀里不会出现 PPT 的工具 schema，而 PPT 模式的会话与工作台仍然读写同一份工程。

## 行为

- **目录参数可选**：`dir` 省略时作用于「会话当前打开的工程」；给出时按工作区相对路径解析，越界即拒绝。
- **编辑是原子的**：`ppt_edit` 的 `ops` 要么整体生效，要么整体失败；`base_revision` 与当前版本不符时返回冲突，而不是覆盖别处的改动。
- **失败诊断**：参数、目录、版本与工程内容的问题都以工具错误返回中文原因（例如「找不到页面 "p2"」「工程已被修改：当前版本 4，请求基于 3」），模型据此重读再改。

## 工具面

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `ppt_create` | 新建工程（标题页）并让工作台切过去 | `title` · `dir` · `size` · `theme` |
| `ppt_open` | 打开既有工程 | `dir` |
| `ppt_read` | 读整份页面与元素数据 | `dir` |
| `ppt_edit` | 应用 ops（页与元素的增删改、页面属性、文稿属性） | `ops` · `base_revision` · `dir` |
| `ppt_undo` / `ppt_redo` | 版本前后移动 | `steps` · `dir` |
| `ppt_export` | 导出 .pptx 到 `export/` | `dir` |

## 使用本包

把本行挂进 `ppt` 预设；宿主必须同时装配 `coding-ppt-workbench`（服务名 `pptProjects`），否则调用会返回「PPT project service is not mounted in this deployment」。

## 模型体验

### 模型看到什么

七个工具的名字、描述与参数 schema，都在 `ppt` 模式会话的请求前缀里；其它模式看不到它们。工具结果是一行 JSON：工程摘要（目录、标题、版本、页数、能否撤销/重做）或 `ppt_read` 的完整页面数据，导出则给出绝对路径与字节数。错误同样是工具结果，带具体原因。

### token 影响

只在 `ppt` 模式的会话里付费。`ppt_read` 返回整份工程，页面多、文字多时是这里的主要开销，因此建议按页迭代而不是反复全量读取。

#### KV Cache 影响

只追加。工具 schema 与描述是常量，位于请求前缀的稳定段；工具结果只延长对话尾部，不重写更早的前缀。

## 已知限制与暂缓工作

- 没有 `ppt_import`：不能把既有 .pptx 逆向进工程。
- 没有质检工具（文字溢出、对比度、缺字体等规则检查），导出不阻断。
- 没有单页图片化预览；面板用 DOM 直渲，模型要看画面只能自行合成截图。
