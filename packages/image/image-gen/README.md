# coding-image-gen

Host 的会话级图像生成/编辑服务。图像二进制必须先经 `ctx.attachments.saveImage` 准入并保存，日志只写不可变附件引用和生成元数据；图库与画布通过 Session 日志回放，持久后端负责磁盘保存。部署同时需要 `sessions`、`attachments`、`credentials`；Web 路由在 `webServer` 与 `connection` 都存在时挂载。该包不自带模型服务，默认关闭。

## 设置与凭据

`image-generation` 设置分节提供 `enabled`（默认 `false`）、`endpoint`（默认空，OpenAI-compatible `/v1` 根地址）、`model`（默认空）、`apiKeyRef`（默认 `IMAGE_GEN_API_KEY`）、`maxEditReferences`（默认 10，可为 1 至 10）和 `sizes`（默认空表）。只有开关开启、地址和模型非空，且非空凭据引用可在 `coding-credentials` 中解析时服务才可用。`apiKeyRef: ''` 表示本地无鉴权服务，请求不发送 Authorization；设置中从不保存明文密钥。请求开始时锁定同一组配置，并逐次重新读取引用。`endpoint` 接受任意 HTTP(S) 主机，包括明文 HTTP、私网和单标签主机；拒绝空主机、内嵌凭据、query 与 fragment，提供方 POST 拒绝跳转。`sizes` 与 `maxEditReferences` 属于此设置分节，由配置文件维护，工作台只消费 Host 返回的选项。配置面板的可用性不是授权：每次服务操作均重新检查，使用者应只配置自己信任的服务。

`sizes` 按比例到分辨率档位映射像素尺寸，例如 `{"1:1":{"1K":"1024x1024","2K":"2048x2048"}}`；空表使用上游兼容渠道的 1:1／2:3／3:2 三种 1K 预设。自定义比例取固定集合，档位为 1K／2K／4K，尺寸有边长和总像素预算；工作台只提供表中组合。手动请求的 `size` 必须属于当前表，`quality` 可选 `auto`／`low`／`medium`／`high`；两项在读取附件和调用上游之前验证，模型工具不传入时保持原来的上游默认行为。实际输出可能与请求尺寸不同，以附件宽高为准。

`status()` 是 Host 模式名单与工具注册共用的可用性判定。`watchAvailability()` 在设置来源挂载、卸载、解析值提交，或当前凭据引用更新后通知调用方重读状态；订阅本身不主动通知，调用方应先订阅再读取，撤销函数负责停止通知。环境变量变化不会触发凭据更新事件，实际生成请求仍逐次重新解析凭据并拒绝不可用配置。

图片 URL 可指向任意 HTTP(S) 主机（包括内网及回环），无需预先登记来源；URL 凭据与 fragment 被拒绝。每次跳转独立校验 HTTP(S) URL，最多跟随 3 次；整条下载链限时 15 秒，最终图片受源图片字节限额约束。下载不使用代理或 Bearer 凭据；签名 query 原样请求，不写日志。配置的图片服务因此能让 Host 请求其可达的内网 HTTP(S) 地址，应只向可信服务配置 `endpoint`。`maxEditReferences` 默认 10，可设为 1 至 10；Codex 工具传入的参考图超过此设置时在发请求前报错，不会静默丢图。

`generate` 发 `POST <endpoint>/images/generations` JSON `{model,prompt,n:1,response_format:'b64_json',size?,quality?}`；`edit` 发 `/images/edits` multipart，单图 `image`，多图 `image[]`，并按选择附加 `size`／`quality`。返回读取 `data[0].b64_json`、`data[0].url` 的 base64 图片 data URL，或按上述规则下载 URL；即使服务忽略 `response_format`，也按图片签名识别格式并交给附件服务做最终准入、归一化及像素预算检查。服务不直接读工作区路径或持久保存外部 URL。

## HTTP 接口

只有回环绑定、回环客户端、同源 Host/Origin 且通过 connection.requestRejection 的请求可进入下列端点。URL 的 sessionId 必须属于当前 live Session 或可从持久 Session 读取；写操作必须指向当前 live Session。错误使用 `{error:string}` 与 HTTP 状态，不透出提供方响应、配置 endpoint 或凭据。

