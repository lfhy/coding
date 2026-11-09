# coding-ppt-workbench

## 概述

PPT 创作模式的宿主能力：工程存储（`ppt/<工程目录>/deck.json`）、版本与撤销历史、`.pptx` 导出，以及右侧工作台使用的 `/api/ppt/*` 数据通道。提供 Cordis 服务 `pptProjects`，模型工具（[`coding-tool-ppt`](../tool-ppt/README.md)）与浏览器面板（[`coding-client-ui-ppt-workbench`](../../client/ui-ppt-workbench/README.md)）都经它读写同一份工程。

## 磁盘布局

```text
<session cwd>/ppt/<slug>/
  deck.json            { revision, deck }  —— 唯一事实源
  history.json         { cursor, nextRevision, entries[] }  —— 撤销/重做快照
  export/<title>-v<n>.pptx —— 导出产物
```

`deck.json` 先写临时文件再 rename，进程中断不会留下半个 JSON。`history.json` 保存最近 60 个版本；撤销只移动游标，已知的版本号仍然存在，重做因此天然成立。

用户模板库独立于会话工作区，默认位于 Host 用户目录 `resolveDshHome()/ppt-templates/`；宿主配置 `templatesDir` 可指定另一绝对目录。每个模板保存完整 `deck` 与其引用的 `media/` 字节快照，跨会话、本机工作区可复用；保存、套用均不修改模板原稿，套用会在目标工作区新建可编辑工程并打开工作台。模板名称可修改，删除只影响模板库，不删除从中创建的工程。模板写操作由 `ppt` 模式的模型工具调用服务完成；HTTP 只提供目录与预览读取，内置单页版式不写入用户模板库。

模板库最多保存 100 份模板，每份 `template.json` 不超过 8 MiB，连同媒体不超过 100 MiB。读写通过跨进程文件锁串行化；进程中断遗留的 `.catalog.lock` 只应在确认没有持锁进程后由操作者移除。损坏的模板会报告具体条目并停止该次操作，不会静默跳过或绕过校验删除，须先修复对应文件。

## 行为

- **版本与冲突**：每次 `ppt_edit` 生成一个新版本。调用方给出 `baseRevision` 时，与当前版本不一致即返回 409，绝不覆盖别处的改动；工作台与模型工具都走这条规则。
- **串行写入**：同一工程目录的写操作在进程内排队（`withLock`），两次编辑不会交错；跨进程的并发由版本号兜底。
- **工作区边界**：工程目录必须落在会话工作区内，越界路径直接拒绝（`forbidden`）。
- **模型与面板的交接**：模型 `ppt_create` / `ppt_open` 之后，服务将该会话当前工程指向新工程并记录一次打开请求；面板轮询（3 秒）直接采用当前快照，再回执 `ack`，不再次打开工程。
- **导出**：`buildPptx` 在本地生成最小 OPC 包——每页一张 slide，文本、矩形、椭圆与连接线按基准像素换算成 EMU，主题色写进 `theme1.xml`。不依赖 Office、不调用外部进程。
- **错误码**：路由把 `not-found` / `conflict` / `forbidden` / `bad-request` 映射成 404 / 409 / 403 / 400；模型工具看到的是同一批中文诊断。

## 页面渲染与预览

`render` 把每页写成自包含 HTML（`.render/slide-N.html`），再交给**这个会话自己的 Agent 浏览器**打开并截图：页面进会话正常空间，所以右侧「Agent 浏览器」标签会像别的页面一样显示它；截图与页面共用同一个标签，产物落在 `render/slide-N-v<rev>.png`。浏览器机制归 `coding-browser-ego-host`，本包只经 `ctx.get('egoBrowser').captureSessionPage` 调用，没有浏览器提供方时明确报错而不是假装渲染成功。视口按画布尺寸固定（16:9 = 1280×720），保证像素与工作台一致。

`exportPdf` 复用同一批 PNG：解 PNG（8 位非隔行，Chromium 截图即此形态）→ 重新 Flate 压缩 → 写成一页一图的最小 PDF（960×540 pt），不引入 PDF 库。

## 默认整稿与内置单页版式

