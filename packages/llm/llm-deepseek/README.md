# coding-llm-deepseek

本包为内置 `deepseek-official` 路由提供存量兼容，保留 `llm-deepseek` 配置分节；已保存的模型 ID、凭据、出站设置和首代会话无需迁移。「添加渠道」不提供 DeepSeek 类型，新路由统一由 [coding-llm-pi-ai](../llm-pi-ai/README.md) 处理。

包根入口导出 Cordis 插件约定与 `DeepSeekAdapter`；协议序列化、SSE 解析与分片转换 helper 不属于该根约定。

发行组合设 `legacyOnly: true`：发现旧设置或凭据后，自定义渠道和完成标记一起持久化，成功后由 `llm-pi-ai` 接管 `deepseek-official`。迁移只复制凭据引用；保留旧设置供回退，不覆盖已存在的同 ID 自定义渠道。验证或写入失败、或目标设置只读时继续使用旧适配器。部署仍可显式挂载此适配器。

## 配置

```yaml
- id: llm-deepseek
  name: 'coding-llm-deepseek'
  config:
    channelName: DeepSeek    # 可选；内置渠道的显示名称，最多 64 个字符
    apiKeyEnv: DEEPSEEK_API_KEY  # default; resolved per request via ctx.credentials, then the environment
    baseURL: https://api.deepseek.com # optional; $DEEPSEEK_BASE_URL then the public API when omitted
    api: openai-completions   # 可选；渠道默认协议，省略时使用 Chat Completions
    thinking: enabled        # 可选；为渠道显式开启推理，也适用于通用协议
    reasoningEffort: max     # optional; off | low | high | max — omitted ⇒ highest level of each model
    maxTokens: 256000        # optional positive per-request output cap; this is the default
    streamIdleTimeoutMs: 300000 # optional; positive finite Node timer delay; five-minute default
    maxRequestImageBytes: 20971520 # optional positive integer; 20 MiB base64-payload default
    retryPolicy:             # optional; omission uses normal mode with five retries
      mode: always           # normal | always
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
    defaultContextWindow: 262144 # optional positive-integer fallback; this is the default
    userAgent: Coding/2026.1014.aaaaaa (MacOS 27;arm64) # 可选；本渠道模型请求的 User-Agent，省略用产品默认值
    models:                  # optional; defaults to V4 Flash and V4 Pro
      - id: deepseek-v4-flash
        name: DeepSeek-V4-Flash
      - id: private-vision
        name: Private Vision
        # api: anthropic-messages # 可选；仅在网关支持该格式时覆盖渠道协议
        inputModalities: [text, image]
      - id: private-reasoner
        description: Company-hosted reasoning model
        contextWindow: 512000
        reasoningEfforts: [off, low] # 可选；仅公布并接受这两个档位
```

`channelName` 是内置 DeepSeek 记录的显示名称，省略时为 `DeepSeek`；可使用中文和空格，但不能是空字符串或全空白，最多 64 个字符，显式的 `default` 也是合法名称。名称保存在 `llm-deepseek` 分节，并同步到可配置提供方目录的 `displayName` 与已注册路由的 `name`，因此模型选择器和 `/model` 命令的渠道标签也会更新；名称不进入模型请求，也不改变路由、凭据引用或设置路径。

`api` 是渠道默认的上游请求格式，支持 `openai-completions`、`openai-responses` 和 `anthropic-messages`；可在 `models[].api` 覆盖单个模型。两级均省略时使用 `openai-completions`。实际网关必须支持最终选中的协议。

该插件注册唯一提供方路由 `deepseek-official`，并一同注册解析后的 `retryPolicy`；省略时会解析为 normal 模式并重试五次。请求使用 `provider: deepseek-official` 选择该路由；其 `model` 会作为协议 `model` 字符串原样传递，因此更改 DeepSeek 模型不需要生命周期时注册。省略 `models` 会公布 `deepseek-v4-flash` 和 `deepseek-v4-pro`，两者的上下文窗口均为 1,000,000 token；显式列表会替换这些默认值，`models: []` 则不公布任何模型。在视觉模型端点完成发布前，默认目录不会公布视觉模型，但部署方可以通过 `inputModalities: [text, image]` 主动添加。Catalog 配置项通过 `ctx.llm.listModels('deepseek-official')` 公开给 ACP（Agent Client Protocol）编辑器和 Web 选择器等客户端，但仍只提供建议：未列出模型 id 仍原样传递。省略配置项 name 默认为其 id，省略 `inputModalities` 则表示仅支持 `text`。

