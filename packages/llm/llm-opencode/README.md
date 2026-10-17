# coding-llm-opencode

内置 **Free** 渠道适配器：把本项目维护的免费模型注册成 harness 的一个原生 LLM 提供方
路由（`free`），**不需要任何凭据配置**即可开箱使用。

渠道名、端点、匿名凭据与模型目录都是包内事实（[`src/channel.ts`](src/channel.ts)），
不进入设置分节。设置 → 模型里这条渠道因此是只读的：用户可以看它当前服务的模型与能力，
但没有改端点、换密钥、改名称或增删模型的入口；这些事实随应用发布，由本包维护。

免费上游对免费模型只认固定字面量，但它按客户端指纹过滤流量，因此本适配器发出的
每个请求都与官方 OpenCode CLI 同形：相同的 User-Agent、按会话派生的关联头，以及该通道
要求的 agent 形状工具表。这三样都在本包内，不依赖进程环境或外部 sidecar；这条路由因此
**不使用**共享的模型请求 User-Agent——harness 自己的 `Coding/…` 归因 UA 会被上游 403。

## 免费上游与模型目录

一条渠道可以聚合多条免费上游：`FREE_UPSTREAMS` 里每条记录带自己的端点、凭据与模型表，
`FREE_CHANNEL_MODELS` 把它们展开成渠道目录，适配器按请求里的模型 id 选择上游的端点与
凭据。接入新的免费上游＝加一条记录；若它的请求形状不同，再加一个对应的请求改写模块。

| 上游 | 端点 | 凭据 |
| --- | --- | --- |
| `opencode-zen` | `https://opencode.ai/zen/v1` | 字面量 `public` |

目录（显示名固定、能力取自 models.dev 的提供方元数据）：

| 模型 id | 显示名 | 上下文 | 输出上限 | 图片输入 | 推理 |
| --- | --- | --- | --- | --- | --- |
| `mimo-v2.6-flash-free` | Mimo V2.6 Flash | 1,048,576 | 32,768 | 是 | 恒开，无档位 |
| `deepseek-v4.1-flash-free` | Deepseek V4.1 Flash | 262,144 | 32,768 | 是 | `low` / `high` / `max` |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning | 262,144 | 32,768 | 否 | 恒开，无档位 |

模型的三个能力字段决定请求怎么发：

- `inputModalities`（`text` / `image`）声明该模型接受什么输入；含 `image` 时图片才会内联进请求，否则图片按纯文本模型的常规处理被拒绝或降级。
- `reasoning` 声明该模型是否具备推理能力；具备时它的推理增量会作为推理内容解析，而不是混进正文。
- `reasoningEfforts` 列出可以选择的档位，取值来自 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；选中的档位换算成请求体里的 `reasoning_effort`，`off` 表示省略该参数。省略档位的模型不提供档位选择，只有提供方默认这一项；没有档位声明的模型在选择器里不报告推理档位。

## 与上游的协议约定

- **端点**：`{baseURL}/chat/completions`，`Authorization: Bearer <apiKey>`。
- **客户端指纹**：`user-agent: opencode/latest/2.0.29/cli`——上游只放行 `opencode/`
  开头的形态，其他 UA（包括 harness 的归因 UA）一律 403；`x-opencode-client: cli`；
  `x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `X-Session-Id`
  四个头同值；`x-opencode-project` 是裸 40 位小写 hex。请求级的 `x-opencode-request`
  自 2026-10-14 起会被上游拒绝，因此只在本进程内保留、不上线。
- **会话 id**：`ses_` + 12 位小写 hex + 14 位 base62。hex 段是
  `~(Date.now() * 0x1000 + 1)` 的低 48 位——上游把低 12 位读回成计数器，因此必须是
  真实时钟而不是摘要（低 12 位落在 `0xFC0`–`0xFFF`，随机 hex 会被 403）；尾段由会话身份
  摘要决定，保证不同会话不碰撞。同一会话内 id 稳定（重试与后续轮次复用），因此上游的
  prompt cache 亲和与配额归组不被破坏。
- **请求体门**：请求必须是流式的，且 `tools` 必须同时含 `bash` 与 `read`（完全不带工具表
  的请求会被 403）。缺失的名字会被补上不可调用的占位定义；客户端已注册的同名工具原样保留，
  因此模型仍然只会调用消费方真正实现的工具。原本没有任何工具时把 `tool_choice` 固定为 `none`。
  已知风险：上游在 2026-10-14 曾逐字节比对被识别工具的 description 与参数 schema，本适配器
  的占位定义在该策略下会被拒；届时需要改为携带官方工具定义，或改走自己的 key。
- **模型路由**：只有目录里收录的模型会发往上游；未收录的 id 在适配器里以 `UNKNOWN_MODEL`
  拒绝，因为没有任何上游记录能给出它的端点与凭据。

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
占位工具定义位于工具表末尾且顺序稳定，不破坏已缓存的前缀。换模型或换上游都会从首个
差异 token 起失效。

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
  不再接受本客户端的指纹——先按下节的指纹清单逐项核对（2026-10-16 的复测结论是：
  换错 User-Agent 与丢掉时钟段各能单独触发 403），再考虑跟随上游更新。
- **只支持 `openai-completions` 一种线协议**：Zen 上少数模型只在 `/responses` 上服务，
  本适配器不为它们切换协议；这类模型不在目录里。
- **目录随包发布**：服务的模型始终是 `FREE_UPSTREAMS` 里的记录，上游新增或下架的免费
  模型不会自动进入选择器，需要改这条记录并发版。本适配器没有注册模型发现，因此这条
  渠道不提供「获取可用模型」。
- **图片能力按模型声明**：只有声明了 `image` 输入的模型（目录里是 MiMo 与 DeepSeek
  V4.1 Flash）会内联图片；未声明的模型按纯文本处理，图片不会发给它。
