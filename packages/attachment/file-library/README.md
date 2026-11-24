# coding-file-library

全局受管理文件服务 `ctx.fileLibrary`。上传原件和已准入生成图片的独立副本存于已解析的 `CODING_HOME/files`（未配置时通常为 `~/.coding/files`），元数据使用 `ctx.storageDomain.open` 的 `files` v1 领域、`files` 表；装配层须将该领域路由到独立的 `files.sqlite` SQLite 后端。文件库不取代会话附件：原附件仍由附件服务拥有，图库事件仍由会话日志拥有，复制失败不能撤销这些事实。

## 配置和使用

`root?` 可显式覆盖受管理文件根目录，主要用于隔离测试。根路径含双引号或控制字符时在创建目录前拒绝，以免产生无法通过 `@file` 引用的文件。现有根目录必须是真实目录，不能是符号链接；POSIX 上要求当前用户拥有且不开放组／其他用户权限，新建目录使用 `0700`、文件使用 `0600`。Windows 上 Node 的 mode 不证明继承 ACL 仅当前用户可读，部署时必须保证父目录 ACL 可信。文件分布在 `uploads/`、`generated/` 和 `exports/`，记录只保存相对路径，不向浏览器返回绝对路径。上传名称移除路径前缀和控制字符，仅保留字母、数字、空格、点、下划线和短横线，按 UTF-8 截断到 120 字节并保留安全后缀；上传流须非空且最多 32 MiB，已准入生成图片副本的字节限额由附件提供方控制。文件以独占创建和私有权限写入、同步文件与目录后才提交元数据。失败时仅尝试删除本操作仍拥有的条目；磁盘文件与 SQLite 记录没有跨介质原子提交，进程崩溃可能留下未登记的孤儿文件。

`saveUpload({name,sessionId,stream,verify})` 在读流前和提交记录前调用消费方的异步会话检查，返回 `{record,path}`，其中绝对路径只供本机 Host 使用；若 Host 装载了 Workspace 注册表，会按会话 cwd 自动记录 `workspaceId`，未分组会话不带该字段。Windows 返回路径使用 `/` 分隔符，本机仍可直接读取。上传的 `mediaType` 仅按常见文件扩展名推断，未识别后缀记为 `application/octet-stream`，不是内容验证。`saveInputImage({sessionId,attachmentId,mediaType,name?,data})` 把已经过附件准入的输入图片复制到 `uploads/` 并返回 `{record,path}`：记录像生成图片副本一样带 `attachmentId`，`name` 缺省时按附件标识生成安全名。它不改变模型可见的附件引用，字节限额仍由附件提供方控制；空数据和非图片媒体类型抛出 `TypeError`。`path` 是本机受管理目录中的绝对路径，只交给 Host 写进模型可见消息，浏览器接口不得转发。`saveGeneratedImage({sessionId,galleryId?,attachmentId,mediaType,data})` 接受 PNG/JPEG/WebP/GIF 已准入字节，返回 `{record,path}`：`record` 是副本记录，`path` 是副本绝对路径，只回给模型工具用于把生成图复制进工程，浏览器接口不得转发；它不再次改变动画或图片格式。`saveExport({name,sessionId,mediaType,data})` 将会话导出成品复制到 `exports/` 并登记为 `kind: export`。`getUpload(path)` 仅对真实、已登记的上传文件返回包含安全保存名的记录，否则返回 `undefined`；`isManagedUploadPath(path)` 复用同一检查并返回布尔值。消费方需要用户可见的文件名时使用记录的 `name`，不能从带随机前缀的磁盘路径推断。校验失败抛出 `TypeError`，会话校验及持久层错误原样传播。文件库不提供笔记域之外的删除或重命名，也不支持导入本机任意路径。

每条记录的 `FileId` 是 UUID 格式的跨包品牌 ID；构造和领域载入均校验 UUID，JSON 仍序列化为普通字符串。`list(offset = 0, limit = 50, filter?)` 同步返回 `{items,total,nextOffset?}`，支持按 `sessionId`、`workspaceId` 或 `unscoped` 过滤；按创建时间倒序、同一时间按 ID 倒序；页长最多 100，非法偏移或页长抛出 `TypeError`。列表是持久元数据索引，不逐项扫描或核对磁盘，因此文件被外部移走后记录仍会显示；分页采用当前内存快照，跨页新增数据可能改变偏移。

## 笔记存储

