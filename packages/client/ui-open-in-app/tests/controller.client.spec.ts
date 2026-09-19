/** Controller 的目标缓存、本地启动和工作台 wire 校验。 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { OpenInAppController } from '../src/client/controller.ts'
import type { OpenInAppRoutes } from '../src/client/wire.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const SESSION = 'session-1' as SessionId
const ROUTES: OpenInAppRoutes = {
  files: '/open-in-app/files',
  readFile: '/open-in-app/files/read',
  terminal: '/open-in-app/terminal',
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

describe('OpenInAppController targets', () => {
  it('starts without a platform-specific choice', () => {
    const controller = new OpenInAppController(async () => jsonResponse({ kind: 'files', apps: [] }), ROUTES)
    expect(controller.choice.getSnapshot()).toBe('')
    expect(controller.targets.getSnapshot()).toEqual({})
  })

  it('coalesces one path, caches settled targets, and loads another path independently', async () => {
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const rawBody = init?.body
      if (typeof rawBody !== 'string') throw new Error('missing request body')
      const path = JSON.parse(rawBody) as { path: string }
      return path.path === '/remote'
        ? jsonResponse({ kind: 'files', apps: [] })
        : jsonResponse({ kind: 'local', apps: ['finder'] })
    })
    const controller = new OpenInAppController(fetcher, ROUTES)
    await Promise.all([controller.load('/local'), controller.load('/local')])
    await controller.load('/local')
    await controller.load('/remote')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(controller.targets.getSnapshot()).toEqual({
      '/local': { kind: 'local', apps: ['finder'] },
      '/remote': { kind: 'files', apps: [] },
    })
  })

  it('publishes unavailable for HTTP, transport, and malformed target failures', async () => {
    const cases = [
      async () => jsonResponse({}, 500),
      async () => { throw new Error('down') },
      async () => jsonResponse([]),
      async () => jsonResponse({ kind: 'local', apps: ['finder', 7] }),
      async () => jsonResponse({ kind: 'files', apps: ['unexpected'] }),
    ]
    for (const [index, fetcher] of cases.entries()) {
      const path = `/w/${String(index)}`
      const controller = new OpenInAppController(fetcher, ROUTES)
      await controller.load(path)
      expect(controller.targets.getSnapshot()[path]).toEqual({ kind: 'unavailable' })
    }
  })

  it('uses the page origin, the default fetcher, and the internal Host under a null origin', async () => {
    vi.stubGlobal('location', { origin: 'http://dsh.example:8080' })
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => jsonResponse({ kind: 'files', apps: [] }))
    vi.stubGlobal('fetch', fetcher)
    await new OpenInAppController(undefined, ROUTES).load('/w')
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://dsh.example:8080/open-in-app/target')

    vi.stubGlobal('location', { origin: 'null' })
    const fallbackFetch = vi.fn(async (_input: string | URL, _init?: RequestInit) => jsonResponse({ kind: 'files', apps: [] }))
    await new OpenInAppController(fallbackFetch, ROUTES).load('/w')
    expect(String(fallbackFetch.mock.calls[0]?.[0])).toBe('http://dsh.internal/open-in-app/target')
  })
})

describe('OpenInAppController local actions', () => {
  it('persists and restores the chosen application', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
    const controller = new OpenInAppController(async () => jsonResponse({}), ROUTES)
    controller.choose('cursor')
    expect(controller.choice.getSnapshot()).toBe('cursor')
    expect(values.get('dsh.open-in-app.choice')).toBe('"cursor"')
    expect(new OpenInAppController(async () => jsonResponse({}), ROUTES).choice.getSnapshot()).toBe('cursor')
  })

  it.each(['launched', 'files'] as const)('posts launch data and returns the %s action', async (action) => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => jsonResponse({ ok: true, action }))
    const controller = new OpenInAppController(fetcher, ROUTES)
    await expect(controller.launch('cursor', '/w/dir')).resolves.toBe(action)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'cursor', path: '/w/dir' }),
    })
  })

  it('rejects failed, primitive, and malformed launch responses', async () => {
    await expect(new OpenInAppController(async () => jsonResponse({}, 404), ROUTES)
      .launch('cursor', '/w')).rejects.toThrow('open failed: HTTP 404')
    await expect(new OpenInAppController(async () => jsonResponse('bad'), ROUTES)
      .launch('cursor', '/w')).rejects.toThrow('invalid response')
    await expect(new OpenInAppController(async () => jsonResponse({ ok: true, action: 'other' }), ROUTES)
      .launch('cursor', '/w')).rejects.toThrow('invalid launch result')
  })
})

describe('OpenInAppController workspace files', () => {
  it('posts only sessionId plus provider segments and validates entries', async () => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => jsonResponse({
      displayPath: 'C:\\work\\src',
      entries: [
        { name: 'nested', type: 'directory' },
        { name: 'main.ts', type: 'file', size: 42 },
        { name: 'socket', type: 'other' },
      ],
      truncated: false,
    }))
    const controller = new OpenInAppController(fetcher, ROUTES)
    const abort = new AbortController()
    await expect(controller.listFiles(SESSION, ['src'], abort.signal)).resolves.toEqual({
      path: 'C:\\work\\src',
      entries: [
        { name: 'nested', type: 'directory', segments: ['src', 'nested'] },
        { name: 'main.ts', type: 'file', size: 42, segments: ['src', 'main.ts'] },
        { name: 'socket', type: 'other', segments: ['src', 'socket'] },
      ],
      truncated: false,
    })
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION, segments: ['src'] }),
      signal: abort.signal,
    })
  })

  it('rejects failed and malformed directory responses', async () => {
    await expect(new OpenInAppController(async () => jsonResponse({}, 502), ROUTES)
      .listFiles(SESSION, [])).rejects.toThrow('workspace files failed: HTTP 502')
    for (const payload of [
      { displayPath: 7, entries: [], truncated: false },
      { displayPath: '/w', entries: [], truncated: 'no' },
      { displayPath: '/w', entries: null, truncated: false },
    ]) {
      await expect(new OpenInAppController(async () => jsonResponse(payload), ROUTES)
        .listFiles(SESSION, [])).rejects.toThrow('invalid directory listing')
    }
    for (const entry of [
      null,
      [],
      { name: 7, type: 'file' },
      { name: 'x', type: 'socket' },
      { name: 'x', type: 'file', size: '7' },
      { name: 'x', type: 'file', size: 1.5 },
      { name: 'x', type: 'file', size: -1 },
    ]) {
      await expect(new OpenInAppController(async () => jsonResponse({
        displayPath: '/w', entries: [entry], truncated: false,
      }), ROUTES).listFiles(SESSION, [])).rejects.toThrow('invalid directory entry')
    }
  })

  it('validates every file content variant and posts provider segments', async () => {
    const cases = [
      [{ kind: 'text', format: 'markdown', text: '# title' }, { kind: 'markdown', text: '# title' }],
      [{ kind: 'text', format: 'text', text: 'a\nb' }, { kind: 'text', text: 'a\nb' }],
      [{ kind: 'text', format: 'code', text: 'const a = 1' }, { kind: 'code', text: 'const a = 1' }],
      [{ kind: 'image', mime: 'image/png', dataBase64: 'AAAA' }, { kind: 'image', mimeType: 'image/png', data: 'AAAA' }],
      [{ kind: 'unsupported', reason: 'binary' }, { kind: 'unsupported' }],
      [{ kind: 'unsupported', reason: 'too-large' }, { kind: 'unsupported' }],
    ] as const
    for (const [host, content] of cases) {
      const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => jsonResponse({
        displayPath: '/w/file', name: 'file', truncated: false, ...host,
      }))
      const controller = new OpenInAppController(fetcher, ROUTES)
      const abort = new AbortController()
      await expect(controller.readFile(SESSION, ['file'], abort.signal)).resolves.toEqual({ path: '/w/file', content })
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
        body: JSON.stringify({ sessionId: SESSION, segments: ['file'] }),
        signal: abort.signal,
      })
    }
  })

  it('rejects failed and malformed file responses', async () => {
    await expect(new OpenInAppController(async () => jsonResponse({}, 500), ROUTES)
      .readFile(SESSION, [])).rejects.toThrow('workspace file failed: HTTP 500')
    const invalid = [
      { displayPath: 1, name: 'x', truncated: false, kind: 'text', format: 'text', text: 'x' },
      { displayPath: '/w', name: 1, truncated: false, kind: 'text', format: 'text', text: 'x' },
      { displayPath: '/w', name: 'x', truncated: 'no', kind: 'text', format: 'text', text: 'x' },
      { displayPath: '/w', name: 'x', truncated: false, kind: 'text', format: 'unknown', text: 'x' },
      { displayPath: '/w', name: 'x', truncated: false, kind: 'text', format: 'code', text: 1 },
      { displayPath: '/w', name: 'x', truncated: false, kind: 'image', mime: 'text/html', dataBase64: 'x' },
      { displayPath: '/w', name: 'x', truncated: false, kind: 'image', mime: 'image/png', dataBase64: 1 },
      { displayPath: '/w', name: 'x', truncated: false, kind: 'unsupported', reason: 'other' },
      { displayPath: '/w', name: 'x', truncated: false, kind: 'unknown' },
    ]
    for (const payload of invalid) {
      await expect(new OpenInAppController(async () => jsonResponse(payload), ROUTES)
        .readFile(SESSION, [])).rejects.toThrow(/invalid (file|code)/)
    }
  })
})

describe('OpenInAppController terminal URL and shared routes', () => {
  it('maps HTTP and HTTPS origins to ws and wss URLs with the Session id', () => {
    vi.stubGlobal('location', { origin: 'https://dsh.example:9443' })
    expect(new OpenInAppController(async () => jsonResponse({}), ROUTES).terminalUrl(SESSION))
      .toBe('wss://dsh.example:9443/open-in-app/terminal?sessionId=session-1&cols=80&rows=24')
    vi.stubGlobal('location', { origin: 'null' })
    expect(new OpenInAppController(async () => jsonResponse({}), ROUTES).terminalUrl(SESSION))
      .toBe('ws://dsh.internal/open-in-app/terminal?sessionId=session-1&cols=80&rows=24')
  })

  it('fails loudly when Host shared omits a required route', async () => {
    const missing: OpenInAppRoutes = { files: '', readFile: '', terminal: '' }
    const controller = new OpenInAppController(async () => jsonResponse({}), missing)
    await expect(controller.listFiles(SESSION, [])).rejects.toThrow('files route')
    await expect(controller.readFile(SESSION, [])).rejects.toThrow('file read route')
    expect(() => controller.terminalUrl(SESSION)).toThrow('terminal route')
  })
})