支持图片的模型可声明 `inputModalities: [text, image]`；纯文本和未列出的模型在读取凭据、附件或联网前拒绝图片。原生 Chat 通过 `ctx.attachments` 读取并校验用户与工具结果中的 `ImageBlock` 引用，将图片编码为瞬态 `image_url`，不修改持久消息。系统与助手历史不包含图片；工具结果中的图片在仅含字符串的 `tool` 消息后作为单独的 `user` 消息发送。

`maxRequestImageBytes` 限制累计 base64 图片 payload，默认值为 20 MiB，为官方 30 MiB 请求正文限制中的文本、工具和 JSON 分帧保留余量。历史超过上限时，适配器会从最旧图片开始替换为固定模型可见占位文本 `[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]`，直至请求可容纳；被省略的附件不会被读取。附件准入仍负责单图和单消息原始字节数、媒体类型、尺寸与像素限制。

`contextWindow` 对每个已配置模型都可选，不会通过建议 catalog 公开。`ctx.llm.resolveModelInfo('deepseek-official', model).context` 先返回精确模型值，再对不含容量的配置项或未列出原样传递 id 返回 `defaultContextWindow`。适配器默认值为 262,144（256K），与自定义渠道的缺省容量一致；因此，压力敏感插件可以获得由部署决定的容量，不会将模型 selector 视为权威。目录里两个 V4 模型各自声明 1,000,000，不受该回退值影响。为 `deepseek-official` 注册另一个适配器会抛出 `LlmError('DUPLICATE_ADAPTER')`。

`maxTokens` 是适配器为对话请求配置的输出上限，默认值为 256,000。Catalog 配置项可以自带 `maxTokens`，它对该模型胜出；未设置上限的模型或未列出的模型沿用渠道值。确切模型解析会将胜出值公开为 `defaultMaxTokens`；`LlmRuntime` 在写入 `request/header` 前将该值填入 `GenerateOptions.maxTokens`，以便从持久记录重建请求。显式的请求值或 `AgentOptions.maxTokens` 优先。原生 Chat 将上限编码为 `max_tokens`；其他格式按各自协议编码。适配器不会根据 `contextWindow` 自动调低该预算；部署必须配置与上游相容的 `maxTokens`。

部署允许思考时默认公布 `off`、`low`、`high`、`max`。`reasoningEfforts` 限定模型可用的档位；切换上游请求格式只改变编码，不改变模型档位或默认值。`reasoningEffort` 指定部署默认档位；省略时取模型可用的最高档，已配置的值不在模型列表中时取第一档。`agent/request` 可覆盖每步请求值，最终值记录于 `request/header`。

`thinking: disabled` 是部署锁定：它只公布 `off`，并以 `off` 为默认值。省略 `reasoningEffort` 或将其配置为 `off` 均有效；配置 `low`、`high` 或 `max` 会使插件加载失败，直接按请求启用思考也会在网络 I/O 前失败。携带 `GenerateOptions.purpose: 'session-title'` 的请求也会强制禁用思考并省略已解析的推理强度，将有界输出保留给可见标题文本，不改变会话或压缩（compaction）默认值。

## 请求格式与传输

有效协议为 `openai-completions` 时，适配器请求 `/chat/completions` 并使用 DeepSeek 原生编解码，保留 SSE 分帧、思考历史回传、工具调用和用量转换。有效协议为显式配置的 `openai-responses` 或 `anthropic-messages` 时，使用 pi-ai 的通用请求与流转换；代理和标头仍按本渠道逐请求传入，不改进程全局设置；这两种格式拒绝上游重定向，凭据只发送到配置的端点。`GenerateOptions.stop` 仅原生 Chat 支持，其他格式以 `UNSUPPORTED_OPTION` 拒绝。