笔记域使用同一根目录下的 `notes/`，不占用 `files` 领域表。`notesTree()` 按名称排序返回普通目录、真实 Markdown、思维导图和办公笔记文件，以及 `.codingppt` 幻灯片工程目录。`kind: 'mindmap'`、`'word'`、`'excel'` 和 `'deck'` 均不携带 `children`；只有真实文件按思维导图或办公后缀分类，符号链接不入树。幻灯片工程内部不扫描且不计入预算。其余条目（含不展示的文件与链接）共用 4096 个条目预算，目录超过 8 层或超出预算时整棵树按 `TypeError` 拒绝。

`readNote(path)`、`saveNote(path, content, baseMtimeMs?)` 与 `createNote(name, directory?, content?)` 只处理 Markdown，原文最多 1 MiB。保存经临时文件原子替换；无修改时间基准时可创建中间目录并收紧为 `0700`，有基准时不覆盖外部修改或重建已删除文件。新建名称按上传规则净化，缺省补 `.md`（例如 `draft.pptx` 变为 `draft.pptx.md`）；同名或原文超限时拒绝，不留下空文件。`createNoteDirectory(name, parent?)` 独占创建真实私有子目录。

`createNoteDeck(name, directory?)` 只供 Host 的 PPT 服务使用：以 `0700` 独占创建 `.codingppt` 工程目录，同步父目录后返回相对路径与只在仍拥有本次目录时递归清理的句柄。文件库不写工程内容。同名、符号链接、越界路径或层级／条目超限按 `TypeError` 拒绝。

`renameNote(path, name)` 在同一父目录内改名且拒绝覆盖。Markdown、思维导图及办公笔记保留原扩展名及大小写；名称可省略原扩展名，但不能转换格式。`.codingppt` 工程目录同样保留后缀。`deleteNote(path)` 单独删除一个笔记文件，或递归删除一个真实目录（包括幻灯片工程目录）。路径只接受笔记根目录内的相对路径，父链经 `realpath` 核对；条目符号链接不得改名或删除，递归删除不跟随目录内的链接。

`noteRecords()` 只登记笔记根目录直属的 Markdown 文件。同一路径已由领域表登记时不重复；实时记录的 `FileId` 由相对路径的 SHA-1 推导成版本 5 UUID，`read(id)` 对这类 ID 直接服务磁盘文件。`listWithNotes(offset, limit, filter)` 将这些笔记并入未分组或 `kind: 'note'` 视图。另经 `saveExport` 登记的 XLSX 文件按 SpreadsheetML 媒体类型或 `.xlsx` 后缀归入文档。`notesRootPath()` 返回笔记根目录的绝对路径，仅供 Host 侧会话工作目录使用。

### 思维导图笔记

包入口导出 `NOTE_MINDMAP_SUFFIX`（`.codingmindmap`）以及 `MindMapDocument`、`MindMapNode`、`MindMapEdit`、`MindMapSnapshot`。`createNoteMindmap(name, directory?)` 用净化后的文件名（不含后缀）作为中心主题；`importNoteMindmap(name, data, directory?)` 按来源文件名接受 `.codingmindmap` 原生 JSON 或 `.xmind`。两者都将完整文档以 `0600` 暂存并同步，再独占发布并同步父目录，返回 `{path}`。目录参数必须为真实相对目录，不接受符号链接（即使指向笔记根目录内）、幻灯片工程目录或越界路径。不会覆盖同名条目，不会为无效导入留下笔记文件。

原生文档的 `version` 为 `1`，仅包含 `root` 主题树；主题仅含 `id`、`text`、`children`。主题 ID 在文档内唯一，原生导入、移动、改名与重新读取不改变已有主题 ID。原生文件及输入最多 1 MiB，根主题计入最多 400 个主题及 20 层深度，文字最多 256 个 Unicode 码点且不超过 1024 个 UTF-8 字节。XMind 原始文件最多 16 MiB，ZIP 最多 4096 个成员，仅解包根级 `content.json`，实际解压输出最多 2 MiB，并校验长度与 CRC。仅转换首张图的主题文字与层次（含直属和自由主题），不保留格式、链接、附件或其他图页；不读写 ZIP 中的其他成员或路径，不支持只有 `content.xml` 的旧版 XMind。

`readNoteMindmap(path)` 返回 `{path,revision,document}`，`revision` 是原始字节的 SHA-256 摘要，调用方按不透明字符串原样回传。`editNoteMindmap(path, revision, edits)` 与笔记改名和删除使用同一写入队列，在队列内核对基准、按顺序验证和应用整批，再以一次原子替换发布。每批需要 1–32 个 `add`、`rename`、`move` 或 `delete` 操作；拒绝不明字段、未知主题、循环或删除／移动中心主题。`move.index` 按移除原节点后的目标子主题数组计数，从零开始；不传则追加。任一无效操作使整批不落盘。旧版本或重名抛出 `NoteConflictError`，文件或父目录已消失抛出 `NoteNotFoundError`，非法路径、文件结构或操作抛出 `TypeError`。

