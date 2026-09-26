import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { BrowserUseError } from '@deepseek-ai/dsh-browser'
import type { BrowserHumanCommand, BrowserSessionState } from '@deepseek-ai/dsh-browser'
import { REMOTE_WORKSPACE_MARKER } from '@deepseek-ai/dsh-subprocess'
import { browserControlRequestSchema, browserControlValueSchema } from '../src/api/browser.schema.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const tabId = 'd2857d22-1a15-480a-aac4-43bcb9d60df4'
const state: BrowserSessionState = {
  browserGeneration: 'generation-1', stateRevision: 2,
  viewport: { width: 1280, height: 720 },
  tabs: [{ id: tabId as never, generation: 'tab-generation-1', url: 'https://example.com/', title: 'Example', canGoBack: false, canGoForward: false }],
  activeTabId: tabId as never,
  observation: {
    tabId: tabId as never, generation: 'generation-1', revision: 2, url: 'https://example.com/',
    title: 'Example', snapshot: 'Example', viewport: { width: 1280, height: 720 }, cursor: null,
  },
  hasFrame: true,
}
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function harness(cwd?: string, withBrowser = true) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  const id = SessionId('browser-session')
  const session = ctx.sessions.prepare(id, cwd === undefined ? undefined : { meta: { cwd } })
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  const control = vi.fn<(
    sessionId: typeof id, command: BrowserHumanCommand, signal: AbortSignal,
  ) => Promise<BrowserSessionState | undefined>>()
    .mockResolvedValue(state)
  if (withBrowser) ctx.provide('browserUse', { control } as never)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  const request = (sessionId = id, command: BrowserHumanCommand = { kind: 'reload' }) => ({
    rpcId: RpcId('browser-call'), payload: { sessionId, command },
  })
  return { ctx, id, api, control, request, detach }
}

describe('browser.control wire schemas', () => {
  it('accepts every human command and rejects extra or malformed fields', () => {
    for (const command of [
      { kind: 'ensure-tab' }, { kind: 'new-tab' }, { kind: 'select-tab', tabId }, { kind: 'close-tab', tabId },
      { kind: 'navigate', url: 'https://example.com/' }, { kind: 'back' }, { kind: 'forward' }, { kind: 'reload' },
      { kind: 'set-viewport', width: 1280, height: 720 },
    ]) expect(browserControlRequestSchema.safeParse({ sessionId: 's', command }).success).toBe(true)
    for (const payload of [
      { sessionId: 's', command: { kind: 'reload' }, agentId: 'forged' },
      { sessionId: 's', command: { kind: 'reload', url: 'https://example.com' } },
      { sessionId: 's', command: { kind: 'select-tab', tabId: 'not-a-uuid' } },
      { sessionId: '', command: { kind: 'back' } },
      { sessionId: 's', command: { kind: 'click', ref: '1' } },
      { sessionId: 's', command: { kind: 'navigate' } },
      { sessionId: 's', command: { kind: 'set-viewport', width: 1280, height: 720, fake: true } },
    ]) expect(browserControlRequestSchema.safeParse(payload).success).toBe(false)
  })

  it('refuses unsafe, credential-bearing and oversized URLs', () => {
    for (const url of [
      'javascript:alert(1)', 'file:///etc/passwd', 'http://user@example.com/',
      'https://user:pass@example.com/', '//example.com/', 'not a url', ' https://example.com/',
      'https://example.com/\n', 'https://example.com/' + 'a'.repeat(2048),
    ]) expect(browserControlRequestSchema.safeParse({ sessionId: 's', command: { kind: 'navigate', url } }).success).toBe(false)
    expect(browserControlRequestSchema.safeParse({ sessionId: 's', command: { kind: 'navigate', url: 'http://example.com/' } }).success).toBe(true)
  })

  it('bounds viewport dimensions and pixel area without coercion', () => {
    for (const [width, height] of [
      [199, 720], [1921, 720], [1280, 239], [1280, 1401],
      [1920, 1400], [1920, 1080], [1280.5, 720], [1280, '720'],
    ]) {
      expect(browserControlRequestSchema.safeParse({ sessionId: 's', command: { kind: 'set-viewport', width, height } }).success).toBe(false)
    }
    for (const [width, height] of [[200, 240], [1920, 900], [1280, 1400]]) {
      expect(browserControlRequestSchema.safeParse({ sessionId: 's', command: { kind: 'set-viewport', width, height } }).success).toBe(true)
    }
  })

  it('requires a fully typed state or null in successful responses', () => {
    expect(browserControlValueSchema.parse(state)).toEqual(state)
    expect(browserControlValueSchema.parse(null)).toBeNull()
    expect(browserControlValueSchema.safeParse({ ...state, tabs: [{ ...state.tabs[0], id: 'not-uuid' }] }).success).toBe(false)
    expect(browserControlValueSchema.safeParse({ ...state, tabs: [{ id: tabId, url: 'https://example.com/', title: 'Example', canGoBack: false, canGoForward: false }] }).success).toBe(false)
    expect(browserControlValueSchema.safeParse({ ...state, extra: true }).success).toBe(false)
    expect(browserControlValueSchema.safeParse({ ...state, viewport: { width: 1280.5, height: 720 } }).success).toBe(false)
    expect(browserControlValueSchema.safeParse({
      ...state, observation: { ...state.observation, viewport: { width: 1280, height: 720.5 } },
    }).success).toBe(false)
    expect(browserControlValueSchema.safeParse({ ...state, viewport: { width: 1920, height: 1400 } }).success).toBe(false)
    expect(browserControlValueSchema.safeParse({ ...state, viewport: { width: 1280, height: 720, fake: true } }).success).toBe(false)
  })
})

