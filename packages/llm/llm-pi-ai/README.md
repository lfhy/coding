# coding-llm-pi-ai

基于 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) 的 harness LLM（大语言模型）seam 通用多提供方适配器。一个插件实例拥有一份以路由为键的提供方 profile 字典；每个请求使用 `GenerateOptions.provider` 选择 profile，并针对该路由已配置的 catalog 解析 `GenerateOptions.model`。点名了已安装 pi-ai 提供方的路由会继承其端点、协议格式（wire format）与模型 catalog 作为默认值，并逐字段覆盖；省略渠道级 `api` 时，已安装 catalog 路由仍按各模型自身协议继承，pi-ai 未提供的手工声明路由则默认使用 `openai-completions`（OpenAI Chat Completions）；显式渠道级 `api` 可覆盖相应的协议选择，因此接入 OpenAI 兼容网关、自建服务，或比已安装 catalog 更新的提供方，都属于配置而非改代码。

「添加渠道」只创建 `llm-pi-ai.providers` 下的通用路由，不增加 [DeepSeek 兼容记录](../llm-deepseek/README.md)；该记录仍由原配置分节维护。

包根入口导出 Cordis 插件约定、`PiAiAdapter`、协议流工厂 `configuredProtocolStreams`、返回具体协议标识的 `supportedProtocols()`，以及通用请求入口 `streamPiAiRequest`。两套适配器共用 `registerChannels` 管理渠道注册、`streamChannelRequest` 管理流生命周期、`queryModelListing` 获取 OpenAI 兼容模型清单。DeepSeek 的 Responses 和 Messages 复用通用请求，按请求传入代理和标头，不改全局 HTTP 设置。各适配器仍负责自身的设置、凭据和清单地址；profile 解析、目录与协议的内部转换不对外导出。

## 配置

按提供方配置凭据、模型 catalog 与部署特定传输设置，并以提供方路由本身为键。每个 profile 都可以设置 `retryPolicy`；省略时使用 normal 模式并重试五次。`apiKeyEnv` 是按请求解析的凭据*引用*，因此机密不进入该文件。一条凭据服务该路由下的全部模型。省略它时，直连的 catalog 路由保留 pi-ai 的提供方原生认证；使用代理时，请用 `apiKeyEnv` 指定所需凭据，渠道不会调用原生认证实现。已配置却解析不出值的引用会以 `MISSING_CREDENTIAL` 失败，不用环境中恰好存在的其他密钥替代。

```yaml
- id: llm
  name: 'coding-llm-pi-ai'
  config:
    providers:
      # Catalog route: endpoint, protocol, and models all come from pi-ai.
      openai:
        apiKeyEnv: OPENAI_API_KEY
        baseURL: https://proxy.example.com:8443
        reasoning: max
        retryPolicy:
          mode: normal
          maxRetries: 3
          backoff:
            initialDelayMs: 500
            maxDelayMs: 10000
            jitterRatio: 0.1
      # Catalog route with its catalog narrowed to one model and that model's
      # capacity corrected; every unset field still comes from the catalog.
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
        streamIdleTimeoutMs: 300000
        models:
          - id: claude-sonnet-4-5
            contextWindow: 200000
      # Catalog route with one model reshaped in place; the rest of the
      # catalog keeps serving (a models list would replace it instead).
      deepseek:
        apiKeyEnv: DEEPSEEK_API_KEY
        modelOverrides:
          deepseek-v4-pro:
            api: openai-completions
            reasoningEfforts:
              off:
              high: high
      # 手工声明路由：省略 api 时默认使用 OpenAI Chat Completions；仅在选择其他协议时填写。
      acme-gateway:
        displayName: Acme Gateway
        apiKeyEnv: ACME_GATEWAY_API_KEY
        baseURL: https://gateway.acme.example/v1
        # Request shape for an endpoint whose URL pi-ai cannot recognize; it
        # would otherwise be addressed as though it were OpenAI itself.
        compat:
          thinkingFormat: deepseek
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: acme-large
            name: Acme Large
            contextWindow: 65536
            maxTokens: 4096
          - id: acme-think
            name: Acme Think
            api: openai-responses
            contextWindow: 262144
            maxTokens: 32768
            # key = selectable level, value = its wire spelling; only off may
            # leave the value empty (supported, send nothing).
            reasoningEfforts:
              off:
              high: high
              max: ultra
```

