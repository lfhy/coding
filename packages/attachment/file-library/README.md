# coding-file-library

全局受管理文件服务 `ctx.fileLibrary`。上传原件和已准入生成图片的独立副本存于已解析的 `CODING_HOME/files`（未配置时通常为 `~/.coding/files`），元数据使用 `ctx.storageDomain.open` 的 `files` v1 领域、`files` 表；装配层须将该领域路由到独立的 `files.sqlite` SQLite 后端。文件库不取代会话附件：原附件仍由附件服务拥有，图库事件仍由会话日志拥有，复制失败不能撤销这些事实。

## 配置和使用

`root?` 可显式覆盖受管理文件根目录，主要用于隔离测试。根路径含双引号或控制字符时在创建目录前拒绝，以免产生无法通过 `@file` 引用的文件。现有根目录必须是真实目录，不能是符号链接；POSIX 上要求当前用户拥有且不开放组／其他用户权限，新建目录使用 `0700`、文件使用 `0600`。Windows 上 Node 的 mode 不证明继承 ACL 仅当前用户可读，部署时必须保证父目录 ACL 可信。文件分布在 `uploads/` 和 `generated/`，记录只保存相对路径，不向浏览器返回绝对路径。上传名称移除路径前缀和控制字符，仅保留字母、数字、空格、点、下划线和短横线，按 UTF-8 截断到 120 字节并保留安全后缀；上传流须非空且最多 32 MiB，已准入生成图片副本的字节限额由附件提供方控制。文件以独占创建和私有权限写入、同步文件与目录后才提交元数据。失败时仅尝试删除本操作仍拥有的条目；磁盘文件与 SQLite 记录没有跨介质原子提交，进程崩溃可能留下未登记的孤儿文件。

`saveUpload({name,sessionId,stream,verify})` 在读流前和提交记录前调用消费方的异步会话检查，返回 `{record,path}`，其中绝对路径只供本机 Host 使用；Windows 返回路径使用 `/` 分隔符，本机仍可直接读取。上传的 `mediaType` 仅按常见文件扩展名推断，未识别后缀记为 `application/octet-stream`，不是内容验证。`saveGeneratedImage({sessionId,galleryId?,attachmentId,mediaType,data})` 接受 PNG/JPEG/WebP/GIF 已准入字节，返回副本记录；不再次改变动画或图片格式。`getUpload(path)` 仅对真实、已登记的上传文件返回包含安全保存名的记录，否则返回 `undefined`；`isManagedUploadPath(path)` 复用同一检查并返回布尔值。消费方需要用户可见的文件名时使用记录的 `name`，不能从带随机前缀的磁盘路径推断。校验失败抛出 `TypeError`，会话校验及持久层错误原样传播。文件库不提供删除、重命名或本机任意路径导入。

每条记录的 `FileId` 是 UUID 格式的跨包品牌 ID；构造和领域载入均校验 UUID，JSON 仍序列化为普通字符串。`list(offset = 0, limit = 50)` 同步返回 `{items,total,nextOffset?}`，按创建时间倒序、同一时间按 ID 倒序；页长最多 100，非法偏移或页长抛出 `TypeError`。列表是持久元数据索引，不逐项扫描或核对磁盘，因此文件被外部移走后记录仍会显示；分页采用当前内存快照，跨页新增数据可能改变偏移。

## HTTP 接口

只有连接服务的 `requestRejection` 允许、Host 绑定回环、请求来自回环且 Host/Origin 严格同源时，`GET /api/files/list?offset=<n>&limit=<n>` 返回同一分页对象。多余、重复、负数或非整数参数返回 400；只允许 GET。响应不含绝对路径或文件内容，带 `private, no-store` 和 `nosniff`。该路由不提供下载、写入或删除。

## Model Experience

该包不注册模型工具、不注入提示词，也不追加会话事件。文件元数据仅通过显式消费方显示，因而本包没有直接 token 或 KV cache 影响。

## Known Limitations and Deferred Work

- 文件内容没有下载 HTTP 接口；Settings 当前仅能展示元数据列表。
- 元数据和磁盘内容不能跨介质原子提交；孤儿清理、配额和删除策略尚未定义。
- `isManagedUploadPath` 校验登记路径当前仍是普通文件，但不校验内容摘要；同一用户在库目录内替换原件后，PPT 导入和浏览器上传会读取替换后的内容。
