import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import BrowserUseService from '../../browser/src/index.ts'
import type { BrowserCapture, BrowserCommand } from '@deepseek-ai/dsh-browser'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as ToolBrowser from '../src/index.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const observation = {
  generation: 'g1', revision: 1, url: 'https://example.com', title: 'Example',
  snapshot: '[e1] button Continue', viewport: { width: 800, height: 600 }, cursor: null,
}

class FakeBrowser extends BrowserUseService {
  readonly commands = vi.fn(async (
    _id: ReturnType<typeof SessionId>, command: BrowserCommand, signal: AbortSignal,
  ): Promise<BrowserCapture> => {
    signal.throwIfAborted()
    return { observation, png: command.kind === 'screenshot' ? PNG : null }
  })
  execute(id: ReturnType<typeof SessionId>, command: BrowserCommand, signal: AbortSignal): Promise<BrowserCapture> {
    return this.commands(id, command, signal)
  }
  readonly latest = vi.fn((_id: ReturnType<typeof SessionId>): BrowserCapture | undefined => undefined)
  closeSession(): Promise<void> { return Promise.resolve() }
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup(approval = true) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-browser-tool-'))
  directories.push(home)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(FakeBrowser)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  if (approval) await ctx.plugin(ApprovalService)
  const fiber = await ctx.plugin(ToolBrowser)
  const agent = {
    session: {
      id: SessionId('browser-test'), header: { cwd: home },
      events: [{ type: 'turn/start' }, { type: 'user/message' }],
      append: vi.fn(() => ({})),
    },
  }
  const call = (args: unknown, signal = new AbortController().signal) => ctx.tools.execute({
    name: 'browser_use', callId: CallId('browser-call'), arguments: args, signal, agent: agent as never,
  })
  return { ctx, call, agent, fiber }
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('browser_use', () => {
  it('shows a bounded target origin rather than URL secrets for each navigation approval', async () => {
    const { ctx, call, agent } = await setup()
    const browser = ctx.browserUse as FakeBrowser
    const asked = vi.fn((_req: { reason?: string }, _next: () => Promise<'rejected'>) => Promise.resolve('rejected' as const))
    ctx.on('approval/request', asked)
    const target = 'https://user:password@EXAMPLE.com/private?token=secret#fragment'
    await call({ action: 'navigate', url: target })
    expect(asked.mock.calls[0]?.[0].reason).toBe('Browser navigate (target origin: https://example.com; may redirect or load subresources; approval is for this call only)')
    expect(JSON.stringify(agent.session.append.mock.calls)).not.toMatch(/password|private|secret|fragment/)
    expect(browser.latest).not.toHaveBeenCalled()
    expect(browser.commands).not.toHaveBeenCalled()

    await call({ action: 'navigate', url: 'not a URL' })
    expect(asked.mock.calls.at(-1)?.[0].reason).toContain('target origin: invalid target')
    await call({ action: 'navigate', url: `https://${Array(5).fill('a'.repeat(60)).join('.')}.com` })
    expect(asked.mock.calls.at(-1)?.[0].reason).toContain('target origin: invalid target')
  })

  it('shows only the session’s current bounded origin and safe ref for non-navigation approvals', async () => {
    const { ctx, call, agent } = await setup()
    const browser = ctx.browserUse as FakeBrowser
    browser.latest.mockImplementation(id => id === agent.session.id ? {
      observation: { ...observation, url: 'https://user:password@EXAMPLE.com/private?token=secret#fragment' },
      png: PNG,
    } : undefined)
    const asked = vi.fn((_req: { reason?: string }, _next: () => Promise<'rejected'>) => Promise.resolve('rejected' as const))
    ctx.on('approval/request', asked)
    for (const args of [
      { action: 'click', ref: 'e1', revision: 1 },
      { action: 'fill', ref: 'e1', revision: 1, text: 'sensitive fill text' },
      { action: 'snapshot' }, { action: 'scroll', direction: 'down', pixels: 10 },
      { action: 'screenshot' }, { action: 'close' },
    ]) await call(args)
    expect(browser.latest).toHaveBeenCalledTimes(6)
    expect(browser.latest.mock.calls.every(([id]) => id === agent.session.id)).toBe(true)
    const reasons = asked.mock.calls.map(([req]) => req.reason)
    expect(reasons).toEqual([
      'Browser click ref e1 (current origin: https://example.com; approval is for this call only)',
      'Browser fill ref e1 (current origin: https://example.com; approval is for this call only)',
      ...['snapshot', 'scroll', 'screenshot', 'close'].map(action =>
        `Browser ${action} (current origin: https://example.com; approval is for this call only)`),
    ])
    expect(JSON.stringify(reasons)).not.toMatch(/password|private|secret|fragment|sensitive fill text|PNG/)
    expect(browser.commands).not.toHaveBeenCalled()

    await call({ action: 'fill', ref: 'e1\nsecret', revision: 1, text: 'hidden' })
    expect(asked.mock.calls.at(-1)?.[0].reason).toContain('ref [opaque]')
    browser.latest.mockReturnValueOnce({ observation: { ...observation, url: 'data:text/html,secret' }, png: null })
    await call({ action: 'screenshot' })
    expect(asked.mock.calls.at(-1)?.[0].reason).toContain('current origin: unknown')
    browser.latest.mockReturnValueOnce(undefined)
    await call({ action: 'snapshot' })
    expect(asked.mock.calls.at(-1)?.[0].reason).toContain('current origin: unknown')
  })

  it('denies missing approval and rejected decisions before any browser side effect', async () => {
    const absent = await setup(false)
    expect((await absent.call({ action: 'navigate', url: 'https://example.com' })).isError).toBe(true)
    expect(absent.ctx.browserUse).toBeInstanceOf(FakeBrowser)
    expect((absent.ctx.browserUse as FakeBrowser).commands).not.toHaveBeenCalled()

    const rejected = await setup()
    rejected.ctx.on('approval/request', () => Promise.resolve('rejected' as const))
    const result = await rejected.call({ action: 'navigate', url: 'https://example.com' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('approval rejected')
    expect((rejected.ctx.browserUse as FakeBrowser).commands).not.toHaveBeenCalled()
  })

  it('returns canonical observation for PTC and saves a screenshot before rendering its image block', async () => {
    const { ctx, call } = await setup()
    ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))
    const snapshot = await call({ action: 'snapshot' })
    expect(snapshot.isError).toBe(false)
    expect(snapshot.value).toEqual({ action: 'snapshot', observation, image: null })
    expect(snapshot.content).toHaveLength(1)
    const result = await call({ action: 'screenshot' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ action: 'screenshot', observation, image: { mediaType: 'image/png', width: 1, height: 1 } })
    expect(result.content.map(block => block.type)).toEqual(['text', 'image'])
    const image = (result.value as unknown as ToolBrowser.BrowserUseValue).image
    expect(result.content[1]).toMatchObject({ attachment: { attachmentId: image?.attachmentId } })
  })

  it('caps the complete text observation and fails without an image reference if storage fails', async () => {
    const { ctx, call } = await setup()
    ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))
    const browser = ctx.browserUse as FakeBrowser
    browser.commands.mockResolvedValueOnce({
      observation: { ...observation, snapshot: 'x'.repeat(30_000), title: 't'.repeat(2_000) }, png: null,
    })
    const snapshot = await call({ action: 'snapshot' })
    expect(snapshot.isError).toBe(false)
    const value = snapshot.value as unknown as ToolBrowser.BrowserUseValue
    expect(value.observation.snapshot).toHaveLength(12_000)
    expect(value.observation.title).toHaveLength(512)
    expect(text(snapshot).length).toBeLessThan(15_000)

    vi.spyOn(ctx.attachments, 'saveImage').mockRejectedValueOnce(new Error('store unavailable'))
    const failed = await call({ action: 'screenshot' })
    expect(failed.isError).toBe(true)
    expect(failed.value).toBeUndefined()
    expect(failed.content.every(block => block.type === 'text')).toBe(true)
  })