字典形状使重复路由无法表示，发布前的数组形状（每个 profile 携带 `provider` 字段）会加载失败并给出迁移指引。`providers` 也可以为空或整体省略：适配器将以**休眠**姿态挂载——零路由、模型选择器不多一条——一旦 `llm-pi-ai:` settings 分节提供了 profile 就即时注册路由，分节清空时随之撤销。无论是否休眠，插件都会在可配置提供方目录（`ctx.llm.listConfigurableProviders()`，settings 路径 `providers.<provider>`）中声明每个已安装 catalog 提供方，并与当前 profile 声明的每条路由取并集，因此配置界面既能在任何路由存在之前就提供完整 catalog，也能寻址一条手工声明的路由。每个条目都带上 `declared`：pi-ai 在这个键下是否什么都没有。它跟随已安装 catalog 而非设置文档，因为收窄一个内置提供方的模型同样会存下 profile，而那条路由仍然是 pi-ai 认识的——只有适配器分得清两者，所以由目录直接给出答案，而不是留给界面去猜。哪些适配器存在归组合面；哪些提供方在运行可以完全交给用户的设置文档。向 `ctx.llm` 注册具有原子性：如果与另一适配器已拥有的任何提供方路由冲突，插件会加载失败，不注册剩余路由。模型 id 不是生命周期配置；路由未配置的模型会在发起任何提供方请求前以 `LlmError('UNKNOWN_MODEL')` 失败。

### 渠道出站

`providers.<渠道>.outbound` 使用 [代理池的出站配置](../../net/proxy-pool/README.md)：`{ mode: direct }`（默认）直连；`{ mode: custom, customUrl: http://proxy.example:8080 }` 通过该渠道的 HTTP(S) 代理；`{ mode: pool }` 每次请求读取内置代理池的有效规则。池的规则明确为直连时才直连；池未装配或代理连接失败时不改走直连。配置变更只影响之后发起的对话和模型发现。

代理渠道限 `openai-completions`、`openai-responses` 与 `anthropic-messages`，`transport` 须省略或设为 `sse`；WebSocket、自动选择传输及其他协议在配置校验时拒绝。代理渠道使用已验证的协议实现，不运行提供方原生 OAuth、凭据刷新等认证路径。上述三种协议的对话请求（含直连）均拒绝 HTTP 重定向，以免把渠道标头发往其他端点。模型发现沿用已保存路由的出站选择；没有已保存路由的草稿直连。

## Catalog 解析

profile 的 `models` 列表是*替换*该路由已安装 catalog，而不是扩充它；省略它（或留空）则原样服务该 catalog。每个条目都会从同 `id` 的已安装模型继承自身未设置的字段，因此把 catalog 路由收窄到两个模型、更正某个容量，或加入一个比已安装 catalog 更新的模型，都是一行编辑——但一旦声明了 `models` 列表，该路由要继续服务的每个模型就都必须出现在其中，条目哪怕只写一个 `id` 也足够。可配置的条目字段是 `id`、`name`、`api`、`contextWindow`、`maxTokens`、`input`、`reasoningEfforts` 与 `compat`。定价沿用已安装条目或使用默认值；`input` 决定图片准入与视觉理解降级，解析顺序见下文。

`modelOverrides` 无需这份代价就能就地重塑单个已安装 catalog 模型：每个键是一个 catalog 模型 id，每个值可写 `models` 条目接受的同一批字段，只是 id 落在键上，而 catalog 的其余部分原样继续服务。一条覆盖会成为该 catalog 条目的配置，因此协议、容量、模态、档位与 compat 沿与 `models` 条目相同的路径解析。覆盖只在正服务自身 catalog 的 catalog 路由上才有意义：与 `models` 列表并存、落在手工声明路由上，或点名 catalog 未描述模型，都会被拒绝而非跳过。

模型条目的 `api` 可覆盖该模型的上游协议；已安装 catalog 路由省略模型级和渠道级 `api` 时，按已安装 catalog 中同 id 模型的协议，或该路由 catalog 模型共有的协议继承；pi-ai 未提供的手工声明路由省略渠道级 `api` 时，默认使用 `openai-completions`（OpenAI Chat Completions）。显式渠道级 `api` 可统一改指其全部模型，模型级 `api` 优先并可让同一渠道的模型各自选择协议，共用该渠道的 `baseURL` 和凭据；`compat` 按每个模型最终选定的协议校验。

### 按模型的推理（reasoning）档位

`reasoningEfforts` 声明模型可选的思考级别：每个键是选择器提供的一个档位，其值是分派在协议中发送的拼写，因此 `high: high` 原样透传规范名称，而 `max: ultra` 则为使用自有词汇的网关改名。键取自 pi-ai 的档位集合（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）；未声明的档位不会被提供。省略该字段会保留已安装 catalog 条目的能力（手工声明的模型没有这份能力，也不推理）；`false` 声明一个不具备推理能力的模型，profile 正是以此从其网关无法服务的 catalog 模型上剥除推理；空声明会被拒绝，而不是在这两种含义之间去猜。

`defaultReasoningEffort` 指定模型首选档位，模型不提供该档位时回到渠道或模型默认。`completionsThinkingFormat` 只调整 Chat Completions 的请求编码，不影响可选档位，也不会阻止切换到 Responses 或 Messages。旧 DeepSeek 渠道迁入时会保留各模型的档位和默认值；迁移完成标记 `migratedDeepSeek` 与渠道一同写入，不应随渠道删除。

