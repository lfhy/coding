# coding-tool-ppt

## 概述

PPT 创作模式的十五个模型工具覆盖工程创建、打开、读写、撤销/重做、渲染、质检、导入与导出，以及用户模板的列出、导入、保存、改名和删除。工具只做参数校验、会话解析与结果投影；工程和本机用户模板库归 [`coding-ppt-workbench`](../ppt-workbench/README.md) 的 `pptProjects` 服务。

本包按 agent 组装：它属于 `ppt` 预设，不属于宿主组合。这样其它模式的请求前缀里不会出现 PPT 的工具 schema，而 PPT 模式的会话与工作台仍然读写同一份工程。

## 行为

- **目录参数可选**：`dir` 省略时作用于「会话当前打开的工程」；给出时按工作区相对路径解析，越界即拒绝。
- **编辑是原子的**：`ppt_edit` 的 `ops` 要么整体生效，要么整体失败；`base_revision` 与当前版本不符时返回冲突，而不是覆盖别处的改动。
- **元素种类**：文本框、矩形/椭圆、连接线、图片（`media/<file>`）、表格（行 × 列 + 单元格文本）、图表（柱状/折线/饼，分类 + 系列），另有层级调整（`reorder_element`）与复制（`duplicate_element`）。
- **字体与动画**：文本元素可指定 `font` 族名；导出按 `fsType` 许可嵌入字体，结果里的 `fonts`／`skippedFonts` 说明嵌了谁、为什么跳过。元素可带 `animation`（fade/fly/zoom/wipe），页面可带 `transition`（none/fade/push）。
- **导入**只搬运模型能表达的结构；图表、SmartArt 与动画会出现在结果的 `dropped` 里，应当如实告诉用户。
- **用户模板**是完整演示文稿及其媒体快照，与 `ppt_edit` 的七种内置单页版式不同。`ppt_templates` 只列摘要，不打开工程；`ppt_save_template` 将当前工程或指定 `dir` 保存为新模板，不改变现稿；`ppt_create` 不带模板时必须给出 `title`，指定 `templateId` 则新建工程副本并打开工作台，`title` 可选，缺省采用模板名称，`size`、`theme` 不能与 `templateId` 同用。远程工作区不能保存或套用本机模板。
- **模板导入与管理**：`ppt_import_template` 从本机工作区相对路径读取不超过 8 MiB 的无宏 `.pptx`，只保存模板而不创建或切换工程；结果摘要包括不保真的 `dropped` 项。`ppt_rename_template` 以 id 改名，`ppt_delete_template` 须同时给出 id 和当前名称且两者匹配，避免误删；远程工作区不支持模板导入。
- **失败诊断**：参数、目录、版本与工程内容的问题都以工具错误返回中文原因（例如「找不到页面 "p2"」「工程已被修改：当前版本 4，请求基于 3」），模型据此重读再改。

## 工具面

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `ppt_create` | 新建标题页工程，或从用户模板新建整稿副本并让工作台切过去 | `title` · `dir` · `size` · `theme` · `templateId` |
| `ppt_templates` | 列出本机用户模板的 id、页数与导入丢失项 | 无 |
| `ppt_import_template` | 将本机工作区中的 .pptx 保存为用户模板，不打开工程 | `source` · `name` |
| `ppt_save_template` | 将当前或指定工程保存为新的用户模板 | `name` · `dir` |
| `ppt_rename_template` | 修改用户模板的名称 | `id` · `name` |
| `ppt_delete_template` | 按 id 和当前名称确认删除用户模板 | `id` · `name` |
| `ppt_open` | 打开既有工程 | `dir` |
| `ppt_read` | 读整份页面与元素数据 | `dir` |
| `ppt_edit` | 应用 ops（页与元素的增删改、页面属性、文稿属性） | `ops` · `base_revision` · `dir` |
| `ppt_undo` / `ppt_redo` | 版本前后移动 | `steps` · `dir` |
| `ppt_render` | 渲染页面图：在会话的 Agent 浏览器里打开并落 PNG | `dir` · `pages` |
| `ppt_check` | 规则质检（出界、零尺寸、溢出、对比度、空页、文字密度）；`ai: true` 追加模型审阅 | `dir` · `ai` |
| `ppt_import` | 把工作区里的 .pptx 逆向成工程 | `source` · `dir` · `title` |
| `ppt_export` | 导出 .pptx 或 PDF 到 `export/`（PDF 先渲染每页） | `dir` · `target` · `skip_check` |

## 使用本包

把本行挂进 `ppt` 预设；宿主必须同时装配 `coding-ppt-workbench`（服务名 `pptProjects`），否则调用会返回「PPT project service is not mounted in this deployment」。

## 模型体验

### 模型看到什么

工具名字、描述与参数 schema 只在 `ppt` 模式会话的请求前缀里；其它模式看不到它们。工具结果是一行 JSON：工程摘要（目录、标题、版本、页数、能否撤销/重做）、`ppt_read` 的完整页面数据、`ppt_render` 的页面图片路径、`ppt_check` 的问题列表、`ppt_import` 的丢失内容列表、用户模板元数据或删除确认，或导出的绝对路径与字节数。模板工具不把完整 deck、媒体或二进制文件放进模型消息。错误同样是工具结果，带具体原因。

### token 影响

只在 `ppt` 模式的会话里付费。`ppt_read` 返回整份工程，页面多、文字多时是这里的主要开销，因此建议按页迭代而不是反复全量读取。

#### KV Cache 影响

只追加。工具 schema 与描述是常量，位于请求前缀的稳定段；工具结果只延长对话尾部，不重写更早的前缀。

## 已知限制与暂缓工作

- `ppt_render` 可指定单页或多页，依赖会话的 Agent 浏览器打开页面并保存 PNG；没有浏览器提供方时无法渲染，PDF 导出也会失败。
- AI 审阅附带最多 4 页实际渲染图（首页、第二、第三与最后一页），经附件通道准入后交给会话模型；模型不支持看图时退回纯大纲审阅。
- AI 审阅只出建议、不改工程也不阻断导出；没有可用模型路由时如实返回 `performed: false` 与原因。
- 字体只嵌入 glyf 轮廓的 TrueType（`.ttf`、`.ttc` 首 face）；CFF/OTF 跳过。子集化失败时回退整字体。
- 导入对图表、SmartArt、OLE 与动画只能报告 `dropped`，不能降级成占位形状。
