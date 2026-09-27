import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { CallId, createToolResultMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import VisionUnderstanding, { VISION_PROMPT, VISION_PROMPT_VERSION, VISION_UNDERSTANDING_SETTINGS_NAMESPACE } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const ref = {
  attachmentId: 'sha256:picture' as never,
  mediaType: 'image/png' as const,
  bytes: 128,
  width: 4,
  height: 4,
}

const policy: Config = {
  provider: 'vision',
  model: 'vision-model',
  maxImagesPerRequest: 8,
  maxImageBytesPerRequest: 1024,
  maxDescriptionChars: 100,
  maxOutputTokens: 64,
  timeoutMs: 1000,
}

function withPolicy(overrides: Partial<Config>): Config {
  return Object.assign({}, policy, overrides)
}

function withoutRoute(): Config {
  return {
    maxImagesPerRequest: policy.maxImagesPerRequest,
    maxImageBytesPerRequest: policy.maxImageBytesPerRequest,
    maxDescriptionChars: policy.maxDescriptionChars,
    maxOutputTokens: policy.maxOutputTokens,
    timeoutMs: policy.timeoutMs,
  }
}

function response(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class VisionAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  outputs: StreamChunk[][] = []
  imageCapable = true
  onStream?: () => void

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: this.imageCapable ? ['text', 'image'] : ['text'],
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    this.onStream?.()
    yield* this.outputs.shift() ?? response('visible diagram')
  }
}

class TextAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield* response('main model reached')
  }
}

class MemorySettings extends SettingsProvider {
  get writable(): boolean { return true }
  protected override load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected override persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> { return Promise.resolve() }
}

let ctx: Context | undefined

afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

async function fixture(config: Config = policy, withSettings = false): Promise<{
  session: Session
  adapter: VisionAdapter
  fallback: VisionUnderstanding
}> {
  ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  if (withSettings) await ctx.plugin(MemorySettings)
  await ctx.plugin(VisionUnderstanding, config)
  const adapter = new VisionAdapter()
  ctx.llm.registerAdapter(['vision'], adapter)
  const session = ctx.sessions.create(SessionId('vision-fallback-test'))
  return { session, adapter, fallback: ctx.visionUnderstanding }
}

function appendImage(session: Session): number {
  return session.append('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'What is shown?' }, { type: 'image', attachment: ref }],
  }), { surfaceOp: 'append' }).seq
}

