# coding-llm-opencode

内置 **Free** 渠道适配器：把本项目维护的免费模型注册成 harness 的一个原生 LLM 提供方
路由（`free`），**不需要任何凭据配置**即可开箱使用。

渠道名、端点、匿名凭据与模型目录都是包内事实（[`src/channel.ts`](src/channel.ts)），
不进入设置分节。设置 → 模型里这条渠道因此是只读的：用户可以看它当前服务的模型与能力，
但没有改端点、换密钥、改名称或增删模型的入口；这些事实随应用发布，由本包维护。

渠道的首位是 **Auto** 虚拟模型（`auto`）：它不指向任何上游，而是按候选表跨上游逐个
尝试，命中可转移失败（地区封锁、鉴权无效、限流、上游故障）时自动换下一个候选，因此
它是组合层的默认模型——单家上游整段不可用时无需人工干预。

## 免费上游与模型目录

一条渠道可以聚合多条免费上游：`FREE_UPSTREAMS` 里每条记录带自己的端点、凭据与模型表，
`FREE_CHANNEL_MODELS` 把它们展开成渠道目录，适配器按请求里的模型 id 选择上游的端点与
凭据。接入新的免费上游＝加一条记录。两条上游都靠**空 Bearer** 表达匿名免费层：上游把
空凭据读作免费通道，非空值反而会被当成失效令牌拒绝，因此请求形状就是标准
`chat/completions`，不需要伪装、指纹或工具形状门。

| 上游 | 端点 | 凭据 | 请求形状 |
| --- | --- | --- | --- |
| `ovh-ai-endpoints` | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | 空 Bearer | 匿名直连 |
| `kilo-free-pool` | `https://api.kilo.ai/api/gateway` | 空 Bearer | 匿名直连 |

目录（显示名固定；能力以 2026-10-26 的线协议实测为准）：

| 模型 id | 显示名 | 上下文 | 输出上限 | 图片输入 | 推理 |
| --- | --- | --- | --- | --- | --- |
| `auto` | Auto | 候选最紧值 | 候选最紧值 | 是 | 按候选 |
| `Qwen3.5-397B-A17B` | Qwen3.5 397B A17B (OVH) | 262,144 | 32,768 | 是 | `none` / `low` / `medium` / `high` / `xhigh` |
| `Qwen3.8-27B` | Qwen3.8 27B (OVH) | 262,144 | 32,768 | 是 | `none` / `low` / `medium` / `high` |
| `Qwen3.5-9B` | Qwen3.5 9B (OVH) | 262,144 | 32,768 | 是 | `none` / `low` / `medium` / `high` / `xhigh` |
| `gpt-oss-120b` | GPT-OSS 120B (OVH) | 131,072 | 32,768 | 否 | `low` / `medium` / `high` |
| `gpt-oss-20b` | GPT-OSS 20B (OVH) | 131,072 | 32,768 | 否 | 恒开，无档位 |
| `Mistral-Small-3.2-24B-Instruct-2506` | Mistral Small 3.2 24B (OVH) | 131,072 | 32,768 | 是 | 不推理 |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | Nemotron 3 Ultra 550B (Kilo) | 1,000,000 | 65,536 | 否 | 恒开，无档位 |
| `nvidia/nemotron-3.5-lightning:free` | Nemotron 3.5 Lightning (Kilo) | 1,000,000 | 65,536 | 否 | 恒开，无档位 |
| `cohere/north-mini-code:free` | North Mini Code (Kilo) | 256,000 | 64,000 | 否 | 恒开，无档位 |
| `dots-studio/dots-3-note-preview:free` | Dots3 Note Preview (Kilo) | 512,000 | 460,800 | 是 | 恒开，无档位 |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | Nemotron 3 Nano Omni (Kilo) | 256,000 | 65,536 | 是 | 恒开，无档位 |
| `recursive/flint-v1.0:free` | Flint 1.0 (Kilo) | 262,144 | 235,929 | 否 | 恒开，无档位 |
| `reflection/beam-free` | Beam 1.0 (Kilo) | 1,048,576 | 131,072 | 否 | 恒开，无档位 |
| `poolside/laguna-s-2.1:free` | Laguna S 2.1 (Kilo) | 262,144 | 32,768 | 否 | 不推理 |
| `kilo-auto/free` | Auto Free (Kilo) | 256,000 | 32,768 | 否 | 恒开，无档位 |

