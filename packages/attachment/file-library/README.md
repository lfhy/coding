# coding-file-library

全局受管理文件服务 `ctx.fileLibrary`。上传原件和已准入生成图片的独立副本存于已解析的 `CODING_HOME/files`（未配置时通常为 `~/.coding/files`），元数据使用 `ctx.storageDomain.open` 的 `files` v1 领域、`files` 表；装配层须将该领域路由到独立的 `files.sqlite` SQLite 后端。文件库不取代会话附件：原附件仍由附件服务拥有，图库事件仍由会话日志拥有，复制失败不能撤销这些事实。

## 配置和使用

`root?` 可显式覆盖受管理文件根目录，主要用于隔离测试。根路径含双引号或控制字符时在创建目录前拒绝，以免产生无法通过 `@file` 引用的文件。现有根目录必须是真实目录，不能是符号链接；POSIX 上要求当前用户拥有且不开放组／其他用户权限，新建目录使用 `0700`、文件使用 `0600`。Windows 上 Node 的 mode 不证明继承 ACL 仅当前用户可读，部署时必须保证父目录 ACL 可信。文件分布在 `uploads/`、`generated/` 和 `exports/`，记录只保存相对路径，不向浏览器返回绝对路径。上传名称移除路径前缀和控制字符，仅保留字母、数字、空格、点、下划线和短横线，按 UTF-8 截断到 120 字节并保留安全后缀；上传流须非空且最多 32 MiB，已准入生成图片副本的字节限额由附件提供方控制。文件以独占创建和私有权限写入、同步文件与目录后才提交元数据。失败时仅尝试删除本操作仍拥有的条目；磁盘文件与 SQLite 记录没有跨介质原子提交，进程崩溃可能留下未登记的孤儿文件。

`saveUpload({name,sessionId,stream,verify})` 在读流前和提交记录前调用消费方的异步会话检查，返回 `{record,path}`，其中绝对路径只供本机 Host 使用；若 Host 装载了 Workspace 注册表，会按会话 cwd 自动记录 `workspaceId`，未分组会话不带该字段。Windows 返回路径使用 `/` 分隔符，本机仍可直接读取。上传的 `mediaType` 仅按常见文件扩展名推断，未识别后缀记为 `application/octet-stream`，不是内容验证。`saveInputImage({sessionId,attachmentId,mediaType,name?,data})` 把已经过附件准入的输入图片复制到 `uploads/` 并返回 `{record,path}`：记录像生成图片副本一样带 `attachmentId`，`name` 缺省时按附件标识生成安全名。它不改变模型可见的附件引用，字节限额仍由附件提供方控制；空数据和非图片媒体类型抛出 `TypeError`。`path` 是本机受管理目录中的绝对路径，只交给 Host 写进模型可见消息，浏览器接口不得转发。`saveGeneratedImage({sessionId,galleryId?,attachmentId,mediaType,data})` 接受 PNG/JPEG/WebP/GIF 已准入字节，返回 `{record,path}`：`record` 是副本记录，`path` 是副本绝对路径，只回给模型工具用于把生成图复制进工程，浏览器接口不得转发；它不再次改变动画或图片格式。`saveExport({name,sessionId,mediaType,data})` 将会话导出成品复制到 `exports/` 并登记为 `kind: export`。`getUpload(path)` 仅对真实、已登记的上传文件返回包含安全保存名的记录，否则返回 `undefined`；`isManagedUploadPath(path)` 复用同一检查并返回布尔值。消费方需要用户可见的文件名时使用记录的 `name`，不能从带随机前缀的磁盘路径推断。校验失败抛出 `TypeError`，会话校验及持久层错误原样传播。文件库不提供删除、重命名或本机任意路径导入。

每条记录的 `FileId` 是 UUID 格式的跨包品牌 ID；构造和领域载入均校验 UUID，JSON 仍序列化为普通字符串。`list(offset = 0, limit = 50, filter?)` 同步返回 `{items,total,nextOffset?}`，支持按 `sessionId`、`workspaceId` 或 `unscoped` 过滤；按创建时间倒序、同一时间按 ID 倒序；页长最多 100，非法偏移或页长抛出 `TypeError`。列表是持久元数据索引，不逐项扫描或核对磁盘，因此文件被外部移走后记录仍会显示；分页采用当前内存快照，跨页新增数据可能改变偏移。

