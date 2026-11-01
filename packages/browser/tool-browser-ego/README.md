# coding-tool-browser-ego

模型侧的 Ego 浏览器工具消费方。需同时挂载 `coding-browser-ego-host`、`coding-tools`、`coding-attachment` 与 `coding-user-approval`；有效沙箱模式由可选的 `coding-sandbox-policy` 按调用会话解析。宿主返回完整工具定义，本包全部登记并把 `ego_*` 名称及说明映射为 `browser_*`，保留参数和输出 JSON Schema，不引入旧浏览器作为回退。函数插件没有公开配置；注册项随插件卸载撤销。

每次调用要求活跃 Agent 和审批服务；带 Remote-SSH marker 的会话在审批前、审批后与调用前均拒绝，不会隐式操作本机浏览器。会话有效沙箱模式为 `danger-full-access` 且审批策略为 `never` 时，常规浏览器操作免于弹窗；其余组合调用 `approval.request`，只接受本次的 `allowed-once`。拒绝、取消、无人应答与权限在等待期间变更均不会调用宿主。审批理由只说明操作与目标 HTTP(S) origin，拒绝在审计记录中包含 URL 路径、查询、表单、文件路径、空间名和脚本。宿主还须按会话隔离浏览器空间并禁止模型选择其它空间；本包不提供跨会话空间能力。

上游脚本、CLI、CDP、HTTP、登录导入、空间管理、上传下载与截图全部登记，参数原样交给 Host；文件路径边界由上游运行时处理，消费方仍保留结果上限、Remote-SSH 拒绝和逐次审批。

截图仅在显式调用 `browser_screenshot` 时读取预期工作区的常规 PNG，并经 `ctx.attachments.saveImage` 持久化后额外返回模型图像块；其它工具不读取模型图片。上游规范结果原样保留，超过 64 KiB UTF-8 JSON 的输出明确失败而不截断破坏 schema；截图原始图片大于 100 MiB 或附件准入失败时整个工具调用失败。调用失败不会直接回显宿主的异常路径和敏感 URL；工具结果仍需由调用方识别失败与状态后再继续动作。

## Model Experience

### 浏览器工具

#### What the model sees

模型看到宿主交付的全部 `browser_*` 原参数 schema；描述中旧工具名替换为新名称，执行结果保持上游规范 JSON。只有显式截图会多一个持久图像块；过大结果与拒绝仅返回可恢复的错误文本。

#### Token effect

所有注册工具的 schema 占用稳定请求 token；结果追加到历史，每次成功的规范 JSON 最多 64 KiB，显式截图额外占一张图片的模型预算。

#### KV Cache effect

工具注册与可见性稳定时，schema 维持可复用前缀；卸载、改变宿主允许的工具集合或模型侧工具遮蔽会改变前缀。执行结果只追加到历史，不回写先前前缀。

## Known Limitations and Deferred Work

- 上游工具全部开放后，脚本、CLI、下载等高风险能力的边界依赖会话审批与上游运行时；只读会话不能借浏览器绕过文件策略的限制由上游截图/下载自行处理，仍建议按会话收紧权限。
- 真实写文件时宿主必须使用禁止符号链接跟随的原子方式；本包的执行前 realpath/lstat 无法单独消除跨进程 TOCTOU 竞争。
- 上游帮助会宣传本产品禁用的脚本与跨会话工具，因此不登记 `browser_help`；页面观测属于页面自身内容，不对其中的文字做命名替换。