Auto 的候选顺序（即失败时的转移顺序）是：`Qwen3.5-397B-A17B` →
`nvidia/nemotron-3-ultra-550b-a55b:free` → `gpt-oss-120b` →
`nvidia/nemotron-3.5-lightning:free` → `Mistral-Small-3.2-24B-Instruct-2506` →
`kilo-auto/free`，OVH 与 Kilo 交替，保证单上游整段限流时仍有可转移的后备。

模型的三个能力字段决定请求怎么发：

- `inputModalities`（`text` / `image`）声明该模型接受什么输入；含 `image` 时图片才会内联进请求，否则图片按纯文本模型的常规处理被拒绝或降级。
- `reasoning` 声明该模型是否具备推理能力；具备时它的推理增量会作为推理内容解析，而不是混进正文。
- `reasoningEfforts` 列出可以选择的档位，取值来自 `off`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；选中的档位换算成请求体里的 `reasoning_effort`。`off` 通常表示省略该参数（模型默认行为）；声明了 `none` 的模型（OVH 的 Qwen3.x）把省略读作默认深推理，`off`／`none` 因此都显式发 `reasoning_effort: "none"` 关闭推理。省略档位的模型不提供档位选择，只有提供方默认这一项；没有档位声明的模型在选择器里不报告推理档位。
- **图片能力以实测为准**：2026-10-26 用一个红色方块逐个验证——OVH 的 Qwen3.5 397B、Qwen3.8 27B、Qwen3.5 9B、Mistral Small 3.2 24B 与 Kilo 的 Dots3 Note Preview、Nemotron 3 Nano Omni 真实读出颜色；OVH 的 gpt-oss 120B 答 "unknown"、gpt-oss 20B 答错颜色（附图被上游丢弃），因此这两个条目仍是纯文本。附图发给不声明 `image` 的模型是上游层面的丢弃，不是本适配器的拒绝。

## 与上游的协议约定

- **端点**：`{baseURL}/chat/completions`。两条上游都用空 `Authorization: Bearer `（匿名免费层的标识）；Kilo 也接受完全不带凭据的请求，OVH 要求至少出现这个空头。
- **限流**：OVH 按出口 IP 每模型每分钟级限流，Kilo 的免费池由各家上游分别限流（实测出现过 `temporarily rate-limited upstream`），429 直接透传为 `RATE_LIMIT`，由 Auto 转移或宿主重试策略吸收。
- **不收工具表的模型**：OVH 的 Qwen2.5 VL 72B 对带 `tools` 的请求直接回 `feature 'tool calls' is not currently supported`；编码会话每轮都带工具，因此它不在目录里。Kilo 侧 `nemotron-3.5-super-vl`（502）、`nemotron-3-super-120b-a12b`（404）、`laguna-xs-2.1`（429）在实测当时不可用，同样没有收录。
- **模型路由**：只有目录里收录的模型会发往上游；未收录的 id 在适配器里以 `UNKNOWN_MODEL`
  拒绝，因为没有任何上游记录能给出它的端点与凭据。`auto` 是虚拟路由，按候选表展开。

## 出站选择

Free 渠道自己的出站方式保存在 `llm-opencode` 设置分节，取值为 `direct`（缺省）、
`pool`（内置代理池）或 `custom`（自定义代理地址 `customUrl`）。它在**设置 → 模型**
的 Free 渠道详情里编辑，经 `resolveOutbound` 在每次请求时读取，改动不需要重建注册。

