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
 */
export const REASONING_EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

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
   * 档位必须是 {@link REASONING_EFFORT_LEVELS} 里的值，否则无法转发成上游参数。
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
 */
export const FREE_UPSTREAMS: readonly FreeUpstream[] = [
  {
    id: 'opencode-zen',
    baseURL: 'https://opencode.ai/zen/v1',
    apiKey: 'public',
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