该声明会转换为 pi-ai 的 `Model.reasoning` + `thinkingLevelMap`，其中每个档位都被显式决定——未声明的档位一律固定为不支持，而不是留给 pi-ai 自己的默认规则：那套规则并不对称（键缺席对五个基础档位意味着「支持」，对 `xhigh`/`max` 却意味着「不支持」），也本不该要求 profile 作者了解。`off` 是唯一的三态键：不写它，选择器不提供 Off，显式请求 Off 会被拒绝——不点名任何档位的请求仍会在不带该参数的情况下发出，提供方随后做什么是它自己的默认行为；声明而不给值（`off:`），则会提供 Off，选中它时什么也不发送——对 `deepseek` 方言则是一个显式的 `thinking: {type: "disabled"}`——这同时覆盖完全不点名任何档位的请求；声明并给值（`off: none`），该值就会作为档位参数在协议中发送。没有任何写法能把 catalog 映射中的键恢复为「未设置」：这份声明就是对外提供的全部，因此把你要保留的 catalog 档位重述出来。

### 协议兼容开关

pi-ai 依据提供方 id 与 baseURL 决定每个请求的形状：系统提示词由哪个角色承载、输出上限写在哪个字段、思考级别如何传输。私有网关的 URL 什么也说明不了，而对于 pi-ai 无法识别的端点，其检测会当作 OpenAI 本身来回答——推理模型的系统提示词以 `developer` 发出、输出上限写作 `max_completion_tokens`、思考级别只发一个裸的 `reasoning_effort`——而多数 OpenAI 兼容网关至少会拒绝其中之一。因此 `compat` 既可配置在路由上（作为其模型的默认值），也可按模型配置（逐字段胜出），解析顺序为模型 → 路由 → 已安装 catalog 条目 → pi-ai 自身的检测；路由级开关会为每个读取它的模型遮蔽 catalog 条目的值，而且除了重述其值，没有任何写法能把某个字段交还给 catalog。

每个开关归属于其 pi-ai compat 类型声明了它的那些协议，且归组依据是 compat **类型**而非协议名：三个 Responses 协议（`openai-responses`、`azure-openai-responses`、`openai-codex-responses`）共用同一个 compat 类型，因此可设在其中之一的开关，三者皆可设。`supportsDeveloperRole` 可设在 `openai-completions` 与这三者上；`supportsOpenAIGrammarTools` 只可设在这三个 Responses 协议上；`thinkingFormat` 只能设在 `openai-completions`；`supportsTemperature` 只能设在 `anthropic-messages`；`supportsStrictMode` 还可达 `bedrock-converse-stream`。模型级开关若其协议并不接受，解析失败并点名该协议实际提供哪些开关；路由级开关则落在读取它的模型上、跳过其余模型，只有当路由上没有任何模型能读取它时才被拒绝。

三类键会被拒绝而非丢弃：没有任何协议声明的键（笔误）；pi-ai 已安装 catalog 为具名厂商掌管的键（`openRouterRouting`、`zaiToolStream`、`deferredToolsMode`、`sessionAffinityFormat`、`supportsToolSearch`、`supportsExplicitPromptCacheMode`、`supportsToolReferences`、`vercelGatewayRouting`、`sendSessionAffinityHeaders`）——需要某厂商专属开关的路由，本就是一条应当以该厂商命名的 catalog 路由；以及完全没有写值的键（`supportsDeveloperRole:`），schemastery 会把它放行为 null，若照单收下就会用空值替换已安装 catalog 的值。开放集由漂移门禁钉在 pi-ai 的四个 compat 类型上，承载它们的协议集派生自 `Model.compat` 本身，每个字段的类型也派生自上游而非重述，因此上游新增字段、给别的协议加上 compat 类型、或拓宽某个值并集，都会使构建失败，直到有人为它做出分类。

条目与已安装 catalog 都没有给出尺寸的模型，会采用该路由的 `defaultContextWindow`（262,144）与 `defaultMaxTokens`（32,768），因此一份只公布 id 的列表同样能产出可服务的路由。两个回退值本质上都是猜测，这正是它们作为路由字段、供网关服务更小模型的部署一次性更正的原因，而不是埋在适配器里的常量；回退值只用于给模型定尺寸，绝不会变成单次请求上限。

请求模态的解析顺序是：条目的 `input` → 已安装 catalog 条目 → 路由的 `defaultInput`（默认 `[text]`），与上面两个容量字段的顺序和「回退值」定位完全一致。因此 catalog 模型保留 catalog 为它记录的模态，更窄的路由默认值也绝不会把它剥掉；而**未被 catalog 描述的**模型全都接受图片的网关，只需在路由上写一次 `[text, image]`，不必逐条目写。条目的空列表与缺省同义——它描述的是一个什么都不接受的模型，因此不作答，解析继续往下走——这正是当 `models` 条目点到某个 catalog 模型却不声明模态时，该模型仍保留 catalog 自有模态的原因。路由的那个则不得为空，因为它下面已经没有可以代为作答的层级。

`[text]` 是保守的默认声明，而不是端点能力的验真；容量回退值同样需要部署方按实际模型校正。模型未声明图片能力时，只有显式配置了具备图片能力的[视觉理解路由](../llm-vision-fallback/README.md)，含图会话才能经图片描述交给该纯文本模型；未配置则拒绝，视觉描述失败也不会发出主请求。反过来，多声明 `image` 会让图片直接交给提供方；若端点拒绝，已持久化的原始图片仍在会话日志中，单纯重试同一路由会重复失败。

