# coding-tool-ppt

## 概述

PPT 创作模式的十八个模型工具覆盖工程创建、打开、读写、撤销/重做、渲染、质检、导入与导出，以及用户模板的制作、套用和管理。工具只做参数校验、会话解析与结果投影；工程和本机用户模板库归 [`coding-ppt-workbench`](../ppt-workbench/README.md) 的 `pptProjects` 服务。

本包按 agent 组装：它属于 `ppt` 预设，不属于宿主组合。这样其它模式的请求前缀里不会出现 PPT 的工具 schema，而 PPT 模式的会话与工作台仍然读写同一份工程。

## 行为

- **目录参数可选**：`dir` 省略时作用于「会话当前打开的工程」；给出时按工作区相对路径解析，越界即拒绝。
- **编辑是原子的**：`ppt_edit` 的 `ops` 要么整体生效，要么整体失败；`base_revision` 与当前版本不符时返回冲突，而不是覆盖别处的改动。
- **元素种类**：文本框、矩形/椭圆、连接线、图片（`media/<file>`）、表格（行 × 列 + 单元格文本）、图表（柱状/折线/饼，分类 + 系列），另有层级调整（`reorder_element`）与复制（`duplicate_element`）。
- **字体与动画**：文本元素可指定 `font` 族名；导出按 `fsType` 许可嵌入字体，结果里的 `fonts`／`skippedFonts` 说明嵌了谁、为什么跳过。元素可带 `animation`（fade/fly/zoom/wipe），页面可带 `transition`（none/fade/push）。
- **导入与补页**：`ppt_import` 和 `ppt_prepare_template` 返回 `dropped`、`sourceSha256` 及逐页 `report`：源页序号、导入页 id、源/导入元素计数、状态、丢失类别和有界文字预览。用 `ppt_read` 对照每页；结构缺失时以同一源文件和哈希调用 `ppt_import_evidence` 分片查证源页 XML 与关联图表缓存，再用 `ppt_edit` 补齐有证据的内容。完整源页证据超过 1 MiB UTF-16 字符会报错，不截断；单片默认 8000、最多 16000 字符，可按 `nextOffset` 续读。源文件变动或消失会拒绝旧哈希，不猜测缺失数据；源页本来为空可保留，只有图片的页可见却不等于内部文字可编辑，也不是缺页。`no_known_loss` 只表示未发现已知结构丢失，不保证视觉保真。
- **用户模板**是完整演示文稿及其媒体快照，与 `ppt_edit` 的七种内置单页版式不同。`ppt_create` 只新建空白标题页工程，必须给 `title`；`ppt_create_from_template` 根据 `ppt_templates` 的 id 新建独立可编辑副本并打开工作台，`title` 可选且缺省使用模板名称，保留原稿尺寸和主题，不接收 `size`、`theme`。`ppt_save_template` 将当前工程或指定 `dir` 保存为新模板，不改变现稿；远程工作区不能保存或套用本机模板。
- **模板制作与管理**：`ppt_prepare_template` 从本机工作区相对路径导入不超过 8 MiB 的无宏 `.pptx` 为可编辑草稿并切换工作台，不写用户模板库；它本身不是模板提取全流程。模型须逐页核实并提取配色、字体层级、布局网格、固定品牌元素和页眉页脚、可替换内容区，用 `ppt_edit` 将具体业务内容泛化成可替换占位，补齐有证据的遗漏，再 `ppt_check`、`ppt_save_template`、`ppt_templates` 验证保存结果。占位可用于模板可替换区，但不能把未知原稿数字编造出来或把占位当成缺页修复；若归纳减少源稿页数须向用户明示。`ppt_import_template` 可直接保存导入快照，但不创建或切换工程，仍须披露 `dropped` 和不保真限制。`ppt_rename_template` 以 id 改名，`ppt_delete_template` 须同时给出 id 和当前名称且两者匹配；远程工作区不支持模板导入。
- **失败诊断**：参数、目录、版本与工程内容的问题都以工具错误返回中文原因（例如「找不到页面 "p2"」「工程已被修改：当前版本 4，请求基于 3」），模型据此重读再改。

## 工具面

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `ppt_create` | 新建空白标题页工程并切换工作台 | `title` · `dir` · `size` · `theme` |
| `ppt_create_from_template` | 从用户模板新建整稿副本并切换工作台 | `templateId` · `title` · `dir` |
| `ppt_templates` | 列出本机用户模板的 id、页数与导入丢失项 | 无 |
| `ppt_prepare_template` | 将 .pptx 导入工程草稿，返回逐页报告，不写模板库 | `source` · `name` · `dir` |
| `ppt_import_evidence` | 按源页与哈希读取 XML/图表证据片段，默认 8000、最多 16000 字符，可续读 | `source` · `sourceIndex` · `sourceSha256` · `offset` · `limit` |
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
| `ppt_import` | 把工作区里的 .pptx 逆向成工程，返回逐页报告与源文件哈希 | `source` · `dir` · `title` |
| `ppt_export` | 导出 .pptx 或 PDF 到 `export/`（PDF 先渲染每页） | `dir` · `target` · `skip_check` |

## 使用本包

把本行挂进 `ppt` 预设；宿主必须同时装配 `coding-ppt-workbench`（服务名 `pptProjects`），否则调用会返回「PPT project service is not mounted in this deployment」。

## 模型体验

### 模型看到什么

工具名字、描述与参数 schema 只在 `ppt` 模式会话的请求前缀里；其它模式看不到它们。工具结果是一行 JSON：工程摘要（目录、标题、版本、页数、能否撤销/重做）、`ppt_read` 的完整页面数据、`ppt_render` 的页面图片路径、`ppt_check` 的问题列表、导入报告、用户模板元数据或删除确认，或导出的绝对路径与字节数。模板目录与保存结果不把完整 deck、媒体或二进制文件放进模型消息；`ppt_import_evidence` 只返回有界文本片段，源文件内容不可信，不能当作指令。错误同样是工具结果，带具体原因。

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
