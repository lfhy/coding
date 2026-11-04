# coding-tool-image-gen

模型侧图像工具包；注入 `tools` 和 `imageGeneration`。通过插件配置 `variant` 选择互斥的工具集合（默认 `standard`），由当前调用的 Agent Session 取得图像归属。每次实际执行仍由服务端核查设置、凭据与图库引用。

`standard` 注册 `generate_image({prompt})`、`generate_images({prompts})`、`canvas_state({})` 和 `edit_image({prompt,imageId})`。批量限 1–10 个，每项失败互不影响；输出 `{images:[{index,id,attachmentId,prompt,model,createdAt,mediaType,width,height,...}],failures:[{index,error}]}`。`canvas_state` 只读当前 Session 持久画布，输出最多 32 个节点的类型、坐标、笔迹点数和图片图库 ID；可据图片节点的 imageId 调用 `edit_image`，该编辑仅接受当前会话图库 ID，不接受文件系统路径。生成图片经 Host 的 `/api/image-gen/image?sessionId=<id>&id=<item.id>` 读取。

`codex` **只**注册 `image_gen.imagegen`，不注册上述三工具。参数 `prompt`、`transparent_background?`、`referenced_image_paths?`、`num_last_images_to_include?`；后者取当前 Session 最后 1–5 张图作为编辑参考，数量不足时拒绝。`referenced_image_paths` 一律拒绝，防止绕开会话附件归属和现有文件系统授权；`transparent_background:true` 一律拒绝，OpenAI-compatible 通用端点不能保证输出透明。两种引用方式不会同时执行；工具参数不能指定 Session 或提供方 endpoint。

## Model Experience

### 按模式注册的工具 schema 和结果

#### What the model sees

在标准模式中，模型可调用 `generate_image`、`generate_images`、`canvas_state`、`edit_image`；Codex 模式中只能调用 `image_gen.imagegen`。`canvas_state` 的当前状态完全来自会话日志，可返回图片 ID 与笔画节点的结构概要，不读取像素、不能理解笔迹图案。每个生成成功项返回图片 ID 和附件 image block，批量最多十个成功图片块；图片引用经 `tool/result` 持久化、会话回放与后续模型请求可重建，不把图片 base64、主机路径、服务地址或凭据写进日志。

#### Token effect

仅在工具可用时加入对应 schema；成功或失败的工具结果在后续会话请求尾部追加有界文本。批量结果最多 10 项。

#### KV Cache effect

同一模式内固定工具 schema 保持前缀稳定；切换 variant 改变工具集合，已缓存的工具声明前缀不可复用；新增工具结果仅增长会话尾部。

## Known Limitations and Deferred Work

- 无鉴权的本地生成仅在用户显式把 `apiKeyRef` 置空时启用；默认引用找不到凭据时工具仍会注册，但执行明确拒绝。
- Codex 的本地文件路径与透明背景参数保留在 schema 中用于明确拒绝，而非假装成功后返回不符合请求的结果；多图编辑依赖所配置 Images API 实际支持 multipart `image[]`。