路由完全无法服务时解析仍会失败得响亮，并点名出问题的路由与模型：catalog 未提供的路由需要 `baseURL`、一个由唯一标识的模型组成的非空 `models` 列表，以及可由渠道默认或模型级设置覆盖各模型的协议；省略渠道级 `api` 时使用 `openai-completions`（OpenAI Chat Completions）。该解析在分节 schema 内部运行，因此无法服务的 profile 会在**写入之处**被拒绝——`settings.mutate` 以 `settings-rejected` 点名路由与模型——而不是先存下来、再悄悄让该 namespace 下每条路由失效。对于已经存下的、在此失败的分节，settings seam 会保留该 namespace 上一份可用值。显式协议只接受 `supportedProtocols()` 中的值；catalog 中不存在的模型也可继承其同门模型一致同意的协议，因此向单协议 catalog 路由添加模型无需重述协议。


`baseURL` 设定该路由下每个模型的端点，因此仍支持 `https://proxy.example.com:8443` 等私有 proxy；省略它的 catalog 路由会保留每个 catalog 模型自己的端点。在 catalog 路由上点名 `api` 会为未另行指定协议的模型选择该协议；单个模型的 `api` 优先。

`supportedProtocols()` 刻意窄于 pi-ai 的完整流式 API 集合：它只保留 profile 能用密钥、端点与标头**完整描述**的那些协议。Bedrock 要用 AWS 凭据与 region 做 SigV4 签名，Vertex 需要 project、location 与应用默认凭据，Azure 需要提供方环境外加 api-version，Codex 走 OAuth——提供它们只会交回一个无法完成认证的路由。catalog 路由仍可经自己的 provider 抵达这些协议；被拒绝的只有显式覆盖。

## 动态配置（settings + credentials）

适配器经由一个 thunk **每操作读取一次** profile，而非在构造期冻结。插件在可选的 `ctx.settings` seam 上用同一份 `Config` schema 注册 `llm-pi-ai` namespace，并以其 `cordis.yml` 条目为组合 `base`；由于 `providers` 是字典，base 与用户的 `llm-pi-ai:` settings 分节**按提供方**合并：用户可以新增路由、覆盖组合路由的单个字段，或把路由指向另一个 proxy，全部在下一次请求生效，无需重启。未挂载 settings 服务时，仅由 entry 配置驱动适配器，行为不变。

凭据在每次流调用时通过 `apiKeyEnv` 与可选的 `ctx.credentials` seam 解析；未挂载该 seam 时，适配器只读取该引用指向的环境变量。只有完全没有点名任何凭据的 profile——仅限这一种情况——才交给 pi-ai 的环境发现。每个解析出的密钥都会在使用前去除首尾空白并校验格式，因此 HTTP 标头无法承载的值会被拒绝，而不是以语义不明的 `fetch` `TypeError` 形式浮现；这种拒绝会抛出 `LlmError('INVALID_CREDENTIAL')`，点名失败的路由与凭据引用，但绝不透露密钥的任何部分。路由集合与每条路由捕获的重试策略是注册级事实：两者任一变化时，插件都会原子地替换自己的注册（同一适配器实例，候选集合先经校验），因此某条路由若已被另一适配器占有，先前的路由会继续服务，而改回可用配置时注册会重新生效。提供方键的顺序绝不算作变化。本适配器无法服务的分节会在写入处被拒——注册的 `validate` 会解析整份 profile 集合，因此 `ctx.settings.mutate` 以 resolver 自身的错误拒绝（该协议将其报为 `settings-rejected`），什么都不会存储。已存储分节若因其他途径变得不可服务——比如外部编辑了 `settings.yaml`——则由 settings seam 保留该 namespace 最后可用的值并告警。entry 配置本身仍会使插件加载失败；而 llm 注册表拒绝的路由（已被另一适配器族占有的那种）会被记录下来，先前注册的路由继续服务。

适配器通过 `ctx.llm.listModels(provider)` 公开每条已配置路由的模型。这是从请求路径所用的同一个 pi-ai `Models` 集合读取的提供方无关 selector 元数据，因此发现不会创建第二个模型注册表。`ctx.llm.resolveModelInfo(provider, model)` 会执行一次精确 descriptor 查找，并返回其身份、上下文窗口、已配置输出上限和可选思考级别，让权威元数据保留在拥有路由的适配器上，而非消费方。模型**已配置**的 `maxTokens` 会成为 seam 的 `defaultMaxTokens`，因此未点名输出上限的请求会携带部署选定的那一个；而从已安装 catalog 继承来的值是模型的输出**能力**，绝不会自行变成请求默认值。

携带推理元数据的模型——来自已安装 catalog，或来自其条目的 `reasoningEfforts`——会公开 pi-ai 有序的 `getSupportedThinkingLevels(model)` 结果，不经筛选或规范化，其中包括 `off`，以及模型对 `xhigh` 或 `max` 的特定支持。Harness 将每个规范 pi-ai 级别公开为不透明 ID；提供方／模型在协议格式中的表示仍保留在 pi-ai 的 `thinkingLevelMap` 中。

