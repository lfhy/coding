/** 在同一插件 fiber 上注册和原地更新可配置渠道。 */

import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle, LlmAdapter, LlmConfigurableProvider } from 'coding-llm'
import { deepEqualJson } from 'coding-settings'

interface ChannelDirectory {
  entries: readonly LlmConfigurableProvider[]
  routes: readonly string[]
}

/**
 * 将已解析渠道交给运行时；卸载随插件 fiber 清理，热更新不撤回在用的注册。
 * @param ctx - 拥有渠道的插件上下文，须注入 llm。
 * @param adapter - 由来源提供模型描述和请求实现的适配器。
 * @param read - 读取同一设置代的全部目录条目及已启用路由。
 * @returns 设置变更回调；拒绝的更新保留原注册，并记录原因。
 */
export function registerChannels(ctx: Context, adapter: LlmAdapter, read: () => ChannelDirectory): () => void {
  let registration: AdapterRegistrationHandle | undefined
  let routeFacts: unknown
  const updateRoutes = (routes: readonly string[]): void => {
    const facts = [...routes].sort().map(provider => ({
      provider,
      name: adapter.providerInfo(provider).name,
      retryPolicy: adapter.providerRetryPolicy(provider),
    }))
    if (deepEqualJson(routeFacts, facts)) return
    if (registration !== undefined) registration.replace([...routes])
    else if (routes.length > 0) registration = ctx.llm.registerAdapter([...routes], adapter)
    routeFacts = facts
  }

  const initial = read()
  let directory = initial.entries.length === 0 ? undefined : ctx.llm.registerConfigurableProviders(initial.entries)
  let entries = initial.entries
  updateRoutes(initial.routes)
  return () => {
    const next = read()
    // 路由变更事件发出时，设置界面应已能读到同一代目录名称。
    if (!deepEqualJson(entries, next.entries)) {
      try {
        if (directory === undefined) directory = ctx.llm.registerConfigurableProviders(next.entries)
        else directory.replace(next.entries)
        entries = next.entries
      } catch (error) {
        ctx.logger.error('llm: keeping the previous configurable-channel directory after a refused update', error)
      }
    }
    try {
      updateRoutes(next.routes)
    } catch (error) {
      ctx.logger.error('llm: keeping the previously registered channels after a refused update', error)
    }
  }
}