目录和 Markdown 由 [`src/notes.ts`](src/notes.ts) 持有写入队列；思维导图在 [`src/mindmap-notes.ts`](src/mindmap-notes.ts) 检查文件身份及提交，在 [`src/mindmap.ts`](src/mindmap.ts) 校验主题与编辑，在 [`src/xmind.ts`](src/xmind.ts) 限定解包。

### Word 与 Excel 笔记

包入口导出 `NOTE_WORD_SUFFIX`（`.codingword`）、`NOTE_EXCEL_SUFFIX`（`.codingexcel`）以及 [`OfficeKind`、`OfficeDocument`、`OfficeEdit`、`OfficeSnapshot` 和字段类型](src/types.ts)。`.codingword` 的 `version: 2` 直接保存编辑引擎的完整文档快照（`document.snapshot`），表格、图片、链接与页眉页脚因此都能落盘；`.codingexcel` 仍是结构化的单元格模型。`readWordParagraphs(snapshot)` 与 `hasRichWordContent(snapshot)` 供导出和助手读取段落视图，`buildWordSnapshot(paragraphs)` 供新建与导入生成快照。`createNoteOffice(kind, name, directory?)` 写入空白普通段落或名为 `Sheet1` 的空表。`importNoteOffice(kind, name, bytes, directory?)` 校验 `.docx`／`.xlsx` 的内容与类型，移除名称中的对应源后缀后保存新副本，不存放或改写来源 ZIP。`name` 也可直接给目标名称。两者先写入并同步 `0600` 的临时文件，再独占发布，成功返回 `{path}`；非法导入和同名冲突不会留下半成品。父目录必须已存在，逐段拒绝符号链接、越界路径及幻灯片工程目录。

`readNoteOffice(path)`、`saveNoteOffice(path, revision, document)` 和 `editNoteOffice(path, revision, edits)` 返回 `{path, revision, document}`。版本取自实际磁盘字节的 SHA-256，消费方应按不透明字符串原样回传。保存完整文档和模型整批编辑与改名、删除共用同一写入队列，先核对版本，全部校验成功后才原子替换。每批 1–32 项；`set_cells` 一次最多 256 格，覆盖整格，`value: null` 且无公式或样式时移除该格。Word 段落索引和 Excel 行列坐标从零开始，工作表 ID 在本原生笔记的读写及改名中不变。Word 的整段替换按快照里的段落视图应用；快照含表格、图片等内容时拒绝该批次，避免重建正文丢掉结构。版本失配或笔记同名抛出 `NoteConflictError`，已消失抛出 `NoteNotFoundError`，路径、类型或内容不合规抛出 `TypeError`。

`exportNoteOffice(path, revision?)` 从一次读取的快照另生成 `.docx`／`.xlsx`，返回 `{name, mediaType, bytes}`，不写磁盘、不登记文件；传入版本时必须匹配该快照。导入、导出均在 Host 离线完成。不读取 XML 外部资源，不接受外部关系（包括外部超链接）、宏、嵌入的活动对象或联网字段。Excel 公式不由 Host 执行，仅接受受支持的本地函数及工作簿内引用，拒绝外链、DDE、未知函数和外部连接。

原生 JSON 不设文件大小上限（图片随快照内嵌，体积由用户自己控制）；来源 ZIP 最多 16 MiB、2048 个成员，实际解压累计最多 64 MiB、单成员最多 32 MiB，并核对声明长度及 CRC。Word 最多 10,000 段、50,000 个文字片段、累计 100,000 个换行或制表符，字号 1–400 pt。Excel 最多 32 张表、50,000 个显式单元格和 2048 个不重叠合并区域；每张表行列分别限 100,000 和 1024。单个文字片段或单格文本最多 32,767 个 UTF-16 码元，公式（含 `=`）最多 8192、工作表名最多 31、表 ID 最多 128、数字格式最多 255。磁盘与版本逻辑见 [`src/office-notes.ts`](src/office-notes.ts)，输入预检和转换见 [`src/office/package.ts`](src/office/package.ts)。

## HTTP 接口

只有连接服务的 `requestRejection` 允许、Host 绑定回环、请求来自回环且 Host/Origin 严格同源时，`GET /api/files/list?offset=<n>&limit=<n>` 返回同一分页对象；可选 `sessionId=<id>`、`scope=unscoped`、`category=<image|presentation|document|other>`、`kind=<upload|generated-image|export|note>` 过滤文件。`scope=unscoped` 与 `kind=note` 的列表并入无目录笔记。`GET /api/files/preview?id=<fileId>` 只为已登记的图片返回本地文件字节，供文件管理页预览；文件 ID、媒体类型和同源信任均在 Host 校验，浏览器不接触绝对路径。多余、重复、负数或非整数参数返回 400；只允许 GET。列表响应不含绝对路径，预览带 `private, no-store` 和 `nosniff`。