各协议共用 `streamChannelRequest` 管理流生命周期。`streamIdleTimeoutMs` 限制等待上游的时间（包括初始请求），不计入消费方在分片间花费的时间；原生 Chat 的 SSE 注释会刷新空闲计时，但不会进入 `StreamChunk` 或会话日志。空闲超时终止上游并报 `TIMEOUT`，调用方取消报 `ABORTED`，提前停止消费也会关闭上游。适配器不在单次 `stream()` 内重试；`dsh-llm-retry` 在持久化的 Agent 步骤边界执行渠道策略。

## 动态配置（settings + credentials）

连接事实不在加载时冻结。`resolveAdapterOptions` 是从原始配置到已校验事实的唯一显式 resolve 步骤，适配器经由一个 thunk **每操作重读一次**：base URL、catalog、请求默认值、图片上限、User-Agent 与 idle 预算都在下一次请求生效，进行中的流则保持其起始事实。三个可选 seam 供给该 thunk：

- **`ctx.settings`**——插件用同一份 `Config` schema 注册 `llm-deepseek` namespace，并以其 `cordis.yml` 条目为组合 `base`，因此用户设置文档中的 `llm-deepseek:` 分节可以免重启覆盖任何字段。未挂载 settings 服务时，仅由 entry 配置驱动适配器，行为不变。存活 settings 快照若通过 schema 却违反 schema 之外的约束（重复的 catalog id、无法成立的 thinking／推理强度组合），则保留最后可用事实并记录失败；entry 配置本身仍会使插件加载失败。
- **`ctx.credentials`**——API 密钥按每次 stream 调用解析，取自与端点*同一*份解析后的快照。配置只携带 `apiKeyEnv`，从不携带字面密钥：该引用经凭据 seam 解析，未挂载 seam 时则经受信环境层解析。由于凭据事实与连接事实同行，被 resolver 拒绝的 settings 快照既不贡献自己的端点，也不贡献自己的密钥：整个先前世代继续服务。每个解析出的密钥在使用前都会被校验格式，因此 HTTP 标头无法承载的值会以 `LlmError('INVALID_CREDENTIAL')` 被拒绝，点名失败的入口，但绝不透露密钥的任何部分，而不是以语义不明的 `fetch` `TypeError` 形式浮现。任何地方都没有密钥的请求以 `MISSING_CREDENTIAL` 失败，并点名每个配置入口，同时路由保持注册、catalog 保持可浏览——首次运行的上手流程就是「浏览模型、存入密钥、再次发起提示」，中间无需任何重启。
- **`ctx.attachments`**——图片请求会在请求时解析该服务，因此 Cordis 加载顺序不会冻结可选图片能力。服务缺失时，图片输入以 `UNSUPPORTED_CONTENT` 失败；纯文本调用不依赖该服务。

渠道注册与目录更新使用 pi-ai 的 `registerChannels`。解析后的重试策略或渠道显示名称变化时，原地更新同一适配器实例的注册，使 `ctx.llm.providerRetryPolicy('deepseek-official')` 与 `ctx.llm.listProviders()` 反映生效值，并通知客户端重读模型目录。

该插件还会在可配置提供方目录（`ctx.llm.listConfigurableProviders()`）中声明自己的路由：提供方为 `deepseek-official`，settings namespace 为 `llm-deepseek`，settings path 为空——整个分节就是 profile。目录名称取自生效的 `channelName`，有效 settings 更新会同步该名称；配置界面通过该条目编辑默认渠道。

## 应用归因

