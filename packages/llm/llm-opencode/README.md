# @deepseek-ai/dsh-llm-opencode

内置的 [OpenCode Zen](https://opencode.ai/zen) 免费渠道适配器：把该通道的匿名免费模型
注册成 harness 的一个原生 LLM 提供方路由（默认 `opencode-zen`），**不需要任何凭据配置**
即可开箱使用。

免费通道对免费模型只认字面量 `public`，但它按客户端指纹过滤流量，因此本适配器发出的
每个请求都与官方 OpenCode CLI 同形：相同的 User-Agent、按会话派生的关联头，以及该通道
要求的 agent 形状工具表。这三样都在本包内，不依赖进程环境或外部 sidecar。

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
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `channelName` | `OpenCode Zen` | 选择器与设置页显示的渠道名称。 |
| `apiKey` | `public` | 匿名通道的凭据字面量；填自己的 key 时整份凭据被替换。 |
| `baseURL` | `https://opencode.ai/zen/v1` | 端点基址，可改指自建网关。 |
| `models` | 见下 | 目录；每个模型可写 `name`、`contextWindow`、`maxTokens`、`reasoningEfforts`。 |
| `defaultContextWindow` | `262144` | 模型未写容量时的回退。 |
| `defaultMaxTokens` | `32768` | 模型未写输出上限时的回退。 |
| `streamIdleTimeoutMs` | `300000` | 未完成的流读取允许的空闲时长。 |
| `maxRequestImageBytes` | 20 MiB | 单次请求 base64 图片载荷上限。 |
| `retryPolicy` | normal / 5 次 | 提供方自有的重试策略，由 `dsh-llm-retry` 执行。 |

内置目录是三个免费模型，显示名固定，不随上游元数据漂移：

| 模型 id | 显示名 | 上下文 | 输出上限 |
| --- | --- | --- | --- |
| `mimo-v2.6-flash-free` | Mimo V2.6 Flash | 1,048,576 | 32,768 |
| `deepseek-v4.1-flash-free` | Deepseek V4.1 Flash | 262,144 | 32,768 |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning | 262,144 | 32,768 |

模型 id、渠道名称、凭据与端点都可以在设置页改；改动在下一次请求生效，不需要重启。
模型未声明 `reasoningEfforts` 时不报告推理能力，选择器只提供提供方默认一项。

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
- **图片能力按模型声明**：内置三个模型都只声明文本输入。要向它们发送图片需要一个声明了
  `image` 的模型条目，并自行确认上游接受。
- **目录不自我刷新**：服务的模型始终来自 `models` 配置；上游新增或下架的免费模型不会
  自动进入选择器，需要用户显式编辑。
