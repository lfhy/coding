/** 面向模型列出当前已注册路由提供的模型 ID，不把目录当作路由权限表。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from 'coding-tools'
import type {} from 'coding-llm'

export const name = 'tool-subagent-models'
export const inject = ['tools', 'llm']

/**
 * 注册按需发现模型的全局工具。
 * @param ctx - 工具注册表和当前模型目录。
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'list_subagent_models',
    description: 'List model ids currently advertised by registered providers for use with subagent or subagent_fork. Returns provider and model separately; an unlisted id may still be routable. A provider whose catalog fails reports its error instead of hiding other providers.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            provider: { type: 'string', required: true },
            name: { type: 'string', required: true },
            models: { type: 'array', required: true, items: {
              type: 'object', additionalProperties: false,
              properties: { id: { type: 'string', required: true }, name: { type: 'string', required: true } },
            } },
            error: { type: 'string' },
          },
        },
      },
      render: (_args, entries) => [{
        type: 'text',
        text: entries.length === 0 ? '(no registered model providers)' : entries.map(entry =>
          entry.error === undefined
            ? `${entry.provider} (${entry.name}): ${entry.models.map(model => `${model.id} (${model.name})`).join(', ') || '(no listed models)'}`
            : `${entry.provider} (${entry.name}): catalog unavailable: ${entry.error}`,
        ).join('\n'),
      }],
    },
    async execute(_args, exec) {
      const entries = await Promise.all(ctx.llm.listProviders().map(async (provider) => {
        try {
          const models = await ctx.llm.listModels(provider.id)
          exec.signal.throwIfAborted()
          return { provider: provider.id, name: provider.name, models: models.map(model => ({ id: model.id, name: model.name })) }
        } catch (error: unknown) {
          exec.signal.throwIfAborted()
          return { provider: provider.id, name: provider.name, models: [], error: error instanceof Error ? error.message : String(error) }
        }
      }))
      return entries
    },
  }))
}