选择的类型、schema 与地址解析来自 `coding-proxy-pool` 的[共享出站契约](../../net/proxy-pool/README.md#共享出站契约)，
与 DeepSeek 渠道及联网搜索提供方共用同一套规则：选 `pool` 时按池自己的出站控制
（`proxy-pool` 设置分节）取地址，池为直连或池服务缺席时本渠道回落直连，任何情况都不
让请求失败；`custom` 只用本渠道保存的地址，不受池规则影响，且要求 `customUrl` 以
`http://` 或 `https://` 开头。地址解析后经 undici 全局 dispatcher 替换生效（见
`src/outbound.ts` 的说明），Free 渠道的串行请求不受并发覆盖限制影响。

## 错误分类

地区封锁与鉴权失败都走 403，显式分类避免把地区限制报成「密钥无效」。Auto 路由的可转移
集合见下表最右列：

| 上游文本 | 稳定 code | 可重试 | Auto 可转移 |
| --- | --- | --- | --- |
| `RegionError` / `not available in your country` | `REGION_BLOCKED` | 否 | 是 |
| 其他 401/403 | `AUTH` | 否 | 是 |
| 429 / 配额耗尽 | `RATE_LIMIT` / `QUOTA_EXCEEDED` | 是 | 是 |
| 5xx | `SERVER` | 是 | 是 |
| 超时 / 传输中断 | `TIMEOUT` / `TRANSPORT` | — | 是 |
| 上下文溢出、非法请求、调用方中止 | `CONTEXT_WINDOW_EXCEEDED` 等 | 否 | 否 |

## 模型体验

### 通过本适配器发起的提供方请求

#### 模型看到的内容

请求携带系统的 system 槽、历史与工具 schema，与 `llm-pi-ai` 的转换一致；两条上游都不
要求额外工具或改写请求体。图片只有在模型声明了图片能力时才会内联，附件不可读时降级为
固定文本占位。

工具结果里的图片随结果一起内联：`browser_screenshot` 的画面与它的 JSON 出现在同一条
`toolResult` 消息里，纯文本结果仍折成字符串形式。拿不到附件服务时含图片的请求整轮以
`UNSUPPORTED_CONTENT` 拒绝，不静默丢图——模型的唯一画面来源消失比一次明确的失败更难
诊断。

#### Token 影响

被转移的 Auto 候选各消耗一次失败请求的输入 token。图片内联按各提供方的 tokenization
计入视觉 token；被降级为占位的图片不计视觉 token。

#### KV Cache 影响

两条上游都不携带会话关联头，没有跨请求的 cache 亲和；换模型或换上游都会从首个差异
token 起失效。Auto 的候选固定有序，同一会话里连续成功的候选也保持前缀稳定。

### 提供方响应

#### 模型看到的内容

响应事件被翻译为 harness 的推理、文本、工具调用、用量与结束分片；工具参数交回时重新
序列化为原始 JSON 字符串。

#### Token 影响

只有在 agent loop 记录生成内容后，它才影响后续输入。

#### KV Cache 影响

已记录响应追加到下一个请求，不会使较早的可复用前缀失效。

## 已知限制与暂缓事项

- **免费通道按出口 IP 限流并按地区提供**：这是上游策略，不是本适配器的缺陷。命中
  `REGION_BLOCKED` 时该模型在当前网络下不可用；OVH 的匿名免费层同样按出口 IP 限流
  （每模型每分钟级），Kilo 免费池由各家提供方分别限流。单模型的限流只影响它自己，
  Auto 会转移到下一个候选。
- **Kilo 免费池的提示词可能被记录**：该池的模型卡明确声明免费请求的提示词可能被上游
  保存用于改进服务，因此这条上游只适合可丢弃的内容；涉及密钥或个人数据的工作请改用
  自己的渠道。
- **Auto 只在「尚未产出内容」时转移**：一个候选已经交出正文/推理/工具调用分片后中途
  失败，不再换下一候选——拼接两种模型的半截回复比失败更糟；这类失败按原样交付。
- **只支持 `openai-completions` 一种线协议**：两条上游都只提供这条线；Zen 上少数模型
  只在 `/responses` 上服务，不在目录里。
- **目录随包发布**：服务的模型始终是 `FREE_UPSTREAMS` 里的记录，上游新增或下架的免费
  模型不会自动进入选择器，需要改这条记录并发版。本适配器没有注册模型发现，因此这条
  渠道不提供「获取可用模型」。Kilo 的免费池清单（`GET {baseURL}/models` 的 `isFree`
  切片）滚动变化，收录的是实测当时可用的条目。
- **图片能力按模型声明**：只有声明了 `image` 输入的模型会内联图片；未声明的模型按纯
  文本处理，图片不会发给它。Auto 的图片能力是候选并集，带图片的请求在纯文本候选上按
  各自上游的行为失败并转移。
