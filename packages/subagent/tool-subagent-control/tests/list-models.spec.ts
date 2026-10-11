import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/list-models.ts'

class CatalogAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (provider === 'broken') return Promise.reject(new Error('catalog offline'))
    return Promise.resolve([{ provider, id: 'fast', name: 'Fast' }, { provider, id: 'reasoner', name: 'Reasoner' }])
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  const adapter = new CatalogAdapter()
  ctx.llm.registerAdapter(['route', 'broken'], adapter)
  const fiber = await ctx.plugin(plugin)
  return { ctx, fiber }
}

function call(ctx: Context, args: unknown = {}) {
  return ctx.tools.execute({
    name: 'list_subagent_models', arguments: args, callId: CallId('models'), signal: new AbortController().signal,
  })
}

function text(result: { content: { type: string; text?: string }[] }) {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('list_subagent_models', () => {
  it('returns exact provider/model identities without hiding healthy providers', async () => {
    const { ctx } = await setup()
    const result = await call(ctx)
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject([
      { provider: 'route', models: [{ id: 'fast' }, { id: 'reasoner' }] },
      { provider: 'broken', error: 'catalog offline', models: [] },
    ])
    expect(text(result)).toContain('route')
    expect(text(result)).toContain('reasoner')
    expect(text(result)).toContain('catalog offline')
  })

  it('unregisters its tool with the plugin fiber', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.tools.schemas().some(schema => schema.name === 'list_subagent_models')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'list_subagent_models')).toBe(false)
  })
})