笔记域使用同一根目录下的 `notes/`，不占用 `files` 领域表：`notesTree()` 按名称排序返回目录与 Markdown（`.md`/`.markdown`）文件组成的树，符号链接条目不入树，深度超过 8 层或节点总数超过 4096 时整棵树按 `TypeError` 拒绝；`readNote(path)` 返回全文与毫秒修改时间；`saveNote(path, content, baseMtimeMs?)` 经临时文件原子写入，没有修改时间基准时按需创建中间目录并逐段收紧为 `0700`，带 `baseMtimeMs` 时目标文件和父目录必须仍存在，外部修改或删除均拒绝覆盖；`createNote(name, directory?)` 在指定笔记目录创建空笔记，名称按上传规则净化，缺省补 `.md` 扩展名，同名拒绝；`createNoteDirectory(name, parent?)` 在指定笔记目录下创建真实的私有子目录，同名拒绝；`renameNote(path, name)` 在同一父目录内原子改名且拒绝覆盖；`deleteNote(path)` 删除笔记或空目录，非空目录拒绝且不递归。所有路径只接受笔记根目录内的相对路径，父链经 `realpath` 比对防止符号链接逃出；单篇笔记最多 1 MiB。`noteRecords()` 只登记笔记根目录直属的 Markdown 文件（子目录条目不出现），同一相对路径已由领域表登记时不重复；这些实时记录的 `FileId` 由相对路径的 SHA-1 推导成版本 5 形态的 UUID，同一路径跨重启保持同一 ID，`read(id)` 对这类 ID 直接服务磁盘文件。`listWithNotes(offset, limit, filter)` 把过滤后的领域记录与实时笔记按同一规则合并分页，笔记只出现在 `unscoped` 视图或 `kind: 'note'` 过滤下。`notesRootPath()` 返回笔记根目录的绝对路径，仅供 Host 侧会话工作目录使用，不进入浏览器响应。

## HTTP 接口

只有连接服务的 `requestRejection` 允许、Host 绑定回环、请求来自回环且 Host/Origin 严格同源时，`GET /api/files/list?offset=<n>&limit=<n>` 返回同一分页对象；可选 `sessionId=<id>`、`scope=unscoped`、`category=<image|presentation|document|other>`、`kind=<upload|generated-image|export|note>` 过滤文件。`scope=unscoped` 与 `kind=note` 的列表并入无目录笔记。`GET /api/files/preview?id=<fileId>` 只为已登记的图片返回本地文件字节，供文件管理页预览；文件 ID、媒体类型和同源信任均在 Host 校验，浏览器不接触绝对路径。多余、重复、负数或非整数参数返回 400；只允许 GET。列表响应不含绝对路径，预览带 `private, no-store` 和 `nosniff`。

笔记路由在同一同源信任下：`GET /api/notes/tree` 返回目录树；`GET /api/notes/read?path=<相对路径>` 返回 `{path,content,mtimeMs}`；`POST /api/notes/save` 接受 `{path,content,baseMtimeMs?}` 返回 `{path,mtimeMs}`，外部修改或目标已删除返回 409/404；`POST /api/notes/create` 接受 `{name,directory?}` 返回 `{path}`；`POST /api/notes/create-directory` 接受 `{name,parent?}` 返回 `{path}`；`POST /api/notes/rename` 接受 `{path,name}` 返回改名后的 `{path}`；`DELETE /api/notes/delete` 接受 `{path}`，成功返回 204，非空目录返回 409；`GET /api/notes/cwd` 返回 `{path}` 笔记根目录绝对路径，供会话工作目录使用。请求体为限长 JSON；路径逃逸、非法扩展名与超限内容返回 400 与具体原因。

## Model Experience

该包不注册模型工具、不注入提示词，也不追加会话事件。文件元数据仅通过显式消费方显示，因而本包没有直接 token 或 KV cache 影响。

## Known Limitations and Deferred Work

- 文件管理页只提供图片预览，不提供任意文件下载、写入或删除；无目录笔记进入未分组列表但没有预览，点行不触发打开。
- 笔记列表只登记笔记根目录直属文件；子目录笔记只存在于树，不进入文件管理列表。
- 元数据和磁盘内容不能跨介质原子提交；上传文件的孤儿清理、配额和删除策略尚未定义。
- `isManagedUploadPath` 校验登记路径当前仍是普通文件，但不校验内容摘要；同一用户在库目录内替换原件后，PPT 导入和浏览器上传会读取替换后的内容。
