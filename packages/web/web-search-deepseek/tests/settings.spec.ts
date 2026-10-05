/** The `web-search-deepseek` settings section layered over the composition entry. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { ProxyAgent } from 'undici'
import type { Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as deepseekPlugin from '@deepseek-ai/dsh-web-search-deepseek'
import { WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web-search-deepseek'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** The smallest Anthropic-shaped answer the provider accepts — enough to observe the request. */
const ONE_RESULT = {
  content: [
    { type: 'text', text: 'ok' },
    {
      type: 'web_search_tool_result',
      content: [{ type: 'web_search_result', url: 'https://a.test', title: 'A' }],
    },
  ],
}

async function boot(): Promise<{ ctx: Context; settingsFiber: Fiber; pluginFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {})
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const pluginFiber = ctx.plugin(deepseekPlugin, { apiKey: 'ds-key', baseURL: 'https://search.entry.test/v1' })
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Run one search and answer the endpoint it reached. A fresh `Response` per
 * call because a body can only be read once, and the call history is cleared
 * because repeated `spyOn` returns the same spy.
 * @param ctx - context whose `ctx.web` serves the search.
 * @returns the URL the provider fetched.
 */
async function searchOnce(ctx: Context): Promise<string> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(ONE_RESULT)))
  fetchSpy.mockClear()
  await ctx.web.search({ query: 'anything' })
  return String((fetchSpy.mock.calls.at(-1)?.[0] as URL | string | undefined) ?? '')
}

describe('web-search-deepseek settings section', () => {
  it('serves a stored endpoint to the next search without re-registering the provider', async () => {
    const bench = await boot()
    expect(await searchOnce(bench.ctx)).toContain('https://search.entry.test/v1')

    await bench.ctx.settings.update(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, {
      baseURL: 'https://search.stored.test/v1',
    })

    expect(await searchOnce(bench.ctx)).toContain('https://search.stored.test/v1')
    await bench.ctx.fiber.dispose()
  })

  it('rejects unsafe saved endpoints before persistence', async () => {
    const bench = await boot()
    for (const baseURL of ['http://127.0.0.1/v1', 'https://[::1]/v1', 'https://user:password@search.test/v1', 'https://search.test/v1?token=x', 'https://localhost/v1', 'https://host.local./v1', 'https://host.internal../v1']) {
      await expect(bench.ctx.settings.update(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, { baseURL })).rejects.toThrow()
    }
    expect(bench.ctx.settings.describe().find(row => String(row.ns) === 'web-search-deepseek')?.user).toBeUndefined()
    await bench.ctx.fiber.dispose()
  })

  it('rejects credential-bearing and non-HTTP proxy addresses before persistence', async () => {
    const bench = await boot()
    for (const proxyURL of [
      'socks5://127.0.0.1:1080',
      'http://user:password@127.0.0.1:8080',
      'http://@127.0.0.1:8080',
      'http:/@127.0.0.1:8080',
      'http://127.0.0.1:8080/?token=x',
      'http://127.0.0.1:8080?',
      'https://127.0.0.1:8080/#fragment',
      'https://127.0.0.1:8080#',
      'not-a-url',
    ]) {
      await expect(bench.ctx.settings.update(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, { proxyURL })).rejects.toThrow()
    }
    expect(bench.ctx.settings.describe().find(row => String(row.ns) === 'web-search-deepseek')?.user).toBeUndefined()
    await bench.ctx.fiber.dispose()
  })

  it('uses each committed proxy only for the next search', async () => {
    const bench = await boot()
    const hits: Array<Array<{ target: string; headers: string[] }>> = [[], []]
    const proxies = hits.map(received => createServer().on('connect', (request, socket) => {
      received.push({ target: request.url ?? '', headers: request.rawHeaders })
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    }))
    try {
      const origins: string[] = []
      for (const proxy of proxies) {
        await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
        origins.push(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`)
      }
      for (let index = 0; index < origins.length; index++) {
        await bench.ctx.settings.update(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, {
          proxyURL: origins[index],
        })
        await expect(bench.ctx.web.search({ query: 'anything' }))
          .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
        expect(hits[index]).toHaveLength(1)
        expect(hits[index]?.[0]?.target).toBe('search.entry.test:443')
        expect(JSON.stringify(hits[index])).not.toContain('ds-key')
        expect(JSON.stringify(hits[index])).not.toContain('anything')
      }
      expect(hits[0]).toHaveLength(1)
    } finally {
      await bench.ctx.fiber.dispose()
      await Promise.all(proxies.map(proxy => new Promise<void>((resolve, reject) => {
        proxy.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })))
    }
  })

  it('aborts a stalled proxy CONNECT promptly and destroys its dispatcher', async () => {
    const bench = await boot()
    const sockets = new Set<Duplex>()
    const destroy = vi.spyOn(ProxyAgent.prototype, 'destroy')
    let connected = () => {}
    const reached = new Promise<void>((resolve) => { connected = resolve })
    const proxy = createServer().on('connect', (_request, socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      connected()
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
      await bench.ctx.settings.update(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, {
        proxyURL: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      })
      const controller = new AbortController()
      const search = bench.ctx.web.search({ query: 'anything' }, controller.signal)
      await reached
      controller.abort(new Error('cancelled'))
      const settled = Promise.race([
        search.then(() => undefined, (error: unknown) => error),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { reject(new Error('proxy cancellation did not settle promptly')) }, 1000)
        }),
      ])
      await expect(settled).resolves.toMatchObject({ code: 'WEB_ABORTED' })
      expect(destroy).toHaveBeenCalled()
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      await bench.ctx.fiber.dispose()
      if (proxy.listening) await new Promise<void>((resolve, reject) => proxy.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
  })

  it('keeps the literal key out of every described layer', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, { apiKey: 'ds-stored-secret' })

    const [descriptor] = bench.ctx.settings.describe({ redactSecrets: true })
      .filter(row => String(row.ns) === 'web-search-deepseek')

    expect(JSON.stringify(descriptor)).not.toContain('ds-stored-secret')
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, {
      baseURL: 'https://search.stored.test/v1',
    })
    expect(await searchOnce(bench.ctx)).toContain('https://search.stored.test/v1')

    await bench.settingsFiber.dispose()

    expect(await searchOnce(bench.ctx)).toContain('https://search.entry.test/v1')
    await bench.ctx.fiber.dispose()
  })

  it('releases the namespace when the plugin unloads', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('web-search-deepseek')

    await bench.pluginFiber.dispose()

    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('web-search-deepseek')
    await bench.ctx.fiber.dispose()
  })
})
