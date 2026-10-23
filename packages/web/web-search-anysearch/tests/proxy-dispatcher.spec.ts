/** 代理出站的成功与失败路径：独立 dispatcher 必须在搜索结束后释放。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANYSEARCH_DEFAULT_BASE_URL, AnySearchProvider } from '../src/provider.ts'

const undici = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  fetch: vi.fn(),
}))

vi.mock('undici', () => ({
  ProxyAgent: class {
    close = undici.close
    destroy = undici.destroy
  },
  fetch: undici.fetch,
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function proxiedProvider(): AnySearchProvider {
  return new AnySearchProvider(() => ({
    baseURL: ANYSEARCH_DEFAULT_BASE_URL,
    resolveProxyURL: () => 'http://proxy.example.test:8080',
  }))
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('AnySearch proxied transport', () => {
  it('closes the dispatcher after a successful proxied search', async () => {
    undici.fetch.mockResolvedValue(jsonResponse({ code: 0, data: { results: [{ url: 'https://example.com/proxied' }] } }))
    await expect(proxiedProvider().search({ query: 'q' })).resolves.toMatchObject({
      sources: [{ url: 'https://example.com/proxied' }],
    })
    expect(undici.fetch).toHaveBeenCalledTimes(1)
    expect(undici.close).toHaveBeenCalledTimes(1)
    expect(undici.destroy).not.toHaveBeenCalled()
  })

  it('destroys the dispatcher when the proxied response fails', async () => {
    undici.fetch.mockResolvedValue(jsonResponse({}, 500))
    await expect(proxiedProvider().search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(undici.close).not.toHaveBeenCalled()
    expect(undici.destroy).toHaveBeenCalledTimes(1)
  })
})