每个流式与模型发现请求都使用本渠道分节的 `userAgent`；省略时使用产品默认值（见 [coding-llm](../llm/README.md#模型请求-user-agent)）。渠道值随端点、凭据一起进入每个请求解析出的连接快照，因此对话请求与模型发现永远取同一个已解析值，进行中的请求不会更换标头。写入或加载时按 1–256 个可打印 ASCII 字符校验，首尾空白、控制字符与非 ASCII 字符会被拒绝，被拒绝的值不会生效。在该适配器约定（adapter contract）下，直接 DeepSeek 请求与 OpenAI 兼容 gateway 请求都不会获得提供方特定应用归因标头；OpenRouter 应用归因暂缓到未来的显式 OpenRouter 适配器或模式。`GenerateOptions.purpose` 为 `compaction` 的请求（dsh-compaction-basic 的辅助摘要调用）还会携带 `x-deepseek-harness-compact: 1`，让宿主可以将压缩流量与会话请求分开。

DeepSeek 请求身份独立于应用归因。凭据解析成功后，每个提供方请求都会通过 `x-deepseek-harness-user-id` 携带来自 [`coding-anonymous-user-id`](../../identity/anonymous-user-id/README.md) 的稳定匿名 id；携带 `GenerateOptions.sessionId` 的请求还会通过 `x-deepseek-harness-session-id` 发送该确切值，缺少会话的直接调用则省略会话标头。两个标头都会发送至解析后的 `baseURL`（包括已配置的 gateway），且不会进入请求正文或模型可见内容。

## 协议格式说明

以下规则适用于有效协议为 `openai-completions` 的请求；其他协议遵循通用实现的约定。

- 只支持流式输出（`stream_options.include_usage` 始终开启）。`usage` 可能附着在 finish 分片上，也可能作为尾随的纯 usage 分片到达；转换器会将两者都延迟到 `[DONE]`，因此 `usage` 始终位于 `finish` 之前，`finish` 之后不会出现任何内容。
- `low`、`high`、`max` 会启用思考，并作为同名 `reasoning_effort` 发送；`off` 映射为 `thinking: {type: 'disabled'}`，并省略 `reasoning_effort`。
- 第一个思考模式分片携带 `reasoning_content: ""`，系统会处理它（不会产生多余 reasoning 块）。
- **推理回传规则**：每个携带推理内容的 assistant 轮次都会将 `reasoning_content` 序列化回历史。思考模式在工具调用轮次上必需它；DeepSeek 在其他轮次上会忽略它，而将该对话重新编码转发给其他厂商的网关，要靠对回传原文取哈希来恢复该轮次上游的思考签名。
- 支持图片的 user 消息会保留文本／图片顺序。Tool role 内容仍为字符串；连续工具结果中的图片会用 `Attached image(s) from tool result:` 汇总到随后一条 user 消息。
- Cache 计量：`cacheReadTokens` ← `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`；DeepSeek 不报告 cache-write 指标。

## 错误

原生 Chat 的非 2xx 响应会抛出稳定 code 的 `LlmError`：`AUTH`（401/403）、`QUOTA`（提供方详细信息标识配额、余额或点数耗尽的响应）、`RATE_LIMIT`（其他 429）、`CONTEXT_WINDOW_EXCEEDED`（提供方 code、type 或 message 标识上下文溢出的 400）、`INVALID_REQUEST`（其他 400 和 413）、`SERVER`（5xx），其他情况为 `HTTP_<status>`。其可序列化 `failure` 保留 HTTP 状态，以及有效的正 `Retry-After` 秒数／日期延迟和存在时的 `x-request-id` / `x-deepseek-request-id`。附件读取会保留稳定的附件失败 code，不会变成传输失败。响应前传输失败（DNS、连接被拒绝、TLS、proxy）会抛出命名已配置端点的 `TRANSPORT`，并将原始拒绝作为 `cause`；调用方 abort 抛出 `ABORTED`，仍以 loop 的取消信号为准。协议违例抛出 `STREAM_CLOSED`（没有 `[DONE]`）或 `MALFORMED_RESPONSE`（JSON payload 格式错误）。未知协议 `finish_reason`（例如 `content_filter`、`insufficient_system_resource`）会变为 `finish {kind: 'error', failure}` 分片；已完成流如果使用 `stop`（或缺失）finish 但没有开启内容块，就会变为 `finish {kind: 'error'}`，code 为 `EMPTY_RESPONSE`（默认策略会重试）。

## 模型体验

以下描述原生 Chat 的模型体验；Responses 和 Messages 的编码与回放见 [pi-ai 模型体验](../llm-pi-ai/README.md#模型体验)。

### DeepSeek 请求

#### 模型看到的内容

所选 DeepSeek 模型会收到 harness 系统提示词、消息历史、工具 schema、stop sequence 和调用配置，不含适配器撰写的提示词文本。视觉模型还会通过 base64 data URL 收到保留的 user 与工具结果图片；超出上限的较旧图片由已记录的占位文本表示。之前 assistant 轮次的推理内容会原文回传，无论该轮次是否调用了工具。

#### Token 影响

精确文本与图片 token 输入取决于提供方 tokenization。推理回传会把每个含推理轮次的思维链带入后续请求，丢弃超出上限的图片则避免再次支付这些 token；可用时会报告 cache-read 用量。

#### KV Cache 影响

未更改的已组装前缀，包括确定性编码的保留图片与占位文本，可使用 DeepSeek cache 复用，适配器会在 usage 中报告它。模型路由变更，或任何上游提示词、schema、前缀、历史或图片上限变更，都可能使从首个发生变化的 token 起的复用失效；推理回传会在每个含推理的轮次上追加。

### DeepSeek 响应

#### 模型看到的内容

推理、文本与原始字符串工具参数会转换为 harness 分片，供 loop 记录和组装。

#### Token 影响

生成 token 遵循请求中已记录的推理强度和 `maxTokens`；只有 loop 保留的块会影响后续输入。

#### KV Cache 影响

loop 保留的响应块会追加到下一个请求，并保留其较早可复用前缀；已丢弃块不会影响后续 cache。更改提供方或模型会选择不同 cache 域。

## 出站

渠道级出站保存在 `llm-deepseek` 设置分节的 `outbound` 字段：`direct`（缺省）、`pool`
（内置代理池）或 `custom`（`customUrl` 为 `http://` / `https://` 代理地址）。它在
**设置 → 模型**的 DeepSeek 渠道详情里编辑，随该分节一起保存。

对话请求与模型目录探测都在每次请求时解析一次出站。选择与地址解析使用
`coding-proxy-pool` 的[共享出站契约](../../net/proxy-pool/README.md#共享出站契约)
（`OutboundConfig`／`OutboundConfigSchema`／`resolveOutboundURL`），与联网搜索提供方
共用同一套规则：选择内置代理池时按池自己的出站控制取地址，**池为直连或池服务缺席时
回落直连**；`custom` 只用本渠道保存的地址，不受池规则影响。解析出的代理地址经
`ProxyAgent` 作为 `fetch` 的 `dispatcher` 注入，同一地址复用连接池，不修改进程全局
dispatcher，因此并发请求互不干扰。`custom` 模式缺少合法地址会在设置解析阶段被拒绝。

## 端点探测

`ctx.llm.registerModelDiscovery('llm-deepseek', …)` 通过 pi-ai 的 `queryModelListing` 查询 OpenAI 兼容模型清单，不受对话协议限制。`https://api.deepseek.com` 查询 `/v1/models`；其他基址在原路径后追加 `/models`，已有 `/v1` 时不重复。候选不写入设置，也不代表视觉、推理或对话协议可用。若指定路由，只接受 `deepseek-official`，其他路由报 `INVALID_DISCOVERY`。查询优先使用临时密钥；未提供时，仅在端点与已保存地址相同时读取已存凭据。

读取已保存路由的凭据与每次网络尝试各有十秒上限；超时与传输层失败换连接重试一次，两次都失败才放弃，而端点已经给出的答复（状态码、非 JSON、没有 `data` 数组）不重试——重发只会得到同一结果。失败说明区分两种结局：两次都没响应时报出总时长与尝试次数，连接直接失败时带上 `cause` 链里的底层原因（如 `getaddrinfo ENOTFOUND`、`ECONNREFUSED`、TLS 证书错误），否则界面上只剩一句超时，用户无从判断该查地址、证书还是网络。请求不跟随重定向，回复有四兆字节上限，调用方取消一律呈现为 `ABORTED`。

## 已知限制与暂缓事项

- **settings 的 `models` 列表会整体替换组合列表**：settings 层按字段合并，而数组是单个字段；按条目合并 catalog 需要带键的形状。
- **未映射 `tool_choice`**：它不属于核心词汇（MVP 取舍，与 pi-ai twin 共享）。
- **请求使用原始 `fetch`，而非 `@cordisjs/plugin-http`**：没有共享的拦截配置；渠道级出站
  经逐请求的 undici `dispatcher` 注入实现（见「出站」），暂不引入 HTTP 服务（`TODO(http)`）。
- **会跳过插件添加的内容块类型**：核心文本与支持的图片块会被序列化，空工具输出会以字面 `(no output)` 通过协议发送。
- **图片是仅输入的持久附件**：不支持直接外部 URL、Files API 和 assistant 图片输出。