`create` 只给 `title`（可选 `dir`）时，新建白底蓝橘的 16:9 六页可编辑整稿，依次为封面、核心观点、双栏对比、分步说明、数据聚焦、结论与下一步。封面以左侧文字为主：眉题在 (95,179)、72px 标题在 (94,231)，通栏深色细线在 y=414，副题在其下方，没有竖色条或短装饰线。正文固定眉题 (95,55)、44px 左对齐标题 (94,81)、通栏细线 y=150；内容从 y≈195 起排，页脚在 y=667，色块仅用于浅灰内容提示。每次创建独立页面和元素，不随包分发源 `.pptx`，也不带源稿正文或讲者备注。显式传入任一 `size` 或 `theme` 时走原有的单页标题稿创建路径。工作台创建与 `ppt_create` 共用 `create`；`GET /api/ppt/templates/default` 只读返回整稿预览，不写工程或模板库。与用户模板的保存和套用不同，这份默认整稿由宿主内置生成。

`add_page` 可以带 `template`（`title`、`section`、`bullets`、`two-column`、`data`、`chart`、`quote`）与 `title`／`bullets`：七种内置版式只向当前工程添加单页，按当前主题铺好可编辑元素；它们不是用户模板库中的整份演示文稿。面板顶栏的新增页面菜单使用同一份版式清单；`GET /api/ppt/templates/builtins` 以只读 `deck` 返回这七页 16:9／paper 版式的真实预览，不创建工程。

## 质检与导入

- **`checkDeck`** 在导出前跑确定性规则：元素出界、宽高为 0 是 `error`（阻断导出），文字溢出与文字/底色对比度不足是 `warning`。估算类规则宁可提示也不阻断。
- **`import`** 把本机会话工作区中的 `.pptx` 或文件库已登记的本机上传 `.pptx` 绝对路径解包成工作区工程；工作区外的其他来源一律拒绝，文件大小上限为 8 MiB，远程工作区不支持。保留可解析的源稿正文；文本、自动图形、连接线、图片与表格成为可编辑元素，图片落在工程的 `media/` 下；图表、SmartArt 与动画无法表达，随结果以 `dropped` 返回。结果还含 `sourceSha256` 与逐页 `report`，对照源页序号和导入页 id 记录结构计数、`losses`、有界 `textPreview`、`truncated` 与状态：`empty_import` 为有源对象但导入页无元素，`partial` 为已知结构损失，`image_only` 为可见图片但内部不一定可编辑，`empty_source` 为源页为空，`no_known_loss` 仅表示没有发现已知结构损失，不保证视觉保真。
- **源页查证**：`importEvidence` 只读取同一工作区或已登记本机上传源文件中指定页的 XML 与关联图表缓存 JSON 文本，按字符偏移分片返回 `content`、`totalChars`、`nextOffset`；完整源页 JSON 超过 1 MiB UTF-16 字符即报错，不截断，单片默认 8000、最多 16000 字符。调用方须传入导入结果的 `sourceSha256`，每次读取都校验源文件哈希和上传登记，源文件变动、消失或登记失效即拒绝，不能用别的版本补页。源文件内容不可信，不作为指令；证据不足时不得编造数值或把占位内容当作修复。
- **用户模板导入**从本机工作区或文件库已登记的本机上传绝对路径读取不超过 8 MiB 的无宏 `.pptx`，提取可表达的页面结构与配色、字体层级、布局等设计信息，将业务正文泛化为可替换的占位文字后保存到本机用户模板库；不保存源 `.pptx`，不创建或切换当前工程。返回的模板摘要包含源文件名 `sourceName` 与已知设计／结构损失 `dropped`，不能把损失报告理解为视觉保真承诺。`ppt_prepare_template` 则只创建保留原文的可编辑草稿，供人工逐页检查和补齐，不写模板库；`ppt_save_template` 保存当前或指定工程的完整内容与媒体，不清除已有正文。复杂图形、母版、主题色、SmartArt、图表与动画可能丢失或变样，须查看模板预览并人工确认后再套用；旧 `.ppt`、`.potx`、`.pptm` 与远程工作区模板导入不支持。文件类型、大小、压缩包结构或工程内容不合法时拒绝，不生成半成品模板。
- **用户模板管理**在本机 Host 上执行。远程工作区可管理本机模板库，但不能把远端工程保存成模板，也不能向远端工作区套用模板；这两种请求明确拒绝，不回退为本机工程。
- **导出**先跑质检，`skipCheck` 可绕过 error 级问题。导出同时按 `fsType` 许可嵌入字体：`0x0000/0x0008` 正常嵌入、`0x0004` 只读嵌入、`0x0002`/`0x0200` 与读不到 OS/2 的字体一律跳过并在结果里报 `skippedFonts`。字体先按工程里实际用到的字符子集化（`subset-font`/harfbuzz），子集化失败才回退整字体；两路都包成 EOT（`.fntdata`，版本 0x00020001、不压缩）。`.ttc` 集合取第一个 face 重建后再走同一条流程。

