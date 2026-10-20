import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LlmRuntime, { createUserMessage, LlmAdapter } from 'coding-llm'
import type { GenerateOptions, StreamChunk } from 'coding-llm'
import SessionStore, { SessionId } from 'coding-session'
import SessionTitleService from 'coding-session-title'
import { SettingsProvider } from 'coding-settings'
import type { SettingsNamespace } from 'coding-settings'
import { SESSION_TITLE_MODEL_SETTINGS_NAMESPACE } from 'coding-session-title-llm'
import * as providerPlugin from 'coding-session-title-first-prompt-llm'

/** 内存设置提供方：测试只需要一个可写的设置分节。 */
class MemorySettings extends SettingsProvider {
  /** 存储层当前持有的原始文档。 */
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
  }
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'Model generated title' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const TITLE_CONFIG = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } as const
const LLM_CONFIG = {
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 1_000,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
} as const

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** 挂载模型、设置、标题服务与首消息提供方，并返回已登记的适配器。 */
async function fixture(config: Record<string, unknown> = LLM_CONFIG): Promise<{
  ctx: Context
  adapter: RecordingAdapter
}> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(SessionTitleService, TITLE_CONFIG)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['title-route', 'main-route'], adapter)
  await ctx.plugin(providerPlugin, config as never)
  return { ctx, adapter }
}

/** 追加一条合格的用户消息。 */
function prompt(ctx: Context, id: string): void {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '给这个会话起个标题' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('session-title model settings', () => {
  it('titles a session with the configured custom model before any conversation request', async () => {
    const { ctx, adapter } = await fixture()
    await ctx.settings.update(SESSION_TITLE_MODEL_SETTINGS_NAMESPACE, {
      mode: 'custom',
      provider: 'title-route',
      model: 'title-model',
    })
    prompt(ctx, 'custom-title')

    await settle()

    expect(adapter.requests[0]).toMatchObject({ provider: 'title-route', model: 'title-model' })
    expect(ctx.sessionTitle.get(ctx.sessions.get(SessionId('custom-title'))!)).toMatchObject({
      title: 'Model generated title',
      source: {
        kind: 'provider',
        provider: 'session-title-first-prompt-llm',
        model: { provider: 'title-route', model: 'title-model' },
      },
    })
  })

  it('keeps the local fallback title and issues no model request when title generation is off', async () => {
    const { ctx, adapter } = await fixture()
    await ctx.settings.update(SESSION_TITLE_MODEL_SETTINGS_NAMESPACE, { mode: 'off' })
    prompt(ctx, 'off-title')

    await settle()

    expect(adapter.requests).toHaveLength(0)
    expect(ctx.sessionTitle.get(ctx.sessions.get(SessionId('off-title'))!)).toMatchObject({
      source: { kind: 'fallback' },
    })
  })

  it('inherits the conversation model route while no title model is configured', async () => {
    const { ctx, adapter } = await fixture()
    const session = ctx.sessions.create(SessionId('inherit-title'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '给这个会话起个标题' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await settle()
    // 会话还没有记录主请求路由，标题请求必须等待它。
    expect(adapter.requests).toHaveLength(0)

    session.append('request/header', {
      header: { config: { provider: 'main-route', model: 'main-model' } },
      reason: 'initial',
    })
    await settle()

    expect(adapter.requests[0]).toMatchObject({ provider: 'main-route', model: 'main-model' })
    expect(ctx.sessionTitle.get(session)).toMatchObject({ title: 'Model generated title' })
  })

  it('registers the title model settings namespace with the deployment route as its base layer', async () => {
    const { ctx, adapter } = await fixture({
      ...LLM_CONFIG,
      provider: 'title-route',
      model: 'title-model',
    })
    const descriptor = ctx.settings.describe().find(entry => entry.ns === SESSION_TITLE_MODEL_SETTINGS_NAMESPACE)
    expect(descriptor).toMatchObject({
      ns: 'session-title',
      value: { mode: 'custom', provider: 'title-route', model: 'title-model' },
      base: { mode: 'custom', provider: 'title-route', model: 'title-model' },
    })

    prompt(ctx, 'deployment-route-title')
    await settle()

    expect(adapter.requests[0]).toMatchObject({ provider: 'title-route', model: 'title-model' })
  })

  it('refuses a custom title model without a complete route pair', async () => {
    const { ctx } = await fixture()
    await expect(ctx.settings.update(SESSION_TITLE_MODEL_SETTINGS_NAMESPACE, { mode: 'custom' }))
      .rejects.toThrow(/custom title model requires provider and model/)
    await expect(ctx.settings.update(SESSION_TITLE_MODEL_SETTINGS_NAMESPACE, { provider: 'title-route' }))
      .rejects.toThrow(/provider and model must be set together/)
  })
})
