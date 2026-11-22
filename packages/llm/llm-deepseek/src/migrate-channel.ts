/** 将旧 DeepSeek 的有效设置投影为自定义渠道，不读取或复制凭据值。 */
import type { Config as PiAiConfig, PiAiProviderProfile, PiAiReasoningEfforts } from 'coding-llm-pi-ai'
import { settingsNamespace } from 'coding-settings'
import type { DeepSeekConnectionOptions } from './adapter.ts'

export const CUSTOM_CHANNELS = settingsNamespace('llm-pi-ai')
export const LEGACY_ROUTE = 'deepseek-official'

const DEFAULT_EFFORTS = ['off', 'low', 'high', 'max'] as const

/**
 * 保留旧路由的用户选择与确切请求默认值；代理由通用渠道在请求时重新解析。
 * @param connection - 整体通过验证的旧渠道配置。
 * @param displayName - 旧渠道的生效名称。
 * @returns 不含密钥值的自定义渠道配置。
 */
export function migratedProfile(connection: DeepSeekConnectionOptions, displayName: string): PiAiProviderProfile {
  const { mode, initialDelayMs, maxDelayMs, jitterRatio } = connection.retryPolicy
  const backoff = { initialDelayMs, maxDelayMs, jitterRatio }
  return {
    displayName,
    api: connection.api,
    baseURL: connection.baseURL,
    apiKeyEnv: connection.apiKeyEnv,
    userAgent: connection.userAgent,
    outbound: connection.outbound,
    retryPolicy: connection.retryPolicy.mode === 'normal' ? {
      mode: 'normal', maxRetries: connection.retryPolicy.maxRetries, retryableCodes: [...connection.retryPolicy.retryableCodes], backoff,
    } : { mode, backoff },
    streamIdleTimeoutMs: connection.streamIdleTimeoutMs,
    maxRequestImageBytes: connection.maxRequestImageBytes,
    defaultContextWindow: connection.defaultContextWindow,
    defaultMaxTokens: connection.maxTokens,
    completionsThinkingFormat: 'deepseek',
    models: connection.models.map((model) => {
      const efforts = connection.defaults.thinking === 'disabled' ? ['off'] as const
        : DEFAULT_EFFORTS.filter(level => model.reasoningEfforts?.includes(level) ?? true)
      const defaultEffort = connection.defaults.reasoningEffort
      const defaultReasoningEffort = defaultEffort === undefined ? efforts.at(-1)
        : efforts.find(level => level === defaultEffort) ?? efforts[0]
      const reasoningEfforts: PiAiReasoningEfforts = {}
      for (const level of efforts) reasoningEfforts[level] = level === 'off' ? null : level
      return {
        id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.api === undefined ? {} : { api: model.api },
        contextWindow: model.contextWindow ?? connection.defaultContextWindow,
        maxTokens: model.maxTokens ?? connection.maxTokens,
        input: model.inputModalities ?? ['text'],
        reasoningEfforts: efforts.some(level => level !== 'off') ? reasoningEfforts : false,
        ...defaultReasoningEffort === undefined || !efforts.some(level => level !== 'off') ? {} : { defaultReasoningEffort },
      }
    }),
  }
}

/**
 * 目标已接管时停止发布旧渠道：手工配置的同名路由优先，也不覆写它。
 * @param value - 通用渠道的已验证配置；该插件未注册时为空。
 * @returns 是否应由通用渠道持有路由，删除已迁移渠道时也返回真。
 */
export function customOwnsLegacyRoute(value: unknown): boolean {
  const config = value as PiAiConfig | undefined
  return config?.migratedDeepSeek === true || Object.hasOwn(config?.providers ?? {}, LEGACY_ROUTE)
}
