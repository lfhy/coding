# @deepseek-ai/dsh-llm-vision-fallback

本插件在 `agent/request-history` 中处理主模型明确不支持图片输入、而当前会话 surface 包含图片的请求。主模型输入能力未知时不启用降级，由主模型适配器决定是否接受；这是既有未知能力的路由语义。插件只在 `vision-understanding` 设置分节或组合配置中显式提供非空的 `provider` 与 `model` 成对值时工作；否则拒绝已知文本模型的图片请求，原始图片不被丢弃，主模型也不会收到图片。设置通过现有 LLM 路由和凭据提供方生效；目标视觉模型必须针对该精确路由声明 `image` 输入能力，未知能力视为不可用。Host 可读取 `ctx.visionUnderstanding.status().configured` 作为配置存在性判断，它不代表凭据或模型调用已经成功。

`maxImagesPerRequest`（默认 8）、`maxImageBytesPerRequest`（默认 32 MiB）、`maxDescriptionChars`（每图默认 4096 个 UTF-16 字符）、`maxOutputTokens`（默认 1024）、`timeoutMs`（整批默认 60000 毫秒）也属于配置 schema。一次请求先扫描当前 surface 的用户输入与工具结果图片，按数量和附件元数据声明字节数限制整批。每张图片通过所选视觉模型生成非空、有界、纯文本描述；调用没有工具 schema，拒绝工具调用、图片输出、截断及缺失或重复的 finish。视觉模型可以使用自身默认的推理强度：私有 reasoning 分片最多 16 个块、16384 个 UTF-16 字符，读取时有界丢弃，不写入描述事实或主模型请求。每次辅助调用最多接收 2048 个流分片和 16 个最终文本块；超出即拒绝。任一查询、读取、模型或取消失败都阻止主模型请求；成功时先计算全批，再为每个有图片的节点写入一个来源事实和一次单节点 surface replacement，最后等待会话持久化检查点。重复请求只看到无图片的替换节点，不会再次描述。

每次视觉模型调用先将 `vision/request` 写入并 flush：它记录原始节点 seq、单张附件引用、精确系统提示词及版本、模型路由和输出上限；失败或取消仍保留这项请求事实。成功时 `vision/description` 将按顺序关联各请求 seq，并记录原始节点 seq、附件引用、提示词及版本、模型路由和每图描述；替换事件通过 `sourceEventSeqs` 引用原节点与该事实。日志从不保存图片 base64。原始 `user/message`、`tool/result` 仍是人类 transcript 和附件读取的来源；读取人类消息或生成标题的消费方须只选 `surfaceOp: 'append'` 来源事件，不能将带原 `source.kind` 的 replacement 再次视为人类输入；模型历史只读替换后的 surface。设置变更只影响后续请求，已持久化的描述不会重写。多节点提交目前由若干单事件 append 组成：描述计算全成功后才开始写入描述事实与 surface replacement，但存储或同步验证在写入途中失败时，先前节点的替换仍可能留在日志；重试会处理尚有图片的节点。

## 模型体验

每张图片在原位置替换为 `[Image description: ...]` 文本。视觉模型收到一张图片和精确的 `VISION_PROMPT` 系统提示词，且不收到整段会话历史或工具；主模型只收到已提交的最终文本 surface，不收到图像、视觉模型的私有推理或临时内存改写。

#### KV Cache 影响

单节点替换会从该节点位置改变后续请求前缀，因此旧图片前缀无法复用；已描述的节点在后续请求中保持稳定。

## 已知限制与暂缓事项

- 批量跨节点写入没有 Session 多事件事务；单节点 surface replacement 本身由 Session 原子校验和提交。
- 描述按视觉模型输出提供的是有损图片语义，不承诺还原全部可见像素或 OCR 准确率。
