import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import BrowserUseService from '../../browser/src/index.ts'
import type { BrowserCapture, BrowserCommand, BrowserExpectedTarget, BrowserHumanCommand, BrowserSessionState, BrowserTabId } from '@deepseek-ai/dsh-browser'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as ToolBrowser from '../src/index.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const observation = {
  tabId: 'tab-1' as BrowserTabId, generation: 'g1', revision: 1, url: 'https://example.com', title: 'Example',
  snapshot: '[e1] button Continue', viewport: { width: 800, height: 600 }, cursor: null,
}

function activeState(tab = observation, observed: BrowserCapture['observation'] | null = tab): BrowserSessionState {
  return { browserGeneration: 'browser-1', stateRevision: 1, viewport: tab.viewport,
    tabs: [{ id: tab.tabId, generation: tab.generation, url: tab.url, title: tab.title, canGoBack: false, canGoForward: false }],
    activeTabId: tab.tabId, observation: observed, hasFrame: false }
}

class FakeBrowser extends BrowserUseService {
  currentState: BrowserSessionState | undefined
  readonly commands = vi.fn(async (
    _id: ReturnType<typeof SessionId>, command: BrowserCommand, signal: AbortSignal,
  ): Promise<BrowserCapture> => {
    signal.throwIfAborted()
    const active = this.currentState?.tabs.find(tab => tab.id === this.currentState?.activeTabId)
    const captured = { ...observation, tabId: active?.id ?? observation.tabId,
      generation: active?.generation ?? observation.generation,
      url: command.kind === 'navigate' ? command.url : active?.url ?? observation.url }
    this.currentState = { ...activeState(captured), stateRevision: (this.currentState?.stateRevision ?? 0) + 1 }
    return { observation: captured, png: command.kind === 'screenshot' ? PNG : null }
  })
  execute(id: ReturnType<typeof SessionId>, command: BrowserCommand, signal: AbortSignal,
    expectedTarget?: BrowserExpectedTarget): Promise<BrowserCapture> {
    const active = this.currentState?.tabs.find(tab => tab.id === this.currentState?.activeTabId)
    if (expectedTarget && (expectedTarget.kind === 'none' ? this.currentState !== undefined :
      !active || expectedTarget.browserGeneration !== this.currentState?.browserGeneration ||
      expectedTarget.stateRevision !== this.currentState?.stateRevision ||
      expectedTarget.tabId !== active.id || expectedTarget.generation !== active.generation ||
      expectedTarget.url !== undefined && expectedTarget.url !== active.url)) {
      return Promise.reject(new Error('browser target changed while awaiting approval'))
    }
    return this.commands(id, command, signal)
  }
  readonly state = vi.fn((_id: ReturnType<typeof SessionId>): BrowserSessionState | undefined => this.currentState)
  control(_id: ReturnType<typeof SessionId>, command: BrowserHumanCommand, signal: AbortSignal): Promise<BrowserSessionState | undefined> {
    signal.throwIfAborted()
    if (command.kind === 'select-tab') {
      const tabId = command.tabId
      this.currentState = { ...activeState({ ...observation, tabId,
        url: tabId === observation.tabId ? observation.url : 'https://other.example/' }),
      stateRevision: (this.currentState?.stateRevision ?? 0) + 1 }
    } else if (command.kind === 'navigate') {
      this.currentState = { ...activeState({ ...observation, url: command.url }),
        stateRevision: (this.currentState?.stateRevision ?? 0) + 1 }
    } else if (command.kind === 'reload' && this.currentState) {
      this.currentState = { ...this.currentState, stateRevision: this.currentState.stateRevision + 1 }
    } else if (command.kind === 'set-viewport' && this.currentState &&
      (this.currentState.viewport.width !== command.width || this.currentState.viewport.height !== command.height)) {
      this.currentState = { ...this.currentState, viewport: { width: command.width, height: command.height },
        stateRevision: this.currentState.stateRevision + 1 }
    }
    return Promise.resolve(this.currentState)
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
    expect(browser.state).toHaveBeenCalled()
    expect(browser.commands).not.toHaveBeenCalled()

    await call({ action: 'navigate', url: 'not a URL' })
    expect(asked.mock.calls.at(-1)?.[0].reason).toContain('target origin: invalid target')
    await call({ action: 'navigate', url: `https://${Array(5).fill('a'.repeat(60)).join('.')}.com` })
    expect(asked.mock.calls.at(-1)?.[0].reason).toContain('target origin: invalid target')
  })

  it('shows only the session’s current bounded origin and safe ref for non-navigation approvals', async () => {
    const { ctx, call, agent } = await setup()
    const browser = ctx.browserUse as FakeBrowser
    browser.currentState = activeState({ ...observation, url: 'https://user:password@EXAMPLE.com/private?token=secret#fragment' }, null)
    const asked = vi.fn((_req: { reason?: string }, _next: () => Promise<'rejected'>) => Promise.resolve('rejected' as const))
    ctx.on('approval/request', asked)
    for (const args of [
      { action: 'click', ref: 'e1', revision: 1 },
      { action: 'fill', ref: 'e1', revision: 1, text: 'sensitive fill text' },
      { action: 'snapshot' }, { action: 'scroll', direction: 'down', pixels: 10 },
      { action: 'screenshot' }, { action: 'close' },
    ]) await call(args)
    expect(browser.state).toHaveBeenCalledTimes(6)
    expect(browser.state.mock.calls.every(([id]) => id === agent.session.id)).toBe(true)
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
    browser.currentState = activeState({ ...observation, url: 'data:text/html,secret' }, null)
    await call({ action: 'screenshot' })
    expect(asked.mock.calls.at(-1)?.[0].reason).toContain('current origin: unknown')
    browser.currentState = activeState({ ...observation, url: 'about:blank' }, null)
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
    const browser = ctx.browserUse as FakeBrowser
    browser.currentState = activeState()
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
    expect((ctx.browserUse as FakeBrowser).state).toHaveBeenCalled()
  })

  it('binds standard and PTC results to the active tab observed before approval', async () => {
    const { ctx, call } = await setup()
    const browser = ctx.browserUse as FakeBrowser
    browser.currentState = activeState()
    const execute = vi.spyOn(browser, 'execute')
    ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))
    const result = await call({ action: 'snapshot' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ observation: { tabId: observation.tabId } })
    expect(text(result)).toContain('"tabId":"tab-1"')
    expect(browser.commands).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(expect.anything(), { kind: 'snapshot' }, expect.anything(),
      { kind: 'tab', browserGeneration: 'browser-1', stateRevision: 1,
        tabId: observation.tabId, generation: 'g1', url: 'https://example.com' })
  })

  it('rejects a tab switch during approval without executing a command', async () => {
    const { ctx, call, agent } = await setup()
    const browser = ctx.browserUse as FakeBrowser
    browser.currentState = activeState()
    let decide: ((outcome: 'allowed-once') => void) | undefined
    ctx.on('approval/request', () => new Promise<'allowed-once'>((resolve) => { decide = resolve }))
    const pending = call({ action: 'fill', ref: 'e1', revision: 1, text: 'secret' })
    await vi.waitFor(() => { expect(decide).toBeDefined() })
    await browser.control(agent.session.id, { kind: 'select-tab', tabId: 'tab-2' as BrowserTabId }, new AbortController().signal)
    decide?.('allowed-once')
    const result = await pending
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('browser target changed')
    expect(browser.commands).not.toHaveBeenCalled()
    expect(browser.currentState?.activeTabId).toBe('tab-2')
  })

  it('does not take over a newly created tab after approving first navigation', async () => {
    const { ctx, call } = await setup()
    const browser = ctx.browserUse as FakeBrowser
    ctx.on('approval/request', () => {
      browser.currentState = activeState()
      return Promise.resolve('allowed-once' as const)
    })
    const result = await call({ action: 'navigate', url: 'https://example.com' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('browser target changed')
    expect(browser.commands).not.toHaveBeenCalled()
  })

  it('rejects a navigation on the same tab while approval is pending', async () => {
    const { ctx, call, agent } = await setup()
    const browser = ctx.browserUse as FakeBrowser
    browser.currentState = activeState()
    ctx.on('approval/request', () => {
      void browser.control(agent.session.id, { kind: 'navigate', url: 'https://changed.example/?token=hidden' },
        new AbortController().signal)
      return Promise.resolve('allowed-once' as const)
    })
    const result = await call({ action: 'click', ref: 'e1', revision: 1 })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('browser target changed')
    expect(browser.commands).not.toHaveBeenCalled()
  })

  it('rejects a same-URL reload while approval is pending', async () => {
    const { ctx, call, agent } = await setup()
    const browser = ctx.browserUse as FakeBrowser
    browser.currentState = activeState()
    ctx.on('approval/request', () => {
      void browser.control(agent.session.id, { kind: 'reload' }, new AbortController().signal)
      return Promise.resolve('allowed-once' as const)
    })
    const result = await call({ action: 'screenshot' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('browser target changed')
    expect(browser.currentState?.activeTabId).toBe(observation.tabId)
    expect(browser.currentState?.tabs[0]?.url).toBe(observation.url)
    expect(browser.commands).not.toHaveBeenCalled()
  })

  it('rejects an approved action after a human viewport change', async () => {
    const { ctx, call, agent } = await setup()
    const browser = ctx.browserUse as FakeBrowser
    browser.currentState = activeState()
    ctx.on('approval/request', async () => {
      await browser.control(agent.session.id, { kind: 'set-viewport', width: 1200, height: 700 },
        new AbortController().signal)
      return 'allowed-once' as const
    })
    const result = await call({ action: 'click', ref: 'e1', revision: 1 })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('browser target changed')
    expect(browser.currentState?.viewport).toEqual({ width: 1200, height: 700 })
    expect(browser.commands).not.toHaveBeenCalled()
  })

  it('rejects a tab switch away and back during approval', async () => {
    const { ctx, call, agent } = await setup()
    const browser = ctx.browserUse as FakeBrowser
    browser.currentState = activeState()
    ctx.on('approval/request', async () => {
      const signal = new AbortController().signal
      await browser.control(agent.session.id, { kind: 'select-tab', tabId: 'tab-2' as BrowserTabId }, signal)
      await browser.control(agent.session.id, { kind: 'select-tab', tabId: observation.tabId }, signal)
      return 'allowed-once' as const
    })
    const result = await call({ action: 'navigate', url: 'https://example.com/next' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('browser target changed')
    expect(browser.currentState?.activeTabId).toBe(observation.tabId)
    expect(browser.currentState?.tabs[0]?.url).toBe(observation.url)
    expect(browser.commands).not.toHaveBeenCalled()
  })

  it('binds an unobserved human-created tab by its tab generation', async () => {
    const { ctx, call } = await setup()
    const browser = ctx.browserUse as FakeBrowser
    browser.currentState = activeState({ ...observation, tabId: 'blank-tab' as BrowserTabId, url: 'about:blank' }, null)
    const execute = vi.spyOn(browser, 'execute')
    ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))
    const result = await call({ action: 'navigate', url: 'https://example.com' })
    expect(result.isError).toBe(false)
    expect(execute).toHaveBeenCalledWith(expect.anything(), { kind: 'navigate', url: 'https://example.com' },
      expect.anything(), { kind: 'tab', browserGeneration: 'browser-1', stateRevision: 1,
        tabId: 'blank-tab', generation: 'g1', url: 'about:blank' })
  })

  it('caps the complete text observation and fails without an image reference if storage fails', async () => {
    const { ctx, call } = await setup()
    const browser = ctx.browserUse as FakeBrowser
    browser.currentState = activeState()
    ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))
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