  it('rejects mismatched fields and bounds before approval or browser execution', async () => {
    const { ctx, call } = await setup()
    const asked = vi.fn(() => Promise.resolve('allowed-once' as const))
    ctx.on('approval/request', asked)
    for (const args of [
      { action: 'navigate', url: '' }, { action: 'snapshot', url: 'https://example.com' },
      { action: 'click', ref: '', revision: 1 }, { action: 'click', ref: 'e1', revision: 0 },
      { action: 'fill', ref: 'e1', revision: 1, text: 'x'.repeat(2001) },
      { action: 'scroll', direction: 'up', pixels: 2001 },
    ]) expect((await call(args)).isError).toBe(true)
    expect(asked).not.toHaveBeenCalled()
    expect((ctx.browserUse as FakeBrowser).commands).not.toHaveBeenCalled()
  })

  it('blocks a remote marker before approval without local fallback', async () => {
    const { ctx, call, agent } = await setup()
    await writeFile(join(agent.session.header.cwd, '.coding-remote-workspace.json'), JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'test', generation: 1, mode: 'basic',
    }))
    const asked = vi.fn(() => Promise.resolve('allowed-once' as const))
    ctx.on('approval/request', asked)
    const result = await call({ action: 'snapshot' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/remote workspace|remote workspaces/)
    expect(asked).not.toHaveBeenCalled()
    expect((ctx.browserUse as FakeBrowser).commands).not.toHaveBeenCalled()
  })

  it('does not execute when cancelled, and withdraws the tool on plugin disposal', async () => {
    const { ctx, call, fiber } = await setup()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    expect((await call({ action: 'snapshot' }, controller.signal)).isError).toBe(true)
    expect((ctx.browserUse as FakeBrowser).commands).not.toHaveBeenCalled()
    expect(ctx.tools.get('browser_use')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('browser_use')).toBeUndefined()
  })

  it('keeps approval cancellation ahead of browser execution', async () => {
    const { ctx, call } = await setup()
    const controller = new AbortController()
    ctx.on('approval/request', () => new Promise((resolve) => {
      controller.abort(new Error('cancelled during approval'))
      resolve('allowed-once')
    }))
    const result = await call({ action: 'snapshot' }, controller.signal)
    expect(result.isError).toBe(true)
    expect((ctx.browserUse as FakeBrowser).commands).not.toHaveBeenCalled()
  })
})
