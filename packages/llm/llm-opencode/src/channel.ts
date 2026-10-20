/**
 * Free 渠道的内置事实：渠道名、路由、连接端点、匿名凭据与模型目录都定义在这里，
 * 由本项目维护，不进入任何设置分节，用户既改不到端点与凭据，也无法增删模型。
 *
 * 一条渠道可以聚合多个免费上游：{@link FREE_UPSTREAMS} 里的每条记录带自己的连接
 * 事实与模型表，{@link FREE_CHANNEL_MODELS} 把它们展开成渠道的完整目录，每个模型
 * 记得自己属于哪个上游，适配器按请求里的模型 id 选择端点与凭据。接入新的免费上游
 * 只需在这里加一条记录，选择器与设置页会随目录一起看到它。
 *
 * @module coding-llm-opencode/channel
 */

import { resolveRetryPolicy } from 'coding-llm'
import type { ModelModality, ResolvedRetryPolicy } from 'coding-llm'

/**
 * 渠道的提供方路由。它同时是会话、默认模型与设置引用模型的键，
 * 因此改名会作废既有引用。
 */
export const PROVIDER_ID = 'free'

/** 渠道在界面与选择器上的显示名；它是产品名，不随语言变化，用户改不到。 */
export const CHANNEL_NAME = 'Free'

/** 提供商空闲超时默认值：覆盖未完成的流读取，不包含消费方思考时间。 */
export const STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * 渠道的重试策略。免费上游按出口 IP 限流，突发 429 由 `dsh-llm-retry` 按这条
 * 策略吸收；确定性的 `FREE_TIER_RESTRICTED`、`REGION_BLOCKED` 不在可重试集合里。
 */
export const CHANNEL_RETRY_POLICY: ResolvedRetryPolicy = resolveRetryPolicy(undefined, 'llm-opencode: retryPolicy')

/**
 * 可转发给上游的推理档位词汇，与 pi-ai 的思考档位一致；`off` 表示省略该参数，
 * 让模型按自身默认行为推理。声明之外的拼写无法映射成请求参数。
 * `none` 是 OVH 线协议认得的「显式关闭推理」值，不在 pi-ai 的词汇里：声明了
 * 它的模型由适配器把选择器的 `off` 折算成线上的 `none`（见 adapter 的映射）。
 */
export const REASONING_EFFORT_LEVELS = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 可声明的推理档位。 */
export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number]

/** 一个免费上游在渠道目录里的模型条目。 */
export interface FreeUpstreamModel {
  /** 线协议上的模型 id。 */
  id: string
  /** 选择器显示名称。 */
  name: string
  /** 上下文容量。 */
  contextWindow: number
  /** 单次请求输出上限。 */
  maxTokens: number
  /** 模型接受的输入模态。 */
  inputModalities: readonly ModelModality[]
  /** 模型是否具备推理能力。 */
  reasoning: boolean
  /**
   * 该模型暴露的推理档位；空表示不给选择器提供档位（模型自身的推理行为不变）。
   * 档位必须是 {@link REASONING_EFFORT_LEVELS} 里的值。pi-ai 词汇内的档位按
   * 自身拼写转发 `reasoning_effort`；`none` 不进选择器（与 `off` 同义），声明
   * 它的模型把选择器的 `off` 发成线上的显式关闭值。
   */
  reasoningEfforts: readonly ReasoningEffortLevel[]
}

/**
 * 一个免费上游：连接事实与它提供的模型。端点、凭据与模型都是本包的代码事实，
 * 不经设置分节，因此不存在用户改端点或换凭据的入口。
 */
export interface FreeUpstream {
  /** 上游标识，只用于诊断与目录归属，不出现在界面上。 */
  id: string
  /** 端点基址；适配器按上游拼 `{baseURL}/chat/completions`。 */
  baseURL: string
  /**
   * 上游要求的凭据字面量。免费上游对匿名客户端只认固定值，它不是机密，
   * 因此不进凭据存储，也不出现在任何设置描述里。
   */
  apiKey: string
  /**
   * 该上游是否要求 OpenCode CLI 同形伪装：User-Agent 指纹头与请求体工具门。
   * Zen 按客户端指纹过滤免费流量因此必须伪装；OVH 的匿名免费层对任何客户端
   * 开放，伪装反而会干扰其正常的匿名鉴权。
   */
  disguise: boolean
  models: readonly FreeUpstreamModel[]
}