笔记路由沿用上述同源信任。`GET /api/notes/tree` 返回 `{children}`；`GET /api/notes/read?path=<相对路径>` 只读取 Markdown，返回 `{path,content,mtimeMs}`；`POST /api/notes/save` 只保存 Markdown，接受 `{path,content,baseMtimeMs?}` 返回 `{path,mtimeMs}`，外部修改或目标已删除返回 409/404；`POST /api/notes/create` 只创建 Markdown，接受 `{name,directory?,content?}` 返回 `{path}`；`POST /api/notes/create-directory` 接受 `{name,parent?}` 返回 `{path}`；`POST /api/notes/rename` 接受 `{path,name}` 返回改名后的 `{path}`；`GET /api/notes/cwd` 返回 `{path}` 笔记根目录绝对路径，供会话工作目录使用。`DELETE /api/notes/delete` 接受 `{path}`，成功返回 204。请求体为限长 JSON；路径逃逸、非法扩展名与超限内容返回 400。

思维导图路由不接收会话参数，返回 `Cache-Control: private, no-store`，JSON 响应同时设置 `nosniff`。未通过同源检查返回 403；错误方法返回 405；非法或超限输入返回 400，缺失返回 404，版本冲突或重名返回 409，其他服务错误返回 503。

- `POST /api/notes/mindmap/create`：JSON `{name,directory?}`，成功返回 201 `{path}`。
- `POST /api/notes/mindmap/import?name=<原文件名>&directory=<可选>`：`application/octet-stream` 请求体，按实际接收字节限制大小，成功返回 201 `{path}`。
- `GET /api/notes/mindmap/read?path=<相对路径>`：成功返回 200 `MindMapSnapshot`。
- `POST /api/notes/mindmap/edit`：JSON `{path,revision,edits}`，成功返回 200 `MindMapSnapshot`。

Office 路由位于 `/api/notes/office/`，与其他笔记路由共用回环同源检查，不接收会话参数。成功和错误响应均标记 `private, no-store`。非法请求返回 400，跨源返回 403，缺失返回 404，方法不符返回 405，版本冲突或重名返回 409；其他失败返回不包含本机路径的 500。

- `POST /api/notes/office/create`：JSON `{kind,name,directory?}`，成功返回 201 `{path}`。
- `POST /api/notes/office/import?kind=<word|excel>&name=<文件名>&directory=<可选>`：接收 `application/octet-stream` 原始字节，成功返回 201 `{path}`。
- `GET /api/notes/office/read?path=<相对路径>`：成功返回 200 `OfficeSnapshot`。
- `POST /api/notes/office/save`：JSON `{path,revision,document}`，成功返回 200 `OfficeSnapshot`。
- `GET /api/notes/office/export?path=<相对路径>&revision=<可选>`：成功返回 200 Office ZIP 附件，带对应媒体类型与 UTF-8 文件名。结构化编辑仅通过 Host 服务调用，无 HTTP 编辑路由。

## Model Experience

该包不注册模型工具、不注入提示词，也不追加会话事件。文件元数据仅通过显式消费方显示，因而本包没有直接 token 或 KV cache 影响。

## Known Limitations and Deferred Work

- 文件管理页只提供图片预览，不提供任意文件下载、写入或删除；进入未分组列表的 Markdown 笔记没有预览，点行不触发打开。
- 结构化笔记的编辑队列协调同一 Host 内的请求；对外部写入核对文件身份与磁盘版本，但不是跨进程锁。
- Word 笔记本身保留引擎能表达的全部结构；导出的 `.docx` 会把表格写成 Word 表格、把快照里内嵌的 data URL 图片写成内嵌图片。导入仍然简单：`.docx` 的表格按行转成文本，图片与页眉页脚不保留。当前预设不含绘图插件，编辑器还不能插入图片，因此图片通道暂时只在导入/导出侧就绪。Excel 保留工作表、基本值与样式、本地公式及缓存、合并区域；主题样式、图表、数组公式区域、模拟运算表和日期系统不做无损转换。工作表改名、删除不会自动重写公式。
- 元数据和磁盘内容不能跨介质原子提交；上传文件的孤儿清理、配额和删除策略尚未定义。
- `isManagedUploadPath` 校验登记路径当前仍是普通文件，但不校验内容摘要；同一用户在库目录内替换原件后，PPT 导入和浏览器上传会读取替换后的内容。
