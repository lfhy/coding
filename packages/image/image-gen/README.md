# coding-image-gen

Host 的会话级图像生成/编辑服务。图像二进制必须先经 `ctx.attachments.saveImage` 准入并保存，日志只写不可变附件引用和生成元数据；图库与画布通过 Session 日志回放，持久后端负责磁盘保存。部署同时需要 `sessions`、`attachments`、`credentials`；Web 路由在 `webServer` 与 `connection` 都存在时挂载。该包不自带模型服务，默认关闭。

## 设置与凭据

`image-generation` 设置分节提供 `enabled`（默认 `false`）、`endpoint`（默认空，OpenAI-compatible `/v1` 根地址）、`model`（默认空）、`apiKeyRef`（默认 `IMAGE_GEN_API_KEY`）。只有开关开启、地址和模型非空，且非空凭据引用可在 `coding-credentials` 中解析时服务才可用。`apiKeyRef: ''` 表示本地无鉴权服务，请求不发送 Authorization；设置中从不保存明文密钥。请求开始时锁定同一组配置，并逐次重新读取引用。`endpoint` 仅允许无凭据、query、fragment 的公开 HTTPS 域名或 127.0.0.1／localhost／[::1] 本机回环 HTTP(S)；拒绝私网字面量和外部明文 HTTP，提供方 POST 和同源图片 URL 下载都拒绝跳转。配置面板的可用性不是授权：每次服务操作均重新检查。

`generate` 发 `POST <endpoint>/images/generations` JSON `{model,prompt,n:1,response_format:'b64_json'}`；`edit` 发 `/images/edits` multipart，单图 `image`，多图 `image[]`。返回读取 `data[0].b64_json`，或仅下载与配置端点同 origin 的 `data[0].url`，都限制字节、识别图片签名，交给附件服务做最终图像归一化、格式和像素预算检查。服务不直接读工作区路径或持久保存外部 URL。

## HTTP 接口

只有回环绑定、回环客户端、同源 Host/Origin 且通过 connection.requestRejection 的请求可进入下列端点。URL 的 sessionId 必须属于当前 live Session 或可从持久 Session 读取；写操作必须指向当前 live Session。错误使用 `{error:string}` 与 HTTP 状态，不透出提供方响应、配置 endpoint 或凭据。

- `GET /api/image-gen/state?sessionId=<id>` → `{enabled,available,model}`；available 包括完整配置和密钥可解析性。
- `GET /api/image-gen/gallery?sessionId=<id>` → `{enabled,items}`；enabled 表示当前可生成，禁用后仍可列出旧图。每个 item 包含 `{id,attachmentId,mediaType,bytes,width,height,prompt,model,createdAt,sourceImageId?}`；`id` 是该会话创建事件的序号字符串，跨会话不可互用。
- `GET /api/image-gen/image?sessionId=<id>&id=<item.id>` → 原始图像字节、正确 Content-Type 与 no-store；图库成员归属校验在附件读取之前执行。
- `POST /api/image-gen/generate`，JSON `{sessionId,prompt}` → `{item}`；`POST /api/image-gen/edit`，JSON `{sessionId,prompt,imageId}` → `{item}`，imageId 必须是当前会话图库项。文本上限 4000 字符，操作超时 120 秒。
- `GET /api/image-gen/canvas?sessionId=<id>` → `{revision,state:{version:1,nodes:[]}}`；`PUT` 同 URL，JSON `{revision,state}` → 新快照。传入旧修订返回 409，前端应重新读取。画布 960×640，节点最多 128、单笔最多 2000 点、总共最多 10000 点、body 最多 64 KiB。`stroke` 为 `{id,type:'stroke',points:[{x,y}],width,color:'ink',erase?}`，`image` 为 `{id,type:'image',imageId,x,y,width,height}`；节点坐标、尺寸和 ID 有界，imageId 必须属于同一 Session 图库。禁用图像服务不阻断已有画布/图库读取。

Session 中的 `image-gen/created` 与 `image-gen/canvas` 都是日志事实，不进入模型消息历史。每次保存画布记录完整快照；日志可能随大量编辑增长，持续高频画布历史压缩需由后续会话保留策略解决。

## Model Experience

此服务本身不向模型注册提示词；消费方工具可返回图片 ID 与图库元数据，成功工具结果由工具运行时持久化。

#### KV Cache effect

该服务不组装模型请求；工具结果追加到会话后，后续请求的尾部随之增长，不改变先前请求的前缀。

## Known Limitations and Deferred Work

- 仅实现 OpenAI-compatible generations/edits；透明背景及直接读取工作区路径不提供保真或会话级授权，不能隐式降级。
- 工具消费方在结果中附带持久附件图片块，模型是否能识别其像素取决于当前模型提供方的工具结果图片支持；画廊 HTTP 仅返回元数据和按权限读取图片字节。
- 画布快照需有 live Session 才能写入；冷会话可以读取图库和画布，但需正常恢复会话再修改。
