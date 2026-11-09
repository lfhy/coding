# coding-tool-ppt

## 概述

PPT 创作模式的十九个模型工具覆盖工程创建、打开、读写、撤销/重做、渲染、质检、导入与导出、同会话图库图片接入，以及用户模板的制作、套用和管理。工具只做参数校验、会话解析与结果投影；工程和本机用户模板库归 [`coding-ppt-workbench`](../ppt-workbench/README.md) 的 `pptProjects` 服务。

本包按 agent 组装：它属于 `ppt` 预设，不属于宿主组合。这样其它模式的请求前缀里不会出现 PPT 的工具 schema，而 PPT 模式的会话与工作台仍然读写同一份工程。

## 行为

- **目录参数可选**：`dir` 省略时作用于「会话当前打开的工程」；给出时按工作区相对路径解析，越界即拒绝。
- **导入来源**：`ppt_import`、`ppt_prepare_template`、`ppt_import_evidence` 和 `ppt_import_template` 的 `source` 接受本机会话工作区的 `.pptx` 路径，或文件库已登记的本机上传文件绝对路径；其他工作区外文件、远程工作区和超过 8 MiB 的文件均拒绝。源页查证还会复核上传登记；工程输出始终留在工作区。
- **图库图片接入**：已挂载的 `coding-tool-image-gen` 在图像服务可用时提供 `generate_image`、`generate_images`、`edit_image` 等工具；服务不可用时不能生成或编辑图片，已有的同会话图库图片仍可接入。`ppt_attach_gallery_image({imageId,dir?})` 只接受本次会话图库项 ID，不接受附件 ID 或文件路径，也不能使用其他会话的 ID；它将图片复制到当前打开或指定的工程，返回 `media/<file>` 的 `source`，不会更改页面。接入图片与工作台上传共用 8 MiB 和 PNG／JPEG／GIF／WebP 格式校验；SVG 因同源脚本风险不可上传；路径不安全时拒绝写入。调用 `ppt_read` 取得页面 id 与最新版本后，再以 `ppt_edit` 的 `add_element` 添加引用该 `source` 的 `image` 元素；可用 `ppt_render` 预览、`ppt_export` 导出。复制与编辑不是同一次原子操作：编辑冲突或失败可能留下未引用的媒体文件，但不会覆盖工程改动。
- **编辑是原子的**：`ppt_edit` 的 `ops` 要么整体生效，要么整体失败；`base_revision` 与当前版本不符时返回冲突，而不是覆盖别处的改动。
- **元素种类**：文本框、矩形/椭圆、连接线、图片（`media/<file>`）、表格（行 × 列 + 单元格文本）、图表（柱状/折线/饼，分类 + 系列），另有层级调整（`reorder_element`）与复制（`duplicate_element`）。
- **字体与动画**：文本元素可指定 `font` 族名；导出按 `fsType` 许可嵌入字体，结果里的 `fonts`／`skippedFonts` 说明嵌了谁、为什么跳过。元素可带 `animation`（fade/fly/zoom/wipe），页面可带 `transition`（none/fade/push）。
- **导入与补页**：`ppt_import` 和 `ppt_prepare_template` 返回 `dropped`、`sourceSha256` 及逐页 `report`：源页序号、导入页 id、源/导入元素计数、状态、丢失类别和有界文字预览。用 `ppt_read` 对照每页；结构缺失时以同一源文件和哈希调用 `ppt_import_evidence` 分片查证源页 XML 与关联图表缓存，再用 `ppt_edit` 补齐有证据的内容。完整源页证据超过 1 MiB UTF-16 字符会报错，不截断；单片默认 8000、最多 16000 字符，可按 `nextOffset` 续读。源文件变动、消失或上传登记失效会拒绝旧哈希，不猜测缺失数据；源页本来为空可保留，只有图片的页可见却不等于内部文字可编辑，也不是缺页。`no_known_loss` 只表示未发现已知结构丢失，不保证视觉保真。
- **用户模板与新稿**：`ppt_create` 必须给 `title`；`size`、`theme` 均省略时基于内置白底蓝橘六页整稿创建独立可编辑工程，显式传入任一参数则创建单页标题稿，详情见[宿主默认整稿](../ppt-workbench/README.md#默认整稿与内置单页版式)。`ppt_create_from_template` 用 `ppt_templates` 返回的 id 复制用户模板整稿并打开工作台；`title` 缺省为模板名，尺寸和主题来自模板，不接收 `size`、`theme`。用户模板保存完整演示文稿及媒体，与七种内置单页版式及默认整稿都不同；`ppt_save_template` 将当前工程或指定 `dir` 原样另存为新模板，保留已有正文，不改变现稿。远程工作区不能保存或套用本机模板。
- **模板制作与管理**：`ppt_import_template` 从上述本机来源的无宏 `.pptx` 自动提取可编辑结构与视觉风格，把原稿业务正文泛化为可替换占位后存入用户模板库；结果提供源文件名 `sourceName` 和已知设计／结构损失 `dropped`，不创建或切换工程。`ppt_prepare_template` 则把原稿导入为保留正文的可编辑草稿并聚焦工作台、不写模板库；需要人工补齐或精细提炼时，按逐页 `report` 用 `ppt_read` 和同一源文件的 `ppt_import_evidence` 核对设计与缺失内容，`ppt_edit` 泛化正文并补齐有证据的结构，`ppt_check` 后才 `ppt_save_template`，最后以 `ppt_templates` 核实。不要把用户原文直接保存为通用模板、把占位当成源稿事实，或编造无法核实的数字；若减少源页数须说明。`ppt_rename_template` 按 id 改名，`ppt_delete_template` 须传入匹配的 id 与当前名称。导入的复杂图形和主题色不能保证保真，交付前检查预览并报告损失；远程工作区不支持模板导入。
- **失败诊断**：参数、目录、版本与工程内容的问题都以工具错误返回中文原因（例如「找不到页面 "p2"」「工程已被修改：当前版本 4，请求基于 3」），模型据此重读再改。

## 工具面

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `ppt_create` | 新建并切换工作台；省略尺寸和主题用六页整稿，显式指定其一用单页标题稿 | `title` · `dir` · `size` · `theme` |
| `ppt_create_from_template` | 从用户模板新建整稿副本并切换工作台 | `templateId` · `title` · `dir` |
| `ppt_templates` | 列出本机用户模板的 id、页数与导入丢失项 | 无 |
| `ppt_prepare_template` | 将 .pptx 导入工程草稿，返回逐页报告，不写模板库 | `source` · `name` · `dir` |
| `ppt_import_evidence` | 按源页与哈希读取 XML/图表证据片段，默认 8000、最多 16000 字符，可续读 | `source` · `sourceIndex` · `sourceSha256` · `offset` · `limit` |
| `ppt_import_template` | 提取 .pptx 可编辑设计、泛化正文并保存用户模板，返回来源与损失，不打开工程 | `source` · `name` |
| `ppt_save_template` | 将当前或指定工程连同现有正文保存为新模板，不更改工程 | `name` · `dir` |
| `ppt_rename_template` | 修改用户模板的名称 | `id` · `name` |
| `ppt_delete_template` | 按 id 和当前名称确认删除用户模板 | `id` · `name` |
| `ppt_open` | 打开既有工程 | `dir` |
| `ppt_read` | 读整份页面与元素数据 | `dir` |
| `ppt_edit` | 应用 ops（页与元素的增删改、页面属性、文稿属性） | `ops` · `base_revision` · `dir` |
| `ppt_attach_gallery_image` | 从本次会话图库复制图片到工程媒体，返回 `source`；不插入页面 | `imageId` · `dir` |
| `ppt_undo` / `ppt_redo` | 版本前后移动 | `steps` · `dir` |
| `ppt_render` | 渲染页面图：在会话的 Agent 浏览器里打开并落 PNG | `dir` · `pages` |
| `ppt_check` | 规则质检（出界、零尺寸、溢出、对比度、空页、文字密度）；`ai: true` 追加模型审阅 | `dir` · `ai` |
| `ppt_import` | 保留可解析源正文，把本机 `.pptx` 转为工作区工程并返回逐页报告与源文件哈希 | `source` · `dir` · `title` |
| `ppt_export` | 导出 .pptx 或 PDF 到 `export/`（PDF 先渲染每页） | `dir` · `target` · `skip_check` |

## 使用本包

把本行挂进 `ppt` 预设；宿主必须同时装配 `coding-ppt-workbench`（服务名 `pptProjects`），否则调用会返回「PPT project service is not mounted in this deployment」。接入图库图片另需宿主的[图像服务](../../image/image-gen/README.md)；它不要求生图设置已启用，但服务不存在时无法读取图库。PPT 预设也挂载了[图像工具](../../image/tool-image-gen/README.md)，其可用性由生图服务决定。

## 模型体验

### 模型看到什么

工具名字、描述与参数 schema 只在 `ppt` 模式会话的请求前缀里；其它模式看不到它们。工具结果是一行 JSON：工程摘要（目录、标题、版本、页数、能否撤销/重做）、`ppt_read` 的完整页面数据、`ppt_attach_gallery_image` 返回的 `{source}`、`ppt_render` 的页面图片路径、`ppt_check` 的问题列表、导入报告、用户模板元数据或删除确认，或导出的绝对路径与字节数。`ppt_import_template` 的模板摘要带 `sourceName` 和 `dropped` 供模型披露来源及损失，但不把完整 deck、媒体、源文件正文或二进制文件放进模型消息；`ppt_import_evidence` 只返回有界文本片段，源文件内容不可信，不能当作指令。错误同样是工具结果，带具体原因。

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
