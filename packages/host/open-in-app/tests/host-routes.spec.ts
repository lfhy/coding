/** 通过真实 Loader 与 WebServer 组合覆盖认证路由、缓存、远端分流和 HMR 释放。 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { REMOTE_WORKSPACE_MARKER } from '@deepseek-ai/dsh-subprocess'
import {
  createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentLayerInput,
} from '@deepseek-ai/dsh-launch-environment'
import * as OpenInApp from '../src/index.ts'
import { internals } from '../src/internals.ts'
import type { OpenInAppLauncher } from '../src/resolver.ts'

let root: string | undefined
let context: Context | undefined

interface FakeSession {
  readonly header: { readonly id: string; readonly cwd?: string }
}

const sessions = new Map<string, FakeSession>()
const agents = new Map<string, object>()

const trust: { rejection: 401 | 403 | undefined } = { rejection: undefined }

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  internals.catalog = {}
  trust.rejection = undefined
  sessions.clear()
  agents.clear()
  vi.unstubAllEnvs()
})

function setSession(cwd: string | undefined, id = 'session'): FakeSession {
  const session: FakeSession = { header: { id, ...cwd === undefined ? {} : { cwd } } }
  sessions.set(id, session)
  return session
}

function pathTable(entries: Record<string, string> = {}): (name: string) => Promise<string | null> {
  return name => Promise.resolve(entries[name] ?? null)
}

function websocketStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0
      response.resume()
      resolve(status)
    })
    socket.once('open', () => {
      socket.terminate()
      reject(new Error('upgrade unexpectedly succeeded'))
    })
    socket.once('error', () => { /* unexpected-response owns the status result. */ })
  })
}

async function boot(layers: readonly LaunchEnvironmentLayerInput[] = [], filesystem?: object): Promise<string> {
  internals.catalog = { env: {}, ...internals.catalog }
  root = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    ...filesystem === undefined ? [
      "- name: '@deepseek-ai/dsh-fs-local'",
      '  config:',
      `    cwd: ${JSON.stringify(root)}`,
    ] : [],
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-host-open-in-app'",
    '  config:',
    '    probeTimeoutMs: 5000',
    '    iconTimeoutMs: 5000',
    '    launchWatchMs: 1000',
    '',
  ].join('\n'))

  context = new Context()
  setSession(root)
  if (filesystem !== undefined) context.provide('fs', filesystem as never)
  context.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot(layers))
  context.baseUrl = pathToFileURL(root).href + '/'
  context.provide('connection', { requestRejection: () => trust.rejection } as never)
  context.provide('sessions', { get: (id: string) => sessions.get(id) } as never)
  context.provide('agents', { get: (id: string) => agents.get(id) } as never)
  context.provide('subprocess', {
    resolveExecutable: () => Promise.reject(new Error('spec host resolves nothing')),
  } as never)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-fs-local', FsLocal],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-host-open-in-app', OpenInApp],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  return `http://127.0.0.1:${String(context.webServer.port)}`
}

function darwinFixture(home: string, launches: string[][]): void {
  const run: NativeCommandRunner = async (command, args) => {
    if (command === 'plutil') return { stdout: JSON.stringify({ CFBundleIconFile: 'AppIcon' }), stderr: '' }
    if (command === 'sips') {
      const out = args[args.length - 1]
      if (typeof out !== 'string') throw new Error('missing sips --out')
      await writeFile(out, 'png-bytes')
      return { stdout: '', stderr: '' }
    }
    throw new Error(`fixture rejects: ${command} ${args.join(' ')}`)
  }
  const launch: OpenInAppLauncher = (command, args) => {
    launches.push([command, ...args])
    return Promise.resolve()
  }
  internals.catalog = {
    platform: 'darwin',
    applicationRoots: [join(home, 'Applications')],
    run,
    launch,
    resolveExecutable: pathTable(),
  }
}

async function cursorBundle(home: string): Promise<void> {
  await mkdir(join(home, 'Applications', 'Cursor.app', 'Contents', 'Resources'), { recursive: true })
  await writeFile(join(home, 'Applications', 'Cursor.app', 'Contents', 'Resources', 'AppIcon.icns'), 'icns')
}