**没有**这份元数据的模型——条目未声明 `reasoningEfforts` 的手工声明模型，以及 pi-ai 标记为不具备推理能力的 catalog 模型——完全不公开 `reasoning`。pi-ai 会把这类模型报告为只支持 `off` 一档，但 `off` 会被翻译成*省略* reasoning 选项，而那与「不点名任何档位」产出的请求逐字节相同：选它关不掉任何东西，于是自身默认就在思考的提供方，会在界面显示 `off` 被选中的同时继续思考。把该能力报告为不可用，界面就只剩提供方默认这一项，不会再出现自相矛盾的控件。配置 profile 的 `reasoning` 值（包括 `off`）存在时是部署默认值；省略时，具备推理元数据的模型默认选择自身提供的最高档位（包括 `xhigh` 或 `max`），非推理模型仍保留提供方默认值。每次请求的 `GenerateOptions.reasoningEffort` 优先；未出现在确切模型能力中的档位会让**请求**在网络 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 失败，而不会被自动调整。**描述**一个模型则从不这样失败：同一提供方下各模型接受的档位并不一致，因此 `resolveModel` 对该模型拿不下的 profile 档位报告为「没有默认值」，而不是抛错。在那里抛错会让整个提供方从任何基于它构建的模型目录中消失——一个配错的 profile 字段连支持该档位的模型也一并藏起来——所以坏配置暴露在被执行处，而不是被描述处。pi-ai 的通用流选项通过省略 `reasoning` 表示 `off`。

受支持的 profile 字段是 `apiKeyEnv`、`displayName`、`api`、`baseURL`、`models`、`modelOverrides`、`compat`、`completionsThinkingFormat`、`defaultContextWindow`、`defaultMaxTokens`、`defaultInput`、`userAgent`、`outbound`、`headers`、`reasoning`、`thinkingBudgets`、`cacheRetention`、`transport`、`timeoutMs`、`websocketConnectTimeoutMs`、`streamIdleTimeoutMs`、`maxRequestImageBytes` 和 `retryPolicy`。`userAgent` 是本路由模型请求的 User-Agent，取值 1–256 个可打印 ASCII 字符且首尾不留空白，省略时使用产品默认值。每条 profile 解析后的重试策略会随该提供方路由一同捕获；省略时使用共享的有界 normal 默认值并重试五次。流空闲间隔必须是正的有限 Node 定时器延迟，默认为五分钟，且只覆盖未完成提供方读取，不包括消费方思考时间。`maxRequestImageBytes` 约束单个请求的 base64 编码图片载荷（默认 20MiB，正整数）：历史中的每张图片都会重新编码进每个请求，累积载荷超过上限时，从最老的图片开始替换为固定文本占位，直到请求装得下，使图片较多的会话保持可用，而不是被网关请求体上限永久拒绝。默认值为系统提示词、历史、工具与 JSON 保留请求容量；网关更严格的部署按路由调低该值。若已配置标头中有同名项，则以 Harness 应用归因为准。

适配器强制 pi-ai SDK `maxRetries` 为零，因此一次 `stream()` 调用只会发起一次提供方请求。已移除 profile 字段 `maxRetries` 和 `maxRetryDelayMs` 会使加载失败，而不是静默倍增或隐藏单独组合的 agent（智能体）级重试预算。空闲超时会 abort SDK 的稳定请求信号，并以 `TIMEOUT` 呈现；较早的调用方 abort 仍为 `ABORTED`。

## 端点询问

插件提供 `ctx.llm.registerModelDiscovery('llm-pi-ai', …)`，用来回答「这个提供方能服务哪些模型？」——针对配置界面正在编辑或起草的路由。它刻意**不是** catalog 刷新：什么都不存储，回复是界面供用户采纳的候选。`settings.yaml` 始终是唯一决定路由服务什么的东西。

对于支持列表查询的协议，询问向当前草稿明确给出的 `baseURL` 发起真实 `GET /models`；草稿未填写端点时，使用已保存路由的端点，或已安装 pi-ai 提供方的默认端点。无法确定端点时明确失败，提示填写 `baseURL` 或手工录入模型。pi-ai 本地目录不充当此次询问结果，且返回的模型仍只是供采纳的候选，不会自动保存。

草稿携带的是用户当下键入的凭据（如果有）；已经存好凭据的路由，在配置界面上只呈现一个脱敏描述符，因此端点与已保存端点相同时才会解析该路由的 `apiKeyEnv`。草稿端点不同且没有本次输入的密钥时，询问会在网络 I/O 前失败，避免旧密钥发送到新端点。键入的密钥优先，且不会被保存。用户提供或已存储的探测密钥都经过去除空白与格式校验，不能放入 HTTP 标头的值会以 `INVALID_CREDENTIAL` 拒绝。

