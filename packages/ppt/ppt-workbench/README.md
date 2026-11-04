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

## 版式模板

`add_page` 可以带 `template`（`title`、`section`、`bullets`、`two-column`、`data`、`chart`、`quote`）与 `title`／`bullets`：模板按当前主题与画布铺好文字、色块、表格或图表，元素与手放的完全等价，之后照样能拖能改。面板顶栏的下拉菜单用同一份模板清单。

## 质检与导入

- **`checkDeck`** 在导出前跑确定性规则：元素出界、宽高为 0 是 `error`（阻断导出），文字溢出与文字/底色对比度不足是 `warning`。估算类规则宁可提示也不阻断。
- **`import`** 把工作区里的 .pptx 解包成工程：文本、自动图形、连接线、图片与表格成为可编辑元素，图片落在工程的 `media/` 下；图表、SmartArt 与动画无法表达，随结果以 `dropped` 返回。解析只覆盖模型能表达的子集，遇到不认识的结构跳过。
- **导出**先跑质检，`skipCheck` 可绕过 error 级问题。导出同时按 `fsType` 许可嵌入字体：`0x0000/0x0008` 正常嵌入、`0x0004` 只读嵌入、`0x0002`/`0x0200` 与读不到 OS/2 的字体一律跳过并在结果里报 `skippedFonts`。字体先按工程里实际用到的字符子集化（`subset-font`/harfbuzz），子集化失败才回退整字体；两路都包成 EOT（`.fntdata`，版本 0x00020001、不压缩）。`.ttc` 集合取第一个 face 重建后再走同一条流程。

## 路由

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/ppt/state?sessionId=` | 工程列表、当前工程、待处理的打开请求 |
| `POST /api/ppt/open` | 打开既有工程并设为当前 |
| `POST /api/ppt/create` | 新建工程（标题页） |
| `POST /api/ppt/edit` | 应用一次 ops（可带 `baseRevision`） |
| `POST /api/ppt/undo` / `redo` | 撤销 / 重做 |
| `POST /api/ppt/render` | 渲染页面图（同时在 Agent 浏览器里打开） |
| `POST /api/ppt/check` | 规则质检 |
| `POST /api/ppt/import` | 把工作区里的 .pptx 导入成工程 |
| `POST /api/ppt/export` | 导出 .pptx（默认被 error 级质检拦住，可 `skipCheck`） |
| `GET /api/ppt/media` | 读取工程内图片（原始字节） |
| `POST /api/ppt/upload` | 上传图片到工程 `media/` |
| `POST /api/ppt/ack` | 面板确认已处理打开请求 |

所有 handler 先过连接层的请求栅栏与本机同源检查，再读请求体（上限 512KB）。

## 使用本包

与提供 `sessions`、`webServer`、`connection` 的宿主组合并排挂载；缺少连接服务时不注册路由，所有请求先检查连接信任与本机同源。不要把它挂到按会话组装的 agent 预设里：路由是进程级注册，同一进程重复挂载会因路由重名而失败。模型工具属于 agent plane，见 [`coding-tool-ppt`](../tool-ppt/README.md)。

## 模型体验

无直接贡献。模型看到的工程摘要、错误诊断与导出路径由 [`coding-tool-ppt`](../tool-ppt/README.md) 的工具结果承载；本包只把这些内容算好。

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