describe('open-in-app host routes (real Loader composition)', () => {
  it.each(['project-env', 'user-env'] as const)('ignores materialized SSH markers from %s', async (source) => {
    vi.stubEnv('SSH_CONNECTION', 'stale-connection')
    vi.stubEnv('SSH_TTY', '/dev/pts/stale')
    internals.catalog = {
      platform: 'darwin', applicationRoots: [], env: process.env,
      run: () => Promise.reject(new Error('fixture rejects')), resolveExecutable: pathTable(),
    }
    const base = await boot([{ source, values: { SSH_CONNECTION: 'stale-connection', SSH_TTY: '/dev/pts/stale' } }])

    expect(await (await fetch(`${base}/open-in-app/apps`)).json()).toEqual({ apps: ['finder', 'terminal'] })
  })

  it.each([
    { SSH_CONNECTION: '10.0.0.2 55000 10.0.0.9 22' },
    { SSH_TTY: '/dev/pts/3' },
  ])('returns an empty catalog and refuses icons and launches over SSH: %j', async (env) => {
    const run = vi.fn<NativeCommandRunner>()
    const launch = vi.fn<OpenInAppLauncher>()
    const resolveExecutable = vi.fn(pathTable())
    internals.catalog = { platform: 'darwin', env, run, launch, resolveExecutable }
    const base = await boot([{ source: 'process', values: env }])

    const apps = await fetch(`${base}/open-in-app/apps`)
    expect(apps.status).toBe(200)
    expect(await apps.json()).toEqual({ apps: [] })
    expect((await fetch(`${base}/open-in-app/icon/finder`)).status).toBe(404)
    const open = await fetch(`${base}/open-in-app/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'finder', path: root }),
    })
    expect(open.status).toBe(200)
    expect(await open.json()).toEqual({ ok: true, action: 'files' })
    expect(run).not.toHaveBeenCalled()
    expect(resolveExecutable).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it('keeps the function-plugin runtime surface to Loader exports', () => {
    expect(Object.keys(OpenInApp).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
  })

  it('answers the connection rejection on every route, before any resolution runs', async () => {
    const run = vi.fn<NativeCommandRunner>()
    internals.catalog = { platform: 'darwin', run, resolveExecutable: pathTable() }
    const base = await boot()
    trust.rejection = 403
    expect((await fetch(`${base}/open-in-app/apps`)).status).toBe(403)
    expect((await fetch(`${base}/open-in-app/icon/finder`)).status).toBe(403)
    expect((await fetch(`${base}/open-in-app/open`, { method: 'POST' })).status).toBe(403)
    expect((await fetch(`${base}/open-in-app/target`, { method: 'POST' })).status).toBe(403)
    expect((await fetch(`${base}/open-in-app/files`, { method: 'POST' })).status).toBe(403)
    expect((await fetch(`${base}/open-in-app/read`, { method: 'POST' })).status).toBe(403)
    expect(run).not.toHaveBeenCalled()
    trust.rejection = 401
    expect((await fetch(`${base}/open-in-app/apps`)).status).toBe(401)
    trust.rejection = undefined
    expect((await fetch(`${base}/open-in-app/apps`)).status).toBe(200)
  })

  it('serves the resolved catalog, one cached icon, and launches from the same resolution', async () => {
    const launches: string[][] = []
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-home-'))
    const workspace = join(home, 'workspace')
    await cursorBundle(home)
    await mkdir(workspace, { recursive: true })
    darwinFixture(home, launches)
    const base = await boot()
    try {
      const apps = await fetch(`${base}/open-in-app/apps`)
      expect(apps.status).toBe(200)
      expect(apps.headers.get('cache-control')).toBe('no-store')
      expect(await apps.json()).toEqual({ apps: ['finder', 'cursor', 'terminal'] })

      const icon = await fetch(`${base}/open-in-app/icon/cursor`)
      expect(icon.status).toBe(200)
      expect(icon.headers.get('content-type')).toBe('image/png')
      expect(await icon.text()).toBe('png-bytes')
      expect(await (await fetch(`${base}/open-in-app/icon/cursor`)).text()).toBe('png-bytes')

      expect((await fetch(`${base}/open-in-app/icon/nonesuch`)).status).toBe(404)

      const open = await fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'cursor', path: workspace }),
      })
      expect(open.status).toBe(200)
      expect(await open.json()).toEqual({ ok: true, action: 'launched' })
      expect(launches).toEqual([['open', '-a', join(home, 'Applications', 'Cursor.app'), workspace]])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('routes a Remote-SSH marker to the built-in file page without probing or launching apps', async () => {
    const run = vi.fn<NativeCommandRunner>()
    const launch = vi.fn<OpenInAppLauncher>()
    internals.catalog = { platform: 'win32', env: {}, run, launch, resolveExecutable: pathTable() }
    const base = await boot()
    const workspace = root as string
    await writeFile(join(workspace, REMOTE_WORKSPACE_MARKER), '{invalid-json')
    const invalidMarker = await fetch(`${base}/open-in-app/target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: workspace }),
    })
    expect(invalidMarker.status).toBe(200)
    expect(await invalidMarker.json()).toEqual({ kind: 'files', apps: [] })

    await writeFile(join(workspace, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 2,
      remoteRoot: String.raw`C:\repo`,
      connectionId: 'connection-1',
      generation: 1,
    }))

    const target = await fetch(`${base}/open-in-app/target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: workspace }),
    })
    expect(target.status).toBe(200)
    expect(await target.json()).toEqual({ kind: 'files', apps: [] })

    const open = await fetch(`${base}/open-in-app/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'explorer', path: workspace }),
    })
    expect(open.status).toBe(200)
    expect(await open.json()).toEqual({ ok: true, action: 'files' })
    expect(run).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it('lists local workspace files by provider-returned name segments and contains traversal', async () => {
    internals.catalog = { platform: 'aix', resolveExecutable: pathTable() }
    const base = await boot()
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-files-'))
    try {
      await mkdir(join(workspace, 'src'))
      await writeFile(join(workspace, 'README.md'), 'readme')
      await writeFile(join(workspace, 'src', 'index.ts'), 'source')
      setSession(workspace)
      const post = (segments: readonly string[]) => fetch(`${base}/open-in-app/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session', segments }),
      })

      const top = await post([])
      expect(top.status).toBe(200)
      expect(await top.json()).toMatchObject({
        displayPath: workspace,
        entries: [
          { name: 'README.md', type: 'file', size: 6 },
          { name: 'src', type: 'directory' },
        ],
        truncated: false,
      })
      expect(await (await post(['src'])).json()).toMatchObject({
        displayPath: join(workspace, 'src'),
        entries: [{ name: 'index.ts', type: 'file', size: 6 }],
      })
      const preview = await fetch(`${base}/open-in-app/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session', segments: ['README.md'] }),
      })
      expect(preview.status).toBe(200)
      expect(await preview.json()).toMatchObject({
        kind: 'text', format: 'markdown', text: 'readme', name: 'README.md', truncated: false,
      })
      const missingPreview = await fetch(`${base}/open-in-app/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session', segments: ['missing.txt'] }),
      })
      expect(missingPreview.status).toBe(404)
      expect((await post(['..'])).status).toBe(404)
      expect((await post(['README.md'])).status).toBe(404)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('validates target and file-list wire payloads before touching platform capabilities', async () => {
    internals.catalog = { platform: 'aix', resolveExecutable: pathTable() }
    const base = await boot()
    const post = (route: string, value: unknown): Promise<Response> => fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    })
    expect((await fetch(`${base}/open-in-app/target`)).status).toBe(405)
    expect((await fetch(`${base}/open-in-app/files`)).status).toBe(405)
    expect((await fetch(`${base}/open-in-app/read`)).status).toBe(405)
    expect((await fetch(`${base}/open-in-app/target`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json',
    })).status).toBe(400)
    expect((await fetch(`${base}/open-in-app/files`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json',
    })).status).toBe(400)
    expect((await fetch(`${base}/open-in-app/read`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json',
    })).status).toBe(400)

    for (const value of [null, [], { path: 7 }, { path: root, extra: true }]) {
      expect((await post('/open-in-app/target', value)).status).toBe(400)
    }
    for (const path of ['', 'relative', '/x\0y']) {
      expect((await post('/open-in-app/target', { path })).status).toBe(400)
    }
    expect((await post('/open-in-app/target', { path: join(root as string, 'missing') })).status).toBe(404)
    const local = await post('/open-in-app/target', { path: root })
    expect(local.status).toBe(200)
    expect(await local.json()).toEqual({ kind: 'local', apps: [] })

    const invalidFiles: unknown[] = [
      null,
      [],
      { sessionId: 7, segments: [] },
      { sessionId: 'session', segments: 'nope' },
      { sessionId: 'session', segments: [], root },
      { sessionId: 'session', segments: [], extra: true },
      { sessionId: 'session', segments: Array.from({ length: 65 }, () => 'x') },
      { sessionId: 'session', segments: [7] },
      { sessionId: 'session', segments: [''] },
      { sessionId: 'session', segments: ['x\0y'] },
      { sessionId: 'session', segments: ['x'.repeat(8_193)] },
      { sessionId: '', segments: [] },
      { sessionId: 'x\0y', segments: [] },
    ]
    for (const value of invalidFiles) {
      expect((await post('/open-in-app/files', value)).status).toBe(400)
    }
    expect((await post('/open-in-app/files', { sessionId: 'missing', segments: [] })).status).toBe(404)
    expect((await post('/open-in-app/read', { sessionId: 'session', segments: [] })).status).toBe(400)
  })

  it('traverses opaque provider targets without interpreting a Windows display path', async () => {
    const rootTarget = { targetKey: 'root', displayPath: String.raw`C:\repo` }
    const nestedTarget = { targetKey: 'nested', displayPath: String.raw`C:\repo\src` }
    const outsideTarget = { targetKey: 'outside', displayPath: String.raw`D:\outside` }
    const rootEntries = [
      { name: 'src', type: 'directory', target: nestedTarget },
      { name: 'outside', type: 'directory', target: outsideTarget },
      { name: 'plain.txt', type: 'file', target: { targetKey: 'plain', displayPath: String.raw`C:\repo\plain.txt` } },
      ...Array.from({ length: 1_998 }, (_, index) => ({
        name: `file-${String(index)}.txt`,
        type: 'file',
        target: { targetKey: `file-${String(index)}`, displayPath: String.raw`C:\repo\file-${String(index)}.txt` },
        size: index,
      })),
    ]
    const filesystem = {
      resolve: vi.fn(async (path: string) => {
        if (path.endsWith('throw')) throw new Error('provider offline')
        return rootTarget
      }),
      listDir: vi.fn(async (target: { targetKey: string }) => target.targetKey === 'nested'
        ? [{ name: 'index.ts', type: 'file', target: { targetKey: 'index', displayPath: String.raw`C:\repo\src\index.ts` }, size: 5 }]
        : rootEntries),
      contains: vi.fn((_root: unknown, target: { targetKey: string }) => target.targetKey !== 'outside'),
    }
    internals.catalog = { platform: 'aix', resolveExecutable: pathTable() }
    const base = await boot([], filesystem)
    setSession('/marker')
    setSession('/throw', 'throw-session')
    const post = (sessionId: string, segments: readonly string[]): Promise<Response> =>
      fetch(`${base}/open-in-app/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, segments }),
      })

    const top = await post('session', [])
    expect(top.status).toBe(200)
    const topPayload = await top.json() as { displayPath: string; entries: unknown[]; truncated: boolean }
    expect(topPayload.displayPath).toBe(String.raw`C:\repo`)
    expect(topPayload.entries).toHaveLength(2_000)
    expect(topPayload.truncated).toBe(true)
    expect(await (await post('session', ['src'])).json()).toMatchObject({
      displayPath: String.raw`C:\repo\src`,
      entries: [{ name: 'index.ts', type: 'file', size: 5 }],
    })
    expect((await post('session', ['outside'])).status).toBe(404)
    expect((await post('session', ['missing'])).status).toBe(404)
    expect((await post('session', ['plain.txt'])).status).toBe(404)
    expect((await post('throw-session', [])).status).toBe(502)
  })

  it('resolves the catalog once: list reads, menu opens, and launches share the pass', async () => {
    const launches: string[][] = []
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-home-'))
    const workspace = join(home, 'workspace')
    await cursorBundle(home)
    await mkdir(workspace, { recursive: true })
    darwinFixture(home, launches)
    const resolveExecutable = vi.fn(pathTable())
    internals.catalog = { ...internals.catalog, resolveExecutable }
    const base = await boot()
    try {
      await fetch(`${base}/open-in-app/apps`)
      await fetch(`${base}/open-in-app/apps`)
      const open = await fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'cursor', path: workspace }),
      })
      expect(open.status).toBe(200)
      expect(launches).toHaveLength(1)
      expect(resolveExecutable).not.toHaveBeenCalled()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refreshes one entry after a missing launcher and drops it when it no longer resolves', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-home-'))
    const workspace = join(home, 'workspace')
    await cursorBundle(home)
    await mkdir(workspace, { recursive: true })
    const attempts: string[][] = []
    const enoent = (): Promise<void> => Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    let launchOutcomes = [enoent, (): Promise<void> => Promise.resolve()]
    const launch: OpenInAppLauncher = (command, args) => {
      attempts.push([command, ...args])
      const next = launchOutcomes.shift()
      if (next === undefined) throw new Error('unexpected launch attempt')
      return next()
    }
    internals.catalog = {
      platform: 'darwin',
      applicationRoots: [join(home, 'Applications')],
      run: () => Promise.reject(new Error('fixture rejects')),
      launch,
      resolveExecutable: pathTable(),
    }
    const base = await boot()
    const openCursor = (): Promise<Response> => fetch(`${base}/open-in-app/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'cursor', path: workspace }),
    })
    try {
      expect((await openCursor()).status).toBe(200)
      expect(attempts).toHaveLength(2)

      await rm(join(home, 'Applications', 'Cursor.app'), { recursive: true, force: true })
      launchOutcomes = [enoent]
      expect((await openCursor()).status).toBe(502)
      expect(await (await fetch(`${base}/open-in-app/apps`)).json())
        .toEqual({ apps: ['finder', 'terminal'] })
      expect((await fetch(`${base}/open-in-app/icon/cursor`)).status).toBe(404)
      expect((await openCursor()).status).toBe(400)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects wrong methods, non-JSON content, malformed bodies, unknown apps, and bad paths', async () => {
    const launches: string[][] = []
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-home-'))
    await cursorBundle(home)
    darwinFixture(home, launches)
    const base = await boot()
    try {
      const wrongMethodApps = await fetch(`${base}/open-in-app/apps`, { method: 'POST' })
      expect(wrongMethodApps.status).toBe(405)
      expect(wrongMethodApps.headers.get('allow')).toBe('GET')
      expect((await fetch(`${base}/open-in-app/icon/cursor`, { method: 'POST' })).status).toBe(405)
      const wrongMethodOpen = await fetch(`${base}/open-in-app/open`)
      expect(wrongMethodOpen.status).toBe(405)
      expect(wrongMethodOpen.headers.get('allow')).toBe('POST')

      const form = await fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'app=cursor',
      })
      expect(form.status).toBe(415)
      const smuggled = await fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;x=application/json' },
        body: JSON.stringify({ app: 'cursor', path: home }),
      })
      expect(smuggled.status).toBe(415)

      const post = (body: string): Promise<Response> => fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body,
      })
      expect((await post('not json')).status).toBe(400)
      expect((await post('7')).status).toBe(400)
      expect((await post('null')).status).toBe(400)
      expect((await post(JSON.stringify(['array'])) ).status).toBe(400)
      expect((await post(JSON.stringify({ app: 7, path: '/tmp' }))).status).toBe(400)
      expect((await post(JSON.stringify({ app: 'vscode', path: home }))).status).toBe(400)
      expect((await post(JSON.stringify({ app: 'nonesuch', path: home }))).status).toBe(400)
      expect((await post(JSON.stringify({ app: 'cursor', path: 'relative/dir' }))).status).toBe(400)
      expect((await post(JSON.stringify({ app: 'cursor', path: '' }))).status).toBe(400)
      expect((await post(JSON.stringify({ app: 'cursor', path: join(home, 'missing') }))).status).toBe(404)
      const oversize = await post(JSON.stringify({ app: 'cursor', path: '/'.padEnd(70_000, 'x') }))
      expect(oversize.status).toBe(413)
      expect(launches).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('reports a failed launcher as 502 and an empty catalog on a platform without entries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-home-'))
    const workspace = join(home, 'workspace')
    await mkdir(workspace, { recursive: true })
    internals.catalog = {
      platform: 'darwin',
      applicationRoots: [join(home, 'Applications')],
      run: () => Promise.reject(new Error('down')),
      launch: () => Promise.reject(new Error('down')),
      resolveExecutable: pathTable(),
    }
    const base = await boot()
    try {
      const open = await fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'finder', path: workspace }),
      })
      expect(open.status).toBe(502)
      expect((await fetch(`${base}/open-in-app/icon/cursor`)).status).toBe(404)
    } finally {
      await rm(home, { recursive: true, force: true })
    }

    await context?.fiber.dispose()
    context = undefined
    internals.catalog = { platform: 'aix', resolveExecutable: pathTable() }
    const emptyBase = await boot()
    expect(await (await fetch(`${emptyBase}/open-in-app/apps`)).json()).toEqual({ apps: [] })
  })

  it('serves a Linux catalog resolved in-process and its desktop-entry SVG icon', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-home-'))
    const workspace = join(home, 'workspace')
    await mkdir(workspace, { recursive: true })
    const applications = join(home, '.local', 'share', 'applications')
    await mkdir(applications, { recursive: true })
    const svg = join(home, 'code.svg')
    await writeFile(svg, '<svg/>')
    await writeFile(join(applications, 'code.desktop'), `[Desktop Entry]\nExec=code\nIcon=${svg}\n`)
    const launches: string[][] = []
    const launch: OpenInAppLauncher = (command, args) => {
      launches.push([command, ...args])
      return Promise.resolve()
    }
    internals.catalog = {
      platform: 'linux',
      home,
      env: { XDG_DATA_DIRS: join(home, 'xdg-empty'), DISPLAY: ':0' },
      run: () => Promise.reject(new Error('fixture rejects')),
      launch,
      resolveExecutable: pathTable({ 'xdg-open': '/usr/bin/xdg-open', code: '/usr/bin/code' }),
    }
    const base = await boot()
    try {
      expect(await (await fetch(`${base}/open-in-app/apps`)).json())
        .toEqual({ apps: ['filemanager', 'vscode'] })
      const icon = await fetch(`${base}/open-in-app/icon/vscode`)
      expect(icon.status).toBe(200)
      expect(icon.headers.get('content-type')).toBe('image/svg+xml')
      expect(await icon.text()).toBe('<svg/>')
      expect((await fetch(`${base}/open-in-app/icon/filemanager`)).status).toBe(404)

      const open = await fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'vscode', path: workspace }),
      })
      expect(open.status).toBe(200)
      expect(launches).toEqual([['/usr/bin/code', workspace]])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('answers 400 when the connection dies mid-body', async () => {
    internals.catalog = { platform: 'aix', resolveExecutable: pathTable() }
    const base = await boot()
    const port = Number(new URL(base).port)
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write([
          'POST /open-in-app/open HTTP/1.1',
          'host: 127.0.0.1',
          'content-type: application/json',
          'content-length: 100',
          '',
          '{"app":',
        ].join('\r\n'))
        setTimeout(() => { socket.destroy() }, 50)
      })
      let answer = ''
      socket.on('data', (chunk) => { answer += String(chunk) })
      socket.on('close', () => { resolve(answer) })
      socket.on('error', reject)
    })
    expect(status === '' || status.startsWith('HTTP/1.1 400')).toBe(true)
    expect((await fetch(`${base}/open-in-app/apps`)).status).toBe(200)
  })

  it('resolves PATH names through the composition subprocess capability when the seam does not override it', async () => {
    internals.catalog = {
      platform: 'linux',
      env: { XDG_DATA_DIRS: '/nonexistent-xdg' },
      home: '/nonexistent-home',
      run: () => Promise.reject(new Error('fixture rejects')),
    }
    const base = await boot()
    expect(await (await fetch(`${base}/open-in-app/apps`)).json()).toEqual({ apps: [] })
  })

  it('removes every route when the plugin row is disposed (HMR safety)', async () => {
    internals.catalog = { platform: 'aix', resolveExecutable: pathTable() }
    const base = await boot()
    expect((await fetch(`${base}/open-in-app/apps`)).status).toBe(200)
    const entry = [...(context as Context).loader.entries()]
      .find(candidate => candidate.options.name === '@deepseek-ai/dsh-host-open-in-app')
    await entry?.fiber?.dispose()
    expect((await fetch(`${base}/open-in-app/apps`)).status).toBe(404)
    expect((await fetch(`${base}/open-in-app/icon/cursor`)).status).toBe(404)
    expect((await fetch(`${base}/open-in-app/open`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${base}/open-in-app/target`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${base}/open-in-app/files`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${base}/open-in-app/read`, { method: 'POST' })).status).toBe(404)
  })

  it('dispatches the registered no-server terminal upgrade route', async () => {
    internals.catalog = { platform: 'aix', resolveExecutable: pathTable() }
    const base = await boot()
    const url = `${base.replace('http://', 'ws://')}/open-in-app/terminal?sessionId=missing&cols=80&rows=24`
    await expect(websocketStatus(url)).resolves.toBe(404)
  })
})