## 路由

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/ppt/state?sessionId=` | 工程列表、当前工程、待处理的打开请求 |
| `POST /api/ppt/open` | 打开既有工程并设为当前 |
| `POST /api/ppt/create` | 新建工程（省略尺寸和主题为默认整稿，显式指定其一为单页） |
| `POST /api/ppt/edit` | 应用一次 ops（可带 `baseRevision`） |
| `POST /api/ppt/undo` / `redo` | 撤销 / 重做 |
| `POST /api/ppt/render` | 渲染页面图（同时在 Agent 浏览器里打开） |
| `POST /api/ppt/check` | 规则质检 |
| `POST /api/ppt/import` | 把工作区或已登记本机上传的 `.pptx` 导入成工作区工程 |
| `POST /api/ppt/export` | 导出 .pptx（默认被 error 级质检拦住，可 `skipCheck`） |
| `GET /api/ppt/media` | 读取工程内图片（原始字节） |
| `POST /api/ppt/upload` | 上传图片到工程 `media/` |
| `POST /api/ppt/ack` | 面板确认已处理打开请求 |
| `GET /api/ppt/templates` | 列出本机用户模板摘要 |
| `GET /api/ppt/templates/builtins` | 只读返回 `{ ok: true, deck }`，供七种内置版式预览 |
| `GET /api/ppt/templates/default` | 只读返回 `{ ok: true, deck }`，供六页默认整稿预览 |
| `GET /api/ppt/templates/detail?id=` | 读取模板详情与完整 deck，供第一页预览 |
| `GET /api/ppt/templates/media?id=&path=` | 读取模板实际引用的栅格图片原始字节 |

所有 handler 先过连接层的请求检查与本机同源检查；模板媒体只读取 deck 实际引用的栅格图片，以 `nosniff` 和 `no-store` 响应。JSON 请求体上限为 16 MiB。模板导入通过模型工具从本机工作区或已登记的本机上传文件读取源文件，另受 8 MiB 上限和解包预算约束。

## 使用本包

与提供 `sessions`、`webServer`、`connection` 的宿主组合并排挂载；缺少连接服务时不注册路由，所有请求先检查连接信任与本机同源。不要把它挂到按会话组装的 agent 预设里：路由是进程级注册，同一进程重复挂载会因路由重名而失败。模型工具属于 agent plane，见 [`coding-tool-ppt`](../tool-ppt/README.md)。

## 模型体验

无直接贡献。模型经 [`coding-tool-ppt`](../tool-ppt/README.md) 的 `ppt_import_template` 直接提取模板设计、泛化正文并保存，经 `ppt_templates` 得到来源文件名与已知设计损失；需要人工精修时再用 `ppt_prepare_template` 取得保留源文的草稿、完成泛化后以 `ppt_save_template` 保存，或用 `ppt_create_from_template` 套用模板。本包只提供服务与存储，模板目录与保存结果不把完整 deck 或媒体字节放进模型消息。

#### KV Cache 影响

无；本包不组装也不发送提供方请求。

## 已知限制与暂缓工作

- 导出不写母版设计；页面转场只有 `none`／`fade`／`push` 三档；元素动画支持入场（fade／fly／zoom／wipe）、强调（pulse／grow）、退场（同上四种）与上／下／左／右四种相对路径。
- 字体嵌入只认 glyf 轮廓的 TrueType（`.ttf` 与 `.ttc` 的第一个 face）；CFF/OTF 会被跳过并报 `skippedFonts`。
- 子集化保留用到的字符与子集器默认的保留集合；如果某字体子集化失败，回退整字体并让 .pptx 变大。
- 图表支持柱状、折线、饼图，可堆叠、可挂次坐标轴、可把后续系列画成折线组成组合图；没有数据表视图与三维图表。
- PDF 每页是一张位图：文字不可选、不嵌入字体，页数多时文件比 .pptx 大。
- 导入只覆盖模型能表达的子集：图表、SmartArt、OLE、动画与复杂母版版式不会带过来，复杂表格会退化成纯文本网格。
- 图片按原字节嵌入，不压缩也不裁剪；大图会直接撑大 .pptx。
- 版本历史是整份工程的快照，不是增量补丁；工程很大时磁盘占用随版本数线性增长（上限 60 个版本）。
- 多进程同时改同一工程只靠 `baseRevision` 拒绝，不做文件锁。