describe('durable text-only image fallback', () => {
  it('mounts from the base bundle without an explicit route', async () => {
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(VisionUnderstanding)
    expect(ctx.visionUnderstanding.status()).toEqual({ configured: false })
  })

  it('stops the real agent loop before dispatching a text-only main model when no vision route is configured', async () => {
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(VisionUnderstanding)
    await ctx.plugin(AgentLoop, { agents: [] })
    const main = new TextAdapter()
    ctx.llm.registerAdapter(['text'], main)
    const agent = ctx.agentLoop.create(SessionId('vision-loop-rejection'), { provider: 'text', model: 'plain' })
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] }))
    await idle
    expect(main.calls).toHaveLength(0)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error' } },
    })
    const end = agent.session.events.at(-1)
    if (end?.type === 'turn/end' && end.data.reason.kind === 'error') {
      expect(end.data.reason.error.message).toContain('configure vision-understanding')
    }
    expect(agent.session.events.some(event => event.type === 'vision/description')).toBe(false)
  })

  it('routes a real image turn through durable vision replacement and reuses it after seeded resume', async () => {
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(VisionUnderstanding, policy)
    await ctx.plugin(AgentLoop, { agents: [] })
    const main = new TextAdapter()
    const vision = new VisionAdapter()
    vision.outputs = [[
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'private visual reasoning' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'private visual reasoning' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'visible diagram' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'visible diagram' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]]
    ctx.llm.registerAdapter(['text'], main)
    ctx.llm.registerAdapter(['vision'], vision)
    const agent = ctx.agentLoop.create(SessionId('vision-loop-success'), { provider: 'text', model: 'plain' })
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Read the diagram' }, { type: 'image', attachment: ref }],
    }))
    await idle

    expect(vision.calls).toHaveLength(1)
    expect(main.calls).toHaveLength(1)
    expect(main.calls[0]?.messages).toEqual(agent.session.deriveMessages().slice(0, -1))
    expect(main.calls[0]?.messages[0]?.content).toEqual([
      { type: 'text', text: 'Read the diagram' },
      { type: 'text', text: '[Image description: visible diagram]' },
    ])
    expect(main.calls[0]?.messages.every(message => message.content.every(block => block.type !== 'image'))).toBe(true)
    expect(JSON.stringify(main.calls[0]?.messages)).not.toContain('private visual reasoning')
    const original = agent.session.events.find(event => event.type === 'user/message' && event.surfaceOp === 'append')
    expect(original).toMatchObject({ data: { content: [{ type: 'text' }, { type: 'image', attachment: ref }] } })
    const request = agent.session.events.find(event => event.type === 'vision/request')
    const description = agent.session.events.find(event => event.type === 'vision/description')
    expect(request).toMatchObject({ data: { attachment: ref, sourceSeq: original?.seq, system: VISION_PROMPT } })
    expect(description).toMatchObject({ data: { sourceSeq: original?.seq, requestSeqs: [request?.seq], descriptions: ['visible diagram'] } })
    expect(JSON.stringify(description)).not.toContain('private visual reasoning')
    expect(JSON.stringify(agent.session.events)).not.toContain('private visual reasoning')
    expect(agent.session.events.find(event => event.type === 'user/message' && event.surfaceOp !== 'append'))
      .toMatchObject({ surfaceOp: { op: 'replace', start: original?.seq, end: original?.seq } })

    const seeded = structuredClone(agent.session.events)
    const restored = await ctx.agents.create({
      sessionId: SessionId('vision-loop-restored'),
      seed: seeded,
      agentOptions: { provider: 'text', model: 'plain' },
    })
    expect(restored.agent.session.deriveMessages()).toEqual(agent.session.deriveMessages())
    const resumedIdle = restored.agent.whenIdle()
    restored.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue' }] }))
    await resumedIdle
    expect(vision.calls).toHaveLength(1)
    expect(main.calls).toHaveLength(2)
    expect(main.calls[1]?.messages).toEqual(restored.agent.session.deriveMessages().slice(0, -1))
    expect(main.calls[1]?.messages.every(message => message.content.every(block => block.type !== 'image'))).toBe(true)
    expect(restored.agent.session.events.find(event => event.type === 'user/message' && event.surfaceOp === 'append'))
      .toMatchObject({ data: { content: [{ type: 'text' }, { type: 'image', attachment: ref }] } })
  })

  it('records exact provenance and replaces one user node without losing the source image', async () => {
    const { session, adapter, fallback } = await fixture()
    const originalSeq = appendImage(session)
    adapter.onStream = () => {
      expect(session.events.at(-1)).toMatchObject({
        type: 'vision/request',
        data: {
          sourceSeq: originalSeq,
          attachment: ref,
          provider: 'vision',
          model: 'vision-model',
          system: VISION_PROMPT,
          promptVersion: VISION_PROMPT_VERSION,
          maxTokens: 64,
        },
      })
    }
    await fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal)
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]).toMatchObject({
      provider: 'vision', model: 'vision-model', system: VISION_PROMPT,
      tools: [], maxTokens: 64,
      messages: [{ content: [{ type: 'image', attachment: ref }] }],
    })
    expect(session.events[originalSeq]?.type).toBe('user/message')
    expect(session.events[originalSeq]).toMatchObject({ data: { content: [{ type: 'text' }, { type: 'image' }] } })
    expect(session.deriveMessages()[0]?.content).toEqual([
      { type: 'text', text: 'What is shown?' },
      { type: 'text', text: '[Image description: visible diagram]' },
    ])
    const fact = session.events.find(event => event.type === 'vision/description')
    const request = session.events.find(event => event.type === 'vision/request')
    expect(fact).toMatchObject({
      data: {
        sourceSeq: originalSeq,
        attachments: [ref],
        requestSeqs: [request?.seq],
        prompt: VISION_PROMPT,
        promptVersion: 1,
        provider: 'vision',
        model: 'vision-model',
        descriptions: ['visible diagram'],
      },
    })
    const replaced = session.events.at(-1)
    expect(replaced).toMatchObject({
      sourceEventSeqs: [originalSeq, fact?.seq],
      surfaceOp: { op: 'replace', start: originalSeq, end: originalSeq },
    })
    await fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal)
    expect(adapter.calls).toHaveLength(1)
  })

  it('preserves tool-call correlation while replacing nested image blocks', async () => {
    const { session, fallback } = await fixture()
    const message = createToolResultMessage({
      callId: CallId('image-call'),
      content: [{ type: 'text', text: 'Tool caption' }, { type: 'image', attachment: ref }],
      isError: false,
    })
    session.append('tool/result', { turn: 1, step: 1, message }, { surfaceOp: 'append' })
    await fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal)
    expect(session.deriveMessages()[0]?.content).toEqual([{
      type: 'tool-result',
      toolCallId: CallId('image-call'),
      content: [
        { type: 'text', text: 'Tool caption' },
        { type: 'text', text: '[Image description: visible diagram]' },
      ],
      isError: false,
    }])
  })

  it('refuses unconfigured or non-image-capable routes without changing the surface', async () => {
    const { session, adapter, fallback } = await fixture(withoutRoute())
    appendImage(session)
    await expect(fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal))
      .rejects.toThrow('configure vision-understanding.provider and model')
    expect(session.events).toHaveLength(1)
    expect(adapter.calls).toHaveLength(0)
  })

  it('fails a batch before writing any replacement if a later image description fails', async () => {
    const { session, adapter, fallback } = await fixture()
    appendImage(session)
    appendImage(session)
    adapter.outputs = [response('first'), [{ type: 'finish', reason: { kind: 'max-tokens' } }]]
    await expect(fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal))
      .rejects.toThrow('max-tokens')
    expect(session.events.filter(event => event.type === 'vision/request')).toHaveLength(2)
    expect(session.events.some(event => event.type === 'vision/description')).toBe(false)
    expect(session.deriveMessages().every(message => message.content.some(block => block.type === 'image'))).toBe(true)
  })

  it('keeps an already committed node and retries only unresolved images after a write failure', async () => {
    const { session, adapter, fallback } = await fixture()
    appendImage(session)
    appendImage(session)
    const originalAppend = session.append.bind(session)
    const patch = vi.spyOn(session, 'append').mockImplementation(((...args: Parameters<Session['append']>) => {
      if (args[0] === 'vision/description' && session.events.some(event => event.type === 'vision/description')) {
        throw new Error('simulated second-node write failure')
      }
      return Reflect.apply(originalAppend, session, args) as ReturnType<Session['append']>
    }))
    await expect(fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal))
      .rejects.toThrow('simulated second-node write failure')
    patch.mockRestore()
    expect(session.events.filter(event => event.type === 'vision/description')).toHaveLength(1)
    expect(adapter.calls).toHaveLength(2)
    await fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal)
    expect(adapter.calls).toHaveLength(3)
    expect(session.deriveMessages().every(message => message.content.every(block => block.type !== 'image'))).toBe(true)
  })

  it('refuses an over-budget image batch before opening the vision route', async () => {
    const { session, adapter, fallback } = await fixture(withPolicy({ maxImageBytesPerRequest: 127 }))
    appendImage(session)
    await expect(fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal))
      .rejects.toThrow('image batch exceeds')
    expect(adapter.calls).toHaveLength(0)
    expect(session.events).toHaveLength(1)
  })

  it('rejects tool calls even if the adapter also emits a text description', async () => {
    const { session, adapter, fallback } = await fixture()
    appendImage(session)
    adapter.outputs = [[
      ...response('partial').slice(0, 3),
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]]
    await expect(fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal))
      .rejects.toThrow('must not return tool calls')
    expect(session.events.filter(event => event.type === 'vision/request')).toHaveLength(1)
    expect(session.events.some(event => event.type === 'vision/description')).toBe(false)
  })

  it('records the request but no replacement when the visual stream ends without finish', async () => {
    const { session, adapter, fallback } = await fixture()
    appendImage(session)
    adapter.outputs = [response('partial').slice(0, 3)]
    await expect(fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal))
      .rejects.toThrow('without a finish chunk')
    expect(session.events.filter(event => event.type === 'vision/request')).toHaveLength(1)
    expect(session.events.some(event => event.type === 'vision/description')).toBe(false)
    expect(session.deriveMessages()[0]?.content.some(block => block.type === 'image')).toBe(true)
  })

  it('rejects duplicate finish chunks without committing a description', async () => {
    const { session, adapter, fallback } = await fixture()
    appendImage(session)
    adapter.outputs = [[...response('done'), { type: 'finish', reason: { kind: 'stop' } }]]
    await expect(fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal))
      .rejects.toThrow('after its finish')
    expect(session.events.filter(event => event.type === 'vision/request')).toHaveLength(1)
    expect(session.events.some(event => event.type === 'vision/description')).toBe(false)
  })

  it('leaves the pre-dispatch request fact on cancellation', async () => {
    const { session, adapter, fallback } = await fixture()
    const sourceSeq = appendImage(session)
    const controller = new AbortController()
    adapter.onStream = () => { controller.abort(new Error('user cancelled vision')) }
    await expect(fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], controller.signal))
      .rejects.toThrow('user cancelled vision')
    expect(session.events.filter(event => event.type === 'vision/request')).toMatchObject([{ data: { sourceSeq } }])
    expect(session.events.some(event => event.type === 'vision/description')).toBe(false)
  })

  it('bounds empty stream chunks and text-block count independently of output characters', async () => {
    const { session, adapter, fallback } = await fixture()
    appendImage(session)
    adapter.outputs = [Array.from({ length: 2049 }, () => ({ type: 'text-delta', index: 0, text: '' }))]
    await expect(fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal))
      .rejects.toThrow('exceeds 2048 chunks')
    adapter.outputs = [[
      ...Array.from({ length: 17 }, (_, index): StreamChunk => ({ type: 'block-start', index, blockType: 'text' })),
      { type: 'finish', reason: { kind: 'stop' } },
    ]]
    await expect(fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal))
      .rejects.toThrow('exceeds 16 text blocks')
    expect(session.events.filter(event => event.type === 'vision/request')).toHaveLength(2)
    expect(session.events.some(event => event.type === 'vision/description')).toBe(false)
  })

  it('bounds discarded private reasoning without persisting it', async () => {
    const { session, adapter, fallback } = await fixture()
    appendImage(session)
    adapter.outputs = [[
      { type: 'reasoning-delta', index: 0, text: 'x'.repeat(16_385) },
      ...response('safe'),
    ]]
    await expect(fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal))
      .rejects.toThrow('exceeds 16384 reasoning characters')
    adapter.outputs = [[
      ...Array.from({ length: 17 }, (_, index): StreamChunk => ({ type: 'block-start', index, blockType: 'reasoning' })),
      ...response('safe'),
    ]]
    await expect(fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal))
      .rejects.toThrow('exceeds 16 reasoning blocks')
    expect(session.events.filter(event => event.type === 'vision/request')).toHaveLength(2)
    expect(session.events.some(event => event.type === 'vision/description')).toBe(false)
    expect(JSON.stringify(session.events)).not.toContain('x'.repeat(16_385))
  })

  it('refuses forged replacement content and changed user identity despite valid provenance refs', async () => {
    const { session } = await fixture()
    const sourceSeq = appendImage(session)
    const original = session.events[sourceSeq]
    if (original?.type !== 'user/message') throw new Error('missing user source fixture')
    const request = session.append('vision/request', {
      sourceSeq,
      attachment: ref,
      provider: 'vision',
      model: 'vision-model',
      maxTokens: 64,
      system: VISION_PROMPT,
      promptVersion: VISION_PROMPT_VERSION,
    })
    const fact = session.append('vision/description', {
      sourceSeq,
      attachments: [ref],
      requestSeqs: [request.seq],
      prompt: VISION_PROMPT,
      promptVersion: VISION_PROMPT_VERSION,
      provider: 'vision',
      model: 'vision-model',
      descriptions: ['visible diagram'],
    })
    const marker = { surfaceOp: { op: 'replace' as const, start: sourceSeq, end: sourceSeq }, sourceEventSeqs: [sourceSeq, fact.seq] }
    const replacement = [
      { type: 'text' as const, text: 'What is shown?' },
      { type: 'text' as const, text: '[Image description: visible diagram]' },
    ]
    expect(() => session.append('user/message', { ...original.data, content: [
      { type: 'text', text: 'What is shown?' }, { type: 'text', text: 'forged' },
    ] }, marker)).toThrow('must exactly substitute')
    expect(() => session.append('user/message', {
      ...original.data,
      source: { kind: 'plugin', plugin: 'forged' },
      content: replacement,
    }, marker)).toThrow('must preserve all source event fields')
    expect(session.surface.nodes).toEqual([sourceSeq])
  })

  it('rejects a configured model without explicit image capability', async () => {
    const { session, adapter, fallback } = await fixture()
    adapter.imageCapable = false
    appendImage(session)
    await expect(fallback.prepareHistory(session, { provider: 'text', model: 'plain' }, ['text'], new AbortController().signal))
      .rejects.toThrow('does not declare image input capability')
    expect(adapter.calls).toHaveLength(0)
    expect(session.events).toHaveLength(1)
  })

  it('leaves unknown-capability main routes to their adapters', async () => {
    const { session, adapter, fallback } = await fixture(withoutRoute())
    appendImage(session)
    await fallback.prepareHistory(session, { provider: 'unknown', model: 'new-model' }, undefined, new AbortController().signal)
    expect(adapter.calls).toHaveLength(0)
    expect(session.events).toHaveLength(1)
    expect(session.deriveMessages()[0]?.content.some(block => block.type === 'image')).toBe(true)
  })

  it('reads the settings selection and validates paired provider/model', async () => {
    const { fallback } = await fixture(withoutRoute(), true)
    expect(fallback.status()).toEqual({ configured: false })
    await expect(ctx!.settings.update(VISION_UNDERSTANDING_SETTINGS_NAMESPACE, { provider: 'vision' }))
      .rejects.toThrow('must be set together')
    await ctx!.settings.update(VISION_UNDERSTANDING_SETTINGS_NAMESPACE, { provider: 'vision', model: 'vision-model' })
    expect(fallback.status()).toEqual({ configured: true, provider: 'vision', model: 'vision-model' })
    await ctx!.settings.replace(VISION_UNDERSTANDING_SETTINGS_NAMESPACE, {})
    expect(fallback.status()).toEqual({ configured: false })
  })
})
