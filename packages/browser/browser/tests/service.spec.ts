import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import BrowserUseService, { BrowserUseError, type BrowserCapture, type BrowserCommand } from '../src/index.ts'
import type { BrowserObservation } from '../src/types.ts'

class StubBrowserUse extends BrowserUseService {
  private readonly captures = new Map<ReturnType<typeof SessionId>, BrowserCapture>()

  async execute(sessionId: ReturnType<typeof SessionId>, command: BrowserCommand, signal: AbortSignal): Promise<BrowserCapture> {
    signal.throwIfAborted()
    if (command.kind === 'close') {
      await this.closeSession(sessionId)
    }
    const observation: BrowserObservation = {
      generation: sessionId,
      revision: 0,
      url: command.kind === 'navigate' ? command.url : 'about:blank',
      title: '',
      snapshot: '',
      viewport: { width: 800, height: 600 },
      cursor: null,
    }
    const capture: BrowserCapture = { observation, png: null }
    if (command.kind !== 'close') this.captures.set(sessionId, capture)
    return capture
  }

  latest(sessionId: ReturnType<typeof SessionId>): BrowserCapture | undefined {
    return this.captures.get(sessionId)
  }

  closeSession(sessionId: ReturnType<typeof SessionId>): Promise<void> {
    this.captures.delete(sessionId)
    return Promise.resolve()
  }
}

describe('BrowserUseService contract', () => {
  it('registers a subclass at ctx.browserUse and scopes captures by SessionId', async () => {
    const ctx = new Context()
    await ctx.plugin(StubBrowserUse)
    const first = SessionId('first')
    const second = SessionId('second')
    const signal = new AbortController().signal

    expect(ctx.browserUse.latest(first)).toBeUndefined()
    const capture = await ctx.browserUse.execute(first, { kind: 'navigate', url: 'https://example.com' }, signal)
    expect(ctx.browserUse.latest(first)).toBe(capture)
    expect(ctx.browserUse.latest(second)).toBeUndefined()
    await ctx.browserUse.closeSession(first)
    expect(ctx.browserUse.latest(first)).toBeUndefined()
  })

  it('keeps caller cancellation and classifies browser failures', async () => {
    const ctx = new Context()
    await ctx.plugin(StubBrowserUse)
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    await expect(ctx.browserUse.execute(SessionId('first'), { kind: 'snapshot' }, controller.signal)).rejects.toBe(reason)
    const failure = new BrowserUseError('reference belongs to an older snapshot', 'BROWSER_STALE_REF', { cause: reason })
    expect(failure).toMatchObject({ name: 'BrowserUseError', code: 'BROWSER_STALE_REF', cause: reason })
    expect(new BrowserUseError('session closed', 'BROWSER_CLOSED')).toMatchObject({ code: 'BROWSER_CLOSED' })
  })
})