/**
 * 内置免费上游表。每个上游的请求形状由适配器按它的指纹决定
 * （见 `ids.ts` 的 OpenCode CLI 伪装与 `free-lane.ts` 的工具形状门），
 * 因此新增上游时除了这条记录，还要有对应的请求改写。
 *
 * OpenCode Zen 的模型显示名固定、能力取自 models.dev 的提供方元数据：
 * MiMo 与 DeepSeek V4.1 Flash 接受图片，Nemotron 3.5 Lightning 只接受文本；
 * 三者都会推理，但只有 DeepSeek V4.1 Flash 暴露可选档位。
 * OVHcloud AI Endpoints 提供持久的匿名免费层（按出口 IP 限流），凭据是
 * 空 Bearer——上游把空凭据读作匿名免费层，任何非空值都会被当成失效的
 * OAuth 令牌而 403。OVH 的能力事实以 2026-10-22 的线协议实测为准（对照
 * models.dev 的 `ovhcloud` 提供方元数据）：Qwen3.5 397B 实际接受图片并
 * 按档位调节推理深度（none 到 xhigh 都被接受且确实改变推理量），gpt-oss
 * 120B 是纯文本（附图请求被静默丢弃，模型自述看不到图片）。
 */
export const FREE_UPSTREAMS: readonly FreeUpstream[] = [
  {
    id: 'opencode-zen',
    baseURL: 'https://opencode.ai/zen/v1',
    apiKey: 'public',
    disguise: true,
    models: [
      {
        id: 'mimo-v2.6-flash-free',
        name: 'Mimo V2.6 Flash',
        contextWindow: 1_048_576,
        maxTokens: 32_768,
        inputModalities: ['text', 'image'],
        reasoning: true,
        reasoningEfforts: [],
      },
      {
        id: 'deepseek-v4.1-flash-free',
        name: 'Deepseek V4.1 Flash',
        contextWindow: 262_144,
        maxTokens: 32_768,
        inputModalities: ['text', 'image'],
        reasoning: true,
        reasoningEfforts: ['low', 'high', 'max'],
      },
      {
        id: 'nemotron-3.5-lightning-free',
        name: 'Nemotron 3.5 Lightning',
        contextWindow: 262_144,
        maxTokens: 32_768,
        inputModalities: ['text'],
        reasoning: true,
        reasoningEfforts: [],
      },
    ],
  },
  {
    id: 'ovh-ai-endpoints',
    baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    apiKey: '',
    disguise: false,
    models: [
      {
        id: 'gpt-oss-120b',
        name: 'GPT-OSS 120B (OVH)',
        contextWindow: 131_072,
        maxTokens: 32_768,
        inputModalities: ['text'],
        reasoning: true,
        reasoningEfforts: ['low', 'medium', 'high'],
      },
      {
        id: 'Qwen3.5-397B-A17B',
        name: 'Qwen3.5 397B A17B (OVH)',
        contextWindow: 262_144,
        maxTokens: 32_768,
        inputModalities: ['text', 'image'],
        reasoning: true,
        reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      },
      {
        id: 'Qwen2.5-VL-72B-Instruct',
        name: 'Qwen2.5 VL 72B (OVH)',
        contextWindow: 32_768,
        maxTokens: 8_192,
        inputModalities: ['text', 'image'],
        reasoning: false,
        reasoningEfforts: [],
      },
    ],
  },
]

/** 渠道目录里的一条模型：上游模型事实加上它所属的上游。 */
export interface FreeChannelModel extends FreeUpstreamModel {
  /** 服务这个模型的上游；端点与凭据都从它读取。 */
  upstream: FreeUpstream
}

/**
 * 渠道服务的完整目录，按上游表展开。适配器只用它回答模型列表、能力与请求路由，
 * 因此目录与上游表不会出现两份事实。
 */
export const FREE_CHANNEL_MODELS: readonly FreeChannelModel[] = FREE_UPSTREAMS.flatMap(upstream =>
  upstream.models.map(model => ({ ...model, upstream })))

/**
 * 按模型 id 找目录条目。
 * @param id - 请求里的模型 id。
 * @returns 该模型及其上游，未收录时为 undefined。
 */
export function freeChannelModel(id: string): FreeChannelModel | undefined {
  return FREE_CHANNEL_MODELS.find(model => model.id === id)
}

/**
 * `Auto` 虚拟模型的 id：不出现在上游目录里，由适配器按候选表逐个转发，
 * 是渠道的默认推荐选择。
 */
export const AUTO_MODEL_ID = 'auto'

/** `Auto` 在选择器上的显示名；与渠道名一样是不随语言变化的产品名。 */
export const AUTO_MODEL_NAME = 'Auto'

/**
 * Auto 的候选顺序即尝试顺序：一次请求按序尝试，命中确定性失败（地区封锁、
 * 通道受限、鉴权无效）或最后一个候选时停止。顺序是可用性优先：能力最强、
 * 最常用的模型在前；Zen 与 OVH 交替，单上游整段限流时尽快切到另一家。
 */
const AUTO_CANDIDATE_IDS = [
  'mimo-v2.6-flash-free',
  'deepseek-v4.1-flash-free',
  'gpt-oss-120b',
  'Qwen3.5-397B-A17B',
  'nemotron-3.5-lightning-free',
] as const

/** Auto 的候选条目表；目录里不存在的 id 在这里会直接被过滤掉。 */
export const AUTO_MODEL_CANDIDATES: readonly FreeChannelModel[] = AUTO_CANDIDATE_IDS
  .map(id => freeChannelModel(id))
  .filter((model): model is FreeChannelModel => model !== undefined)