pi-ai 路由仅在 `openai-completions` 和 `openai-responses` 下使用 OpenAI 兼容的 `GET /models` 和 Bearer 认证；其他协议返回 `DISCOVERY_UNSUPPORTED`，可手工录入。基址的部署路径会保留，例如 `https://gateway.example/openai/v1` 查询 `https://gateway.example/openai/v1/models`。存量 DeepSeek 使用同一清单读取实现，但按其[兼容地址规则](../llm-deepseek/README.md#端点探测)选定目标，不受对话协议限制。

多数列表只公布 id；`context_window`/`context_length` 与 `max_output_tokens`/`max_tokens` 在网关提供时会被读取，没有可用 id 的条目会被跳过而不是让整份列表失败，其余仍由采纳方补齐。端点允许 HTTP(S) 的私网与环回地址，但不接受 URL 中的 userinfo、查询参数或 fragment；请求不跟随重定向。读取已保存路由的凭据与每次网络尝试各有十秒上限，超时与传输层失败会换连接重试一次，两次都失败才放弃——一次闲置连接被中间设备丢弃、DNS 首次答到不可达地址，都不必让用户再点一次「获取可用模型」。端点已经给出的答复（状态码、非 JSON、没有 `data` 数组）不重试，因为重发只会得到同一结果。回复有四兆字节上限，上限落在实际收到的字节上，声明长度仅用于及早拒绝。失败说明按原因分开：两次尝试都没有响应时报出总时长与尝试次数；连接直接失败时用 `coding-llm` 的 `errorChain` 带上 `cause` 链里的底层原因（如 `getaddrinfo ENOTFOUND`、`ECONNREFUSED`、TLS 证书错误），否则界面上只剩一句超时，用户无从判断该查地址、证书还是网络。仅当 401 或 403 时才提示核对凭据。调用方在凭据解析、请求或读取期间取消会呈现为 `ABORTED`。

## 提供方／模型路由与回放

每次解析产出一份**不可变**快照——profiles 加上一个持有各路由所建 `Provider` 的 `createModels()` 集合——每个操作都在自己第一个 `await` 之前整体捕获一份快照。配置变化会构造**新**集合，而不是改动正在被使用的那个：`Models.streamSimple()` 是惰性的，它在流首次被消费时才解析 provider，而那已在 credential await 之后，因此改动共享集合会让一个在旧配置下开始的请求在新配置下结束，或者撞上一个已不存在的 provider。这正是 seam 的每步调用冻结（`llm.prepareCall()`）能贯通到底的原因——回复途中切换模型会在下一步生效，绝不会影响在途的那一步。请求经 `Models.streamSimple()` 抵达提供方。未改写渠道协议的 catalog 路由保留已安装提供方及其原生 API 实现（如 Bedrock 的 Smithy 模块）；该目录中新添或按模型改为其他协议的条目由对应的 pi-ai 协议工厂承接。同一渠道因而可以有不同协议的模型，而不会丢失原目录模型的请求实现。手工声明路由和显式改写整条渠道协议的路由则由协议工厂构造。

凭据绝不进入该集合。harness 在请求抵达 pi-ai 之前经自身 seam 解析路由密钥，并作为请求的 `apiKey` 选项传入，而 pi-ai 将其视为优先级最高的 auth 覆盖；因此 `Models` 不持有任何凭据存储，harness 也保住了自己明确失败的引用语义。没有点名任何凭据的路由会解析为「已配置但无密钥」，把该要求留给协议——那才是它真正所在的位置。

所选模型 descriptor 提供协议实现。这包括原生 API 差异，例如 descriptor 使用 Responses API 而非 Chat Completions 的 OpenAI 模型；harness 适配器不会按模型名称硬编码端点选择。

`ToolSchema.inputFormat` 声明 Lark 语法时，选择 `openai-responses`、`azure-openai-responses` 或 `openai-codex-responses` 的模型会把该工具发为 Responses `custom` 语法工具，以原始文本接收调用；它在 Harness 执行与日志中仍规范为带 `input` 字段的 JSON 参数。只有实际所选协议触发这条路径，不按提供方或模型 ID 推断。模型明确设置 `compat.supportsOpenAIGrammarTools: false` 时保留普通函数工具及原 `description`；其余协议也使用 JSON 函数调用。原生语法路径使用 `inputFormat.description`（若提供），普通路径使用工具自身的 `description`。这只改变传输形态，不扩展 [`apply_patch`](../../fs/tool-apply-patch/README.md) 的 Add/Update 子集，也不改变文件权限。

成功的 assistant 响应会将经版本化的无损 JSON 回放状态与生成该响应的提供方和模型一同存储，其形式是 `ReplayEnvelope`：一个响应级半区（kind、版本、API、路由、响应 id、原生停止原因），加上每个流式块一条、携带该块 signature 的逐块条目。逐块对齐正是 `BlockAssembler` 在组装丢弃某个块（`max-tokens` 下的工具调用）时裁剪的对象，因此存储的条目始终描述存储的内容——保留的块保有其 signature。请求时，`LlmRuntime` 只有在历史提供方路由与目标提供方路由当前由同一个 `PiAiAdapter` 实例拥有时，才会传递回放状态。即使目标提供方或模型改变，适配器也会验证状态并恢复 pi-ai 响应 id 与提供方 signature；随后由 pi-ai 判定目标 API 可以复用哪些元数据。没有回放状态的历史会被转换为外来的、与提供方无关的内容，绝不伪装为原生 pi-ai 响应。

Responses 的加密推理内容只作为适配器私有回放元数据随会话记录保存并交还同适配器的后续请求；可读摘要才进入推理文本分片和 Chat。只有密文、没有摘要的推理块会保留空文本以维持回放块对齐，界面不据此展示空白 Think 行；密文不会被解码或当作可读思考呈现。

持久化内容是权威记录；回放状态只负责恢复原生保真度。当前构建无法使用的已存状态——其他适配器的 kind、其他版本（包括旧日志携带的平铺前信封形式）、格式错误的元数据、消息与回放状态之间的提供方／模型不匹配，或内容／块不匹配——会把这一条 assistant 消息降级为同样的外来提供方无关转换而不是让请求失败，插件通过其 `onReplayDegrade` 钩子记录 `INVALID_REPLAY_STATE` 诊断。

## 词汇差异

- pi-ai 工具调用参数是已解析对象；harness 存储原始 JSON 字符串。适配器会解析输入，并将输出重新字符串化。
- pi-ai 将失败报告为流内错误事件；它们会映射到 `finish {kind:'error'|'aborted', failure}` 分片。提供方特定错误文本会区分终止型 `QUOTA` 与暂时型 `RATE_LIMIT`，针对已解析模型上下文窗口评估的文本与 usage 信号则将溢出规范化为 `CONTEXT_WINDOW_EXCEEDED`。终止时的 `stop` 若消息不含内容块，则会映射为 `finish {kind:'error'}`，code 为 `EMPTY_RESPONSE`（默认策略会重试），而非成功空消息。
- pi-ai 将推理 token 折叠到输出 usage 中；没有可映射的独立推理计数。
- pi-ai 的 `off` 思考级别会原样穿过 Harness 能力 seam，并在分派时变为被省略的 pi-ai 通用 `reasoning` 选项。
- `GenerateOptions.stop` 会以 `UNSUPPORTED_OPTION` 被拒绝，因为 pi-ai 的通用流式输出接口无法保证所有提供方都支持它。

## 应用归因

每个流式请求都用所属路由 profile 的 `userAgent`，省略时使用产品默认值（见 [coding-llm](../llm/README.md#模型请求-user-agent)）。它在流调用开始时随该路由的 profile 一起捕获，进行中的请求不会随设置变化更换标头。流式请求通过 pi-ai `headers` 选项合并，归因标头仍压过 profile 中大小写不同的同名项，因此改 User-Agent 只走 `userAgent` 字段；不会合成提供方特定应用归因标头。模型发现按查询所属路由的已存 profile 取同一个值，草稿还没有已存 profile 时回落产品默认值。

## 依赖体量

pi-ai 会安装多个提供方 SDK，并延迟加载 catalog 模型所选的 SDK。该可选适配器包将依赖体量隔离在自身范围内。

## 模型体验

### 通过 pi-ai 发起的提供方请求

#### 模型看到的内容

所选 catalog 模型会收到 `GenerateOptions.system`、历史、工具，以及 pi-ai 通用流式 API 支持的采样字段。本包不添加提示词文本，仅有一个例外：请求累积的 base64 图片载荷超过路由的 `maxRequestImageBytes` 时，被 offload 的图片（从最老开始）会被替换为一段固定文本。该文本要求模型在有路径时重新读取文件，否则请用户重新附上图片。只有当适配器验证提供方原生回放元数据与历史内容匹配时，才会恢复这些元数据。

#### Token 影响

精确输入取决于提供方 tokenization。除图片 offload 占位文本外，转换不添加模型可见文本；占位文本用一句固定短句替代被省略图片的视觉 token。回放元数据可能让原生 API 复用提供方侧状态。

#### KV Cache 影响

转换保留逻辑请求顺序，不添加文本；复用取决于所选提供方的序列化与回放状态。更改适配器实例、提供方、模型或任何上游请求 token，都可能使复用从首个出现差异的 token 起失效。跨过图片上限会改写较早的一条消息（新被 offload 的图片变为占位文本），复用在该消息处截止，直到被 offload 的前缀稳定。

### 提供方响应

#### 模型看到的内容

pi-ai 事件会变为 harness 推理、文本、工具调用、usage 与 finish 分片。适配器把解析后的工具参数作为原始 JSON 字符串传给 harness。

#### Token 影响

只有在 loop 记录生成内容后，它才会影响后续输入。提供方不单独报告推理 token 时，pi-ai 会将其折叠到输出 usage 中。

#### KV Cache 影响

已记录响应内容会追加到下一个请求，不会使其较早可复用前缀失效。未记录传输元数据与 usage 计量不影响 cache 身份。

## 已知限制与暂缓事项

- **`maxRequestImageBytes` 只统计 base64 图片载荷**：文本、工具与 JSON 结构不计入上限，因此该值必须低于网关请求体上限并留出余量。offload 在请求转换时决定，是历史与配置的纯函数，不记录为会话事件；由按路由能力元数据（图片数量、单图大小、请求总大小）同时驱动准入与组装的完整设计属于暂缓工作。
- **仅以 OAuth 认证的提供方不予提供**：pi-ai 的 OAuth 只从*已存储*的 OAuth 凭据解析，而本适配器构造 `Models` 集合时不注入凭据存储、也不运行登录流程，因此这类路由的每个请求都会在发出之前以 `Provider is not configured` 失败。可配置提供方目录因此不列出它们；已安装 catalog 中只有 `openai-codex` 属于此类。settings 文档已经写过的路由仍保留目录条目，配置界面据此可以编辑或删除；`apiKeyEnv` 也仍能用该密钥完成认证——对 Codex 而言那是一个会过期、且这里没有任何环节会去刷新的 token。
- **提供方自带的凭据发现只读进程环境**：不指定凭据的路由交由 catalog 提供方自行解析，而它探测的是环境变量（`AZURE_OPENAI_API_KEY`、`AWS_PROFILE`、`AWS_ACCESS_KEY_ID` 以及各提供方自己的那一组）。它不读任何本地凭据目录，因此只有 `~/.aws/credentials` 而未导出 `AWS_PROFILE` 会被解析为未配置；由 harness 凭据 seam 保管的值，除非进程环境里也有，否则对它不可见。
- **settings 能新增或覆盖路由，但不能移除组合路由**：用户层合并在组合 `base` 之上，因此删除 `cordis.yml` 提供的提供方属于组合变更；对该 namespace 执行 `replace` 只会重置用户层。
- **分层合并对字典键没有删除语义**：settings seam 把组合 `base` 与用户层按键递归合并，因此 base 声明的某个 `reasoningEfforts` 档位、`modelOverrides` 条目或 `compat` 字段，用户层只能覆盖、无法移除——而 `reasoningEfforts` 里缺席本身*就是*语义（「不提供」），于是 base 声明过的档位会一直被提供。只有 `cordis.yml` entry config 为用户层正在编辑的同一模型声明了按模型推理字段才会触发；受支持的姿态是把这些字段留给 settings 文档（shipped 组合以 dormant 方式挂载该适配器），且 `models` 列表是数组、整体替换，这是带内的解决办法。
- **`headers` 可能承载一条脱敏器看不见的凭据**：profile 的 `headers` 是纯字符串字典，因此设在其中的 `Authorization` 或 `api-key` 会被脱敏后的 `describe()` 原样返回，并被任何配置 UI 渲染出来。请把凭据存为 `apiKeyEnv` 引用；把该字典整体改为只写与其余[协议边界工作](../llm/README.md#已知限制与暂缓事项)一并暂缓。
- **路由的 catalog 不会自我刷新**：服务模型仍由 `settings.yaml` 决定；端点询问仅返回候选，用户必须采纳并保存才会改变路由的模型列表。
- **模态声明不经端点验证**：模型列表查询不证明端点接受 `image`；多声明图片能力后，提供方可能在轮次中途拒绝，已提交的原始图片仍留在会话日志中，单纯重试同一不支持图片的模型会重复失败。可改选确实支持图片的模型，或显式配置[视觉理解路由](../llm-vision-fallback/README.md)后改选纯文本模型，将图片描述持久替换到主模型历史；没有该路由时纯文本模型仍拒绝图片，视觉调用失败时主请求也不会发送。其他恢复方式是 fork 到图片之前或开启新会话；发送失败时回滚尚未消费的图片消息仍属暂缓工作。
- **未认证路由取决于其协议**：不点名凭据会让路由解析为「已配置但无密钥」，但 pi-ai 的 OpenAI 兼容实现仍要求 API key 或 `Authorization` 标头，因此无鉴权的本地服务需要一个由 `apiKeyEnv` 引用的占位凭据，或在 `headers` 中给出 `Authorization` 条目。
- **不支持 `GenerateOptions.stop`**：pi-ai 的通用流选项无法保证所有提供方都支持 stop sequence，因此适配器会拒绝该字段。
- **历史中的 `system` 消息使用 pi-ai 通用上下文转换**：提供方特定位置由 pi-ai 决定，而非由 harness 拥有的协议覆盖决定。
- **无法获取提供方 HTTP 状态**：pi-ai 错误事件不会在所有提供方上公开稳定 HTTP 状态；失败只公开稳定 harness 错误 code。
- **重试策略由提供方持有，而不是 SDK 重试**：每个提供方 profile 都可以提供嵌套的 `retryPolicy`；省略时解析为 normal 模式并重试五次，`dsh-llm-retry` 会在 agent 的失败步骤扩展点上执行有效路由策略。pi-ai SDK 重试仍保持禁用，因此持久化的 agent 步骤与 `llm/retry` 事件记录每次可见尝试，直接 `ctx.llm.stream()` 调用仍只尝试一次。
