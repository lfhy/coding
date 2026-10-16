# @deepseek-ai/dsh-llm-opencode

内置的 [OpenCode Zen](https://opencode.ai/zen) 免费渠道适配器：把该通道的匿名免费模型
注册成 harness 的一个原生 LLM 提供方路由（默认 `opencode-zen`），**不需要任何凭据配置**
即可开箱使用。

免费通道对免费模型只认字面量 `public`，但它按客户端指纹过滤流量，因此本适配器发出的
每个请求都与官方 OpenCode CLI 同形：相同的 User-Agent、按会话派生的关联头，以及该通道
要求的 agent 形状工具表。这三样都在本包内，不依赖进程环境或外部 sidecar。

本插件同时把 `opencode-zen` 声明进可配置提供方目录，且声明时整节即 profile，因此
**设置 → 模型**无需先在 `settings.yaml` 里写分节就会列出这条已配置渠道，并允许改渠道名称、
端点、密钥与模型；渠道名称变化会同时刷新路由名与目录名，路由本身保持同一条。

## 配置

插件配置同时也是 `llm-opencode` 设置分节的结构。所有字段都可省略，省略时使用内置默认值，
因此默认安装无需任何分节即可工作；下面的写法与完全省略等价。

```yaml
- id: llm-opencode
  name: '@deepseek-ai/dsh-llm-opencode'
  config:
    channelName: OpenCode Zen
    apiKey: public
    baseURL: https://opencode.ai/zen/v1
    models:
      - id: mimo-v2.6-flash-free
        name: Mimo V2.6 Flash
        contextWindow: 1048576
        maxTokens: 32768
        inputModalities: [text, image]
        reasoning: true
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `channelName` | `OpenCode Zen` | 选择器与设置页显示的渠道名称。 |
| `apiKey` | `public` | 匿名通道的凭据字面量；填自己的 key 时整份凭据被替换。它是 `role('secret')` 字段：设置描述从不携带它的值，设置页只能写入、不能回显。 |
| `baseURL` | `https://opencode.ai/zen/v1` | 端点基址，可改指自建网关。 |
| `models` | 见下 | 目录；每个模型可写 `name`、`contextWindow`、`maxTokens`、`inputModalities`、`reasoning`、`reasoningEfforts`。 |
| `defaultContextWindow` | `262144` | 模型未写容量时的回退。 |
| `defaultMaxTokens` | `32768` | 模型未写输出上限时的回退。 |
| `streamIdleTimeoutMs` | `300000` | 未完成的流读取允许的空闲时长。 |
| `maxRequestImageBytes` | 20 MiB | 单次请求 base64 图片载荷上限。 |
| `retryPolicy` | normal / 5 次 | 提供方自有的重试策略，由 `dsh-llm-retry` 执行。 |

模型的三个能力字段决定请求怎么发：

- `inputModalities`（`text` / `image`）声明该模型接受什么输入；含 `image` 时图片才会内联进请求，否则图片按纯文本模型的常规处理被拒绝或降级。省略时按纯文本处理。
- `reasoning` 声明该模型是否具备推理能力；具备时它的推理增量会作为推理内容解析，而不是混进正文。
- `reasoningEfforts` 列出可以选择的档位，取值来自 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；选中的档位换算成请求体里的 `reasoning_effort`，`off` 表示省略该参数。省略该字段的模型不提供档位选择，只有提供方默认这一项。声明了档位却没有声明 `reasoning` 的分节在写入处被拒绝，因为那些档位无法转发。

内置目录是三个免费模型，显示名固定、能力取自 models.dev 的提供方元数据：

| 模型 id | 显示名 | 上下文 | 输出上限 | 图片输入 | 推理 |
| --- | --- | --- | --- | --- | --- |
| `mimo-v2.6-flash-free` | Mimo V2.6 Flash | 1,048,576 | 32,768 | 是 | 恒开，无档位 |
| `deepseek-v4.1-flash-free` | Deepseek V4.1 Flash | 262,144 | 32,768 | 是 | `low` / `high` / `max` |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning | 262,144 | 32,768 | 否 | 恒开，无档位 |

模型 id、渠道名称、凭据与端点都可以在设置页改；改动在下一次请求生效，不需要重启。
密钥字段只写不回显：描述从不返回 `apiKey`（包括内置的 `public`），输入留空即继续使用当前值。
没有档位声明的模型不报告推理档位，选择器只提供提供方默认一项。

## 与上游的协议约定

- **端点**：`{baseURL}/chat/completions`，`Authorization: Bearer <apiKey>`。
- **客户端指纹**：`user-agent: opencode/<version> (<platform> <arch>; node<version>)`，
  `x-opencode-client: cli`，以及 `x-opencode-session` / `x-session-affinity` /
  `X-Session-Id`（三者同值）、`x-opencode-request`、`x-opencode-project`。
- **会话 id**：`ses_` + 12 位小写 hex + 14 位 base62。hex 段是
  `~(Date.now() * 0x1000 + 1)` 的低 48 位——上游把低 12 位读回成计数器，因此必须是
  真实时钟而不是摘要；尾段由会话身份摘要决定，保证不同会话不碰撞。同一会话内 id 稳定
  （重试与后续轮次复用），因此上游的 prompt cache 亲和与配额归组不被破坏。
- **请求体门**：请求必须是流式的，且 `tools` 必须同时含 `bash` 与 `read`。缺失的名字会被
  补上不可调用的占位定义；客户端已注册的同名工具原样保留，因此模型仍然只会调用消费方
  真正实现的工具。原本没有任何工具时把 `tool_choice` 固定为 `none`。

## 错误分类

上游用 403 表达两种互不相同的含义，本适配器把它们从通用的 `AUTH` 里分出来，避免把通道
限制报成「密钥无效」：

| 上游文本 | 稳定 code | 可重试 |
| --- | --- | --- |
| `FreeTierError` | `FREE_TIER_RESTRICTED` | 否 |
| `RegionError` / `not available in your country` | `REGION_BLOCKED` | 否 |
| 其他 401/403 | `AUTH` | 否 |
| 429 | `RATE_LIMIT` | 是 |
| 5xx | `SERVER` | 是 |

## 模型体验

### 通过本适配器发起的提供方请求

#### 模型看到的内容

请求携带系统的 system 槽、历史与工具 schema，与 `llm-pi-ai` 的转换一致；唯一的差异是
缺少 `bash`/`read` 时会追加两个不可调用的占位工具定义（描述中写明不要调用）。图片只有在
模型声明了图片能力时才会内联，附件不可读时降级为固定文本占位。

#### Token 影响

占位工具定义占用固定的少量输入 token（每个约十余 token）。图片内联按各提供方的
tokenization 计入视觉 token；被降级为占位的图片不计视觉 token。

#### KV Cache 影响

同一会话复用同一个 `ses_` 会话 id，因此上游的 prompt cache 亲和与配额归组在轮次间保持；
占位工具定义位于工具表末尾且顺序稳定，不破坏已缓存的前缀。换端点、换模型或换凭据都会
从首个差异 token 起失效。

### 提供方响应

#### 模型看到的内容

响应事件被翻译为 harness 的推理、文本、工具调用、用量与结束分片；工具参数交回时重新
序列化为原始 JSON 字符串。

#### Token 影响

只有在 agent loop 记录生成内容后，它才影响后续输入。

#### KV Cache 影响

已记录响应追加到下一个请求，不会使较早的可复用前缀失效。

## 已知限制与暂缓事项

- **免费通道按出口 IP 限流并按地区封锁**：这是上游策略，不是本适配器的缺陷。命中
  `REGION_BLOCKED` 时该模型在当前网络下不可用；命中 `FREE_TIER_RESTRICTED` 时说明上游
  不再接受本客户端的指纹，需要跟随上游更新指纹而不仅是改配置。
- **只支持 `openai-completions` 一种线协议**：Zen 上少数模型只在 `/responses` 上服务，
  本适配器不为它们切换协议；这类模型不在内置目录里。
- **图片能力按模型声明**：只有声明了 `image` 输入的模型（内置目录里是 MiMo 与 DeepSeek V4.1 Flash）会内联图片；未声明的模型按纯文本处理，图片不会发给它。
- **目录不自我刷新**：服务的模型始终来自 `models` 配置；上游新增或下架的免费模型不会
  自动进入选择器，需要用户显式编辑。本适配器没有注册模型发现，因此设置页的
  **获取可用模型**在这条渠道上报“没有为 `llm-opencode` 注册模型发现”，模型需手工增删。
- **设置页的模型行没有模态字段**：本适配器的模型只声明 `reasoningEfforts`，所以那里的
  模型设置窗口不提供视觉开关；要声明图片输入需直接在 `settings.yaml` 里写该模型条目，
  并自行确认上游接受。
