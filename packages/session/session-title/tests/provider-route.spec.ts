import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from 'coding-llm'
import SessionStore, { SessionId } from 'coding-session'
import SessionTitleService, {
  SessionTitleProviderId,
  type SessionTitleProviderRequest,
} from 'coding-session-title'

const CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 24,
  maxTitleBytes: 24,
} as const

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function appendHumanPrompt(session: ReturnType<Context['sessions']['create']>, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('SessionTitleService provider routing and switch', () => {
  it('titles a session from the provider own route before the conversation logs a request route', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const generate = vi.fn(async (request: SessionTitleProviderRequest) => ({
      title: 'Own route title',
      messageSeqs: [request.messages[0]!.seq],
      ...request.route === undefined ? {} : { model: request.route },
    }))
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('own-route'),
      automatic: 'first-prompt',
      ownRoute: () => ({ provider: 'title-route', model: 'title-model' }),
      generate,
    })
    const session = ctx.sessions.create(SessionId('own-route-title'))
    session.append('turn/start', { turn: 1 })
    appendHumanPrompt(session, 'Name this session')
    await settle()

    expect(generate).toHaveBeenCalledOnce()
    expect(generate.mock.calls[0]![0].route).toEqual({ provider: 'title-route', model: 'title-model' })
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'Own route title',
      source: { kind: 'provider', provider: SessionTitleProviderId('own-route') },
    })
  })

  it('schedules no revision while the provider reports title generation as off', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const generate = vi.fn(async (request: SessionTitleProviderRequest) => ({
      title: 'Should not run',
      messageSeqs: [request.messages[0]!.seq],
    }))
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('switched-off'),
      automatic: 'first-prompt',
      enabled: () => false,
      generate,
    })
    const session = ctx.sessions.create(SessionId('off-title'))
    session.append('turn/start', { turn: 1 })
    appendHumanPrompt(session, 'Name this session')
    await settle()

    expect(generate).not.toHaveBeenCalled()
    expect(ctx.sessionTitle.get(session)).toMatchObject({ source: { kind: 'fallback' } })
  })

  it('refreshes with the provider own route instead of the logged main route', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, CONFIG)
    const requests: SessionTitleProviderRequest[] = []
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('refresh-route'),
      automatic: 'first-prompt',
      ownRoute: () => ({ provider: 'title-route', model: 'title-model' }),
      generate: async (request) => {
        requests.push(request)
        return {
          title: 'Refreshed title',
          messageSeqs: [request.messages[0]!.seq],
          ...request.route === undefined ? {} : { model: request.route },
        }
      },
    })
    const session = ctx.sessions.create(SessionId('refresh-title'))
    session.append('turn/start', { turn: 1 })
    appendHumanPrompt(session, 'Name this session')
    session.append('request/header', {
      header: { config: { provider: 'main-route', model: 'chat-model' } },
      reason: 'initial',
    })
    await settle()

    await ctx.sessionTitle.refresh(session)

    expect(requests.at(-1)?.route).toEqual({ provider: 'title-route', model: 'title-model' })
    expect(ctx.sessionTitle.get(session)).toMatchObject({ title: 'Refreshed title' })
  })
})
