import { Context } from '@deepseek-ai/cordis'
import { CallId } from 'coding-llm'
import { SessionId } from 'coding-session/types'
import { Session, deriveEventMessage } from 'coding-session'
import ToolRuntime from 'coding-tools'
import SystemPrompt from 'coding-system-prompt'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

const ref = { id: '0', attachmentId: 'asset-1' as never, mediaType: 'image/png' as const, bytes: 50,
  width: 1, height: 1, prompt: 'a bird', model: 'mock', createdAt: 0 }
const signal = new AbortController().signal

async function setup(variant: 'standard' | 'codex', available = true) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const session = Session.create(SessionId('test'))
  const create = async (_session: Session, prompt: string) => {
    if (prompt === 'bad') throw new Error('synthetic upstream failure')
    return { ...ref, id: String(session.seq), prompt }
  }
  const calls: string[] = []
  let serviceAvailable = available
  const listeners = new Set<() => void>()
  ctx.provide('imageGeneration', { create: async (s: Session, prompt: string) => {
    calls.push(prompt)
    return create(s, prompt)
  }, status: async () => ({ enabled: serviceAvailable, available: serviceAvailable, model: 'mock' }),
  watchAvailability: (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  latestImages: () => [ref], canvas: (events: typeof session.events) => {
    const last = events.findLast(event => event.type === 'image-gen/canvas')
    return last?.type === 'image-gen/canvas' ? last.data : { revision: 0, state: { version: 1, nodes: [] } }
  } } as never)
  await apply(ctx, { variant })
  const agent = { session } as never
  const execute = (name: string, args: object) => ctx.tools.execute({ name, arguments: args, agent, signal, callId: CallId('call-1') })
  return { ctx, session, execute, calls, listeners, setAvailable: (value: boolean) => {
    serviceAvailable = value
    for (const listener of listeners) listener()
  } }
}

describe('image tool variants and replayable image blocks', () => {
  it.each(['standard', 'codex'] as const)('omits %s image tools until the service is available, then revokes them', async (variant) => {
    const env = await setup(variant, false)
    const names = () => env.ctx.tools.schemas().map(tool => tool.name)
    const expected = variant === 'codex' ? ['image_gen'] : ['generate_image', 'generate_images', 'canvas_state', 'edit_image']
    expect(names()).toEqual([])

    env.setAvailable(true)
    await vi.waitFor(() => { expect(names()).toEqual(expected) })

    env.setAvailable(false)
    await vi.waitFor(() => { expect(names()).toEqual([]) })
    await env.ctx.fiber.dispose()
    expect(env.listeners.size).toBe(0)
  })

  it('keeps only the newest availability result and ignores a result after disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const pending: Array<(available: boolean) => void> = []
    const listeners = new Set<() => void>()
    ctx.provide('imageGeneration', {
      status: () => new Promise((resolve) => {
        pending.push((available) => { resolve({ enabled: available, available, model: 'mock' }) })
      }),
      watchAvailability: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    } as never)
    const tools = ctx.tools
    const activation = apply(ctx)
    expect(tools.schemas()).toEqual([])
    for (const listener of listeners) listener()
    pending[1]?.(true)
    await vi.waitFor(() => { expect(tools.schemas()).toHaveLength(4) })
    pending[0]?.(false)
    await activation
    expect(tools.schemas()).toHaveLength(4)

    for (const listener of listeners) listener()
    await ctx.fiber.dispose()
    expect(listeners.size).toBe(0)
    pending[2]?.(true)
    await Promise.resolve()
    expect(tools.schemas()).toEqual([])
  })

  it('registers only Codex imagegen, rejects unsupported references and backgrounds', async () => {
    const env = await setup('codex')
    expect(env.ctx.tools.schemas().map(tool => tool.name)).toEqual(['image_gen'])
    const paths = await env.execute('image_gen', { prompt: 'bird', referenced_image_paths: ['/tmp/secret.png'] })
    expect(paths.isError).toBe(true)
    const transparent = await env.execute('image_gen', { prompt: 'bird', transparent_background: true })
    expect(transparent.isError).toBe(true)
    expect(env.calls).toEqual([])
    const generated = await env.execute('image_gen', { prompt: 'bird', num_last_images_to_include: 1 })
    expect(generated.isError).toBe(false)
    expect(generated.content[1]).toEqual({ type: 'image', attachment: {
      attachmentId: 'asset-1', mediaType: 'image/png', bytes: 50, width: 1, height: 1,
    } })
    await env.ctx.fiber.dispose()
  })

  it('isolates batch errors, retains images in tool/result for model replay', async () => {
    const env = await setup('standard')
    expect(env.ctx.tools.schemas().map(tool => tool.name)).toEqual(['generate_image', 'generate_images', 'canvas_state', 'edit_image'])
    env.session.append('image-gen/canvas', { revision: 1, state: { version: 1, nodes: [
      { id: 'photo', type: 'image', imageId: 'gallery-7', x: 10, y: 20, width: 50, height: 40 },
      { id: 'paint', type: 'stroke', points: [{ x: 5, y: 6 }], width: 3, color: 'ink' },
    ] } })
    const canvas = await env.execute('canvas_state', {})
    expect(canvas.value).toMatchObject({ revision: 1, nodes: [
      { id: 'photo', imageId: 'gallery-7', type: 'image' }, { id: 'paint', pointCount: 1, type: 'stroke' },
    ] })
    expect(canvas.content[0]).toMatchObject({ type: 'text' })
    const batch = await env.execute('generate_images', { prompts: ['first', 'bad', 'last'] })
    expect(batch.isError).toBe(false)
    expect(batch.content.filter(block => block.type === 'image')).toHaveLength(2)
    expect(batch.value).toMatchObject({ failures: [{ index: 1 }], images: [{ index: 0 }, { index: 2 }] })
    const message = { id: 'tool-message' as never, role: 'user' as const,
      source: { kind: 'tool' as const, callId: CallId('call-1') },
      content: [{ type: 'tool-result' as const, toolCallId: CallId('call-1'), content: batch.content }] as [
        { type: 'tool-result'; toolCallId: ReturnType<typeof CallId>; content: typeof batch.content },
      ] }
    env.session.append('tool/result', { turn: 0, step: 0, message }, { surfaceOp: 'append' })
    const replayed = env.session.events.at(-1)
    expect(replayed).toBeDefined()
    expect(deriveEventMessage(replayed!)?.content[0]).toMatchObject({ type: 'tool-result', content: batch.content })
    expect(env.session.deriveMessages().at(-1)?.content).toEqual(message.content)
    await env.ctx.fiber.dispose()
  })
})