describe('browser.control gateway', () => {
  it('reports an unavailable provider and pre-aborted calls without trying to execute', async () => {
    const absent = await harness(undefined, false)
    expect((await absent.api.browser.control(absent.request(), new AbortController().signal)).result)
      .toMatchObject({ ok: false, error: { code: 'browser-failed', details: { reason: 'BROWSER_UNAVAILABLE' } } })
    const local = await harness()
    const controller = new AbortController()
    controller.abort()
    expect((await local.api.browser.control(local.request(), controller.signal)).result)
      .toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(local.control).not.toHaveBeenCalled()
  })

  it('uses only a live attached local session and passes the cancellation signal through', async () => {
    const { api, id, request, control } = await harness()
    const signal = new AbortController().signal
    const result = await api.browser.control(request(id, { kind: 'navigate', url: 'https://example.com/' }), signal)
    expect(result).toEqual({ rpcId: RpcId('browser-call'), result: { ok: true, value: state } })
    expect(control).toHaveBeenCalledWith(id, { kind: 'navigate', url: 'https://example.com/' }, signal)
    control.mockResolvedValueOnce(undefined)
    expect((await api.browser.control(request(id, { kind: 'close-tab', tabId: tabId as never }), signal)).result)
      .toEqual({ ok: true, value: null })
  })

  it('refuses unknown or unattached sessions without calling the browser', async () => {
    const { api, request, control, detach } = await harness()
    expect((await api.browser.control(request(SessionId('fabricated')), new AbortController().signal)).result)
      .toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    detach()
    expect((await api.browser.control(request(), new AbortController().signal)).result)
      .toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    expect(control).not.toHaveBeenCalled()
  })

  it('rejects Remote-SSH marker workspaces before calling the local provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-browser-remote-'))
    roots.push(root)
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode: 'agent',
    }))
    const { api, request, control } = await harness(root)
    expect((await api.browser.control(request(), new AbortController().signal)).result)
      .toMatchObject({ ok: false, error: { code: 'browser-failed', details: { reason: 'BROWSER_DENIED' } } })
    expect(control).not.toHaveBeenCalled()
  })

  it('maps provider errors and caller cancellation without exposing navigation URLs', async () => {
    const { api, request, control } = await harness()
    const sensitive = 'https://example.com/private-path'
    control.mockRejectedValueOnce(new BrowserUseError(`navigation denied at ${sensitive}`, 'BROWSER_DENIED'))
    const refused = await api.browser.control(request(undefined, { kind: 'navigate', url: sensitive }), new AbortController().signal)
    expect(refused.result)
      .toMatchObject({ ok: false, error: { code: 'browser-failed', details: { reason: 'BROWSER_DENIED' } } })
    expect(JSON.stringify(refused)).not.toContain(sensitive)
    const controller = new AbortController()
    control.mockImplementationOnce(async (_id, _command, signal) => {
      controller.abort()
      throw signal.reason
    })
    expect((await api.browser.control(request(), controller.signal)).result)
      .toMatchObject({ ok: false, error: { code: 'cancelled' } })
    control.mockRejectedValueOnce(new Error(`failure: ${sensitive}`))
    const failure = await api.browser.control(request(), new AbortController().signal)
    expect(failure.result).toMatchObject({ ok: false, error: { code: 'browser-failed', details: { reason: 'BROWSER_FAILED' } } })
    expect(JSON.stringify(failure)).not.toContain(sensitive)
  })
})