- `GET /api/image-gen/state?sessionId=<id>` → `{enabled,available,model,sizes,maxEditReferences}`；available 包括完整配置和密钥可解析性，尺寸表不包含密钥或端点。
- `GET /api/image-gen/gallery?sessionId=<id>` → `{enabled,items}`；enabled 表示当前可生成，禁用后仍可列出旧图。每个 item 包含 `{id,attachmentId,mediaType,bytes,width,height,prompt,model,createdAt,sourceImageId?}`；`id` 是该会话创建事件的序号字符串，跨会话不可互用。
- `GET /api/image-gen/image?sessionId=<id>&id=<item.id>` → 原始图像字节、正确 Content-Type 与 no-store；图库成员归属校验在附件读取之前执行。
- `GET /api/image-gen/inspiration/v1/<hash>.webp` → 随包附带的 320px 灵感缩略图，Content-Type 为 `image/webp`，文件名只接受 16 位十六进制哈希并以 immutable 长期缓存；不接受目录、查询参数或路径穿越。
- `POST /api/image-gen/import?sessionId=<id>` → `{item}`；请求体为单张 PNG/JPEG/WebP/GIF 原始字节，Content-Type 必须匹配。Host 以附件服务的源字节、图像格式、像素和动画限额校验，只有当前 live Session 可导入；禁用生成服务仍可导入并浏览参考图。写入后该图库项可作为编辑来源，不读取本机路径。
- `POST /api/image-gen/generate`，JSON `{sessionId,prompt,size?,quality?}` → `{item}`；`POST /api/image-gen/edit`，JSON `{sessionId,prompt,imageId,size?,quality?}` 或 `{sessionId,prompt,imageIds,size?,quality?}` → `{item}`，`imageId`／`imageIds` 必须属于当前会话图库，二者不可并存；多图需要 `maxEditReferences` 允许。文本上限 4000 字符，操作超时 120 秒。图库项记录请求的 `size?`／`quality?` 供再次生成还原，图片真实宽高由附件服务给出。
- `GET /api/image-gen/canvas?sessionId=<id>` → `{revision,state:{version:1,nodes:[]}}`；`PUT` 同 URL，JSON `{revision,state}` → 新快照。传入旧修订返回 409，前端应重新读取。画布 960×640，节点最多 128、单笔最多 2000 点、总共最多 10000 点、body 最多 64 KiB。`stroke` 为 `{id,type:'stroke',points:[{x,y}],width,color:'ink',erase?}`，`image` 为 `{id,type:'image',imageId,x,y,width,height}`；节点坐标、尺寸和 ID 有界，imageId 必须属于同一 Session 图库。禁用图像服务不阻断已有画布/图库读取。

Session 中的 `image-gen/created` 与 `image-gen/canvas` 都是日志事实，不进入模型消息历史。生成、编辑与参考图导入在附件保存并追加图库记录后等待会话持久化完成，模型工具与 HTTP 入口共用这一保证；持久化失败会拒绝操作，但不回滚已追加的图库记录。从本机上传的参考图经附件服务准入并记录为 `model: 'import'` 的同会话图库项；它不调用模型，之后可用该项 id 调图生图编辑。每次保存画布记录完整快照；日志可能随大量编辑增长，持续高频画布历史压缩需由后续会话保留策略解决。

## Model Experience

此服务本身不向模型注册提示词；消费方工具可返回图片 ID 与图库元数据，成功工具结果由工具运行时持久化。

#### KV Cache effect

该服务不组装模型请求；工具结果追加到会话后，后续请求的尾部随之增长，不改变先前请求的前缀。

## Known Limitations and Deferred Work

- 仅实现 OpenAI-compatible generations/edits；透明背景及直接读取工作区路径不提供保真或会话级授权，不能隐式降级。
- 工具消费方在结果中附带持久附件图片块，模型是否能识别其像素取决于当前模型提供方的工具结果图片支持；画廊 HTTP 仅返回元数据和按权限读取图片字节。
- 画布快照需有 live Session 才能写入；冷会话可以读取图库和画布，但需正常恢复会话再修改。
