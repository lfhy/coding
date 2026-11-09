/** 通过真实 Loader 和 HTTP 覆盖拖放文件暂存的来源、工作区及字节安全边界。 */

import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import FsLocal from 'coding-fs-local'
import WebServer from 'coding-host-webserver'
import { REMOTE_WORKSPACE_MARKER } from 'coding-subprocess'
import {
  createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentLayerInput,
} from 'coding-launch-environment'
import * as OpenInApp from '../src/index.ts'
import { internals } from '../src/internals.ts'
import { OPEN_IN_APP_ATTACH_ROUTE } from '../src/shared.ts'

let root: string | undefined
let context: Context | undefined
const sessions = new Map<string, { header: { id: string; cwd?: string } }>()
let trustRejection: 401 | 403 | undefined
let trustChecks = 0

const uploadDirectory = (): string => join(root as string, '.dsh-uploads')

function attach(base: string, fileName: string, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${OPEN_IN_APP_ATTACH_ROUTE}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-session-id': 'session',
      'x-file-name': encodeURIComponent(fileName),
      ...headers,
    },
    body,
  })
}

/** 暂停 HTTP 请求流，使 Session 的变更发生在文件实际写入之后、HTTP 完成之前。 */
function pausedUpload(base: string, first: string, last: string): {
  readonly started: Promise<void>
  readonly finish: () => Promise<Response>
} {
  let release: (() => void) | undefined
  let opened: (() => void) | undefined
  const started = new Promise<void>((resolve) => { opened = resolve })
  const next = new Promise<void>((resolve) => { release = resolve })
  const bytes = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.encode(first))
      opened?.()
      void next.then(() => {
        controller.enqueue(bytes.encode(last))
        controller.close()
      })
    },
  })
  const response = fetch(`${base}${OPEN_IN_APP_ATTACH_ROUTE}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-session-id': 'session',
      'x-file-name': encodeURIComponent('in-flight.pptx'),
    },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  return { started, finish: () => { release?.(); return response } }
}

async function boot(layers: readonly LaunchEnvironmentLayerInput[] = []): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-attach-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'coding-fs-local'",
    '  config:',
    `    cwd: ${JSON.stringify(root)}`,
    "- name: 'coding-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: 'coding-host-open-in-app'",
    '  config:',
    '    probeTimeoutMs: 5000',
    '    iconTimeoutMs: 5000',
    '    launchWatchMs: 1000',
    '',
  ].join('\n'))

  internals.catalog = { platform: 'aix', env: {} }
  context = new Context()
  sessions.set('session', { header: { id: 'session', cwd: root } })
  context.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot(layers))
  context.baseUrl = pathToFileURL(root).href + '/'
  context.provide('connection', {
    requestRejection: () => { trustChecks++; return trustRejection },
  } as never)
  context.provide('sessions', { get: (id: string) => sessions.get(id) } as never)
  context.provide('agents', { get: () => undefined } as never)
  context.provide('subprocess', { resolveExecutable: () => Promise.resolve(null) } as never)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['coding-fs-local', FsLocal],
    ['coding-host-webserver', WebServer],
    ['coding-host-open-in-app', OpenInApp],
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

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  internals.catalog = {}
  sessions.clear()
  trustRejection = undefined
  trustChecks = 0
})

describe('open-in-app file attachment (real Loader and HTTP)', () => {
  it('calls connection rejection before looking up a session or creating a directory', async () => {
    const base = await boot()
    trustRejection = 401
    expect((await attach(base, 'bad.pptx', 'data')).status).toBe(401)
    trustRejection = 403
    expect((await attach(base, 'bad.pptx', 'data')).status).toBe(403)
    expect(trustChecks).toBe(2)
    await expect(readdir(uploadDirectory())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires a loopback same-origin request even when the connection stub trusts it', async () => {
    const base = await boot()
    for (const headers of [
      { origin: 'http://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ]) {
      expect((await attach(base, 'nope.pptx', 'data', headers)).status).toBe(403)
    }
    const port = Number(new URL(base).port)
    const rebindingStatus = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.end([
          `POST ${OPEN_IN_APP_ATTACH_ROUTE} HTTP/1.1`,
          'host: evil.example',
          'content-type: application/octet-stream',
          'x-session-id: session',
          'x-file-name: nope.pptx',
          'content-length: 4',
          '',
          'data',
        ].join('\r\n'))
      })
      let response = ''
      socket.on('data', (chunk) => { response += String(chunk) })
      socket.on('end', () => { resolve(response) })
      socket.on('error', reject)
    })
    expect(rebindingStatus).toMatch(/^HTTP\/1\.1 403/u)
    await expect(readdir(uploadDirectory())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stores exact binary bytes with distinct names and a relative mention-safe path', async () => {
    const base = await boot()
    const bytes = Buffer.from([0, 255, 64, 10, 97, 0])
    const first = await attach(base, '介绍 slides.pptx', bytes)
    const second = await attach(base, '介绍 slides.pptx', bytes)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('no-store')
    const firstPayload = await first.json() as { path: string }
    const secondPayload = await second.json() as { path: string }
    for (const { path } of [firstPayload, secondPayload]) {
      expect(path).toMatch(/^\.dsh-uploads\/[a-f0-9-]+-介绍 slides\.pptx$/u)
      expect(path).not.toMatch(/["\u0000-\u001f\u007f-\u009f]/u)
      expect(await readFile(join(root as string, path))).toEqual(bytes)
    }
    expect(firstPayload.path).not.toBe(secondPayload.path)
  })

  it('normalizes unsafe names into mention-safe paths without losing file bytes or extensions', async () => {
    const base = await boot()
    const bytes = Buffer.from([0, 255, 0, 11])
    const names = [
      ['part"name.pptx', 'part_name.pptx'],
      ['draft%2024.pptx', 'draft_2024.pptx'],
      ['folder/slide deck.pptx', 'slide deck.pptx'],
      ['..\\slides.pptx', 'slides.pptx'],
      ['a\nb.pptx', 'a_b.pptx'],
      ['a\u202eb.pptx', 'a_b.pptx'],
      ['<script>.pptx', 'script.pptx'],
      ['CON.pptx', '_CON.pptx'],
      ['trailing. ', 'trailing'],
      ['../escape.pptx', 'escape.pptx'],
      ['a..b.pptx', 'a_b.pptx'],
      ['slide😃-🧩.pptx', 'slide_-.pptx'],
      ['Q#2$~![] draft.pptx', 'Q_2_ draft.pptx'],
      ['Cafe\u0301.pptx', 'Café.pptx'],
      ['e\u0301\u0301.pptx', 'é.pptx'],
      ['😃🧩.pptx', 'file.pptx'],
      ['😃🧩', 'file'],
      ['汉'.repeat(70) + '.pptx', `${'汉'.repeat(38)}.pptx`],
    ] as const
    for (const [name, suffix] of names) {
      const response = await attach(base, name, bytes)
      expect(response.status).toBe(200)
      const payload = await response.json() as { path: string }
      expect(payload.path).toMatch(/^\.dsh-uploads\/[a-f0-9-]+-/u)
      expect(basename(payload.path)).toMatch(new RegExp(`-${suffix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u'))
      expect(payload.path).toMatch(/^\.dsh-uploads\/[a-zA-Z0-9._\p{L}\p{N} -]+$/u)
      expect(payload.path).not.toContain('..')
      expect(Buffer.byteLength(basename(payload.path).split('-').slice(5).join('-'), 'utf8')).toBeLessThanOrEqual(120)
      expect(await readFile(join(root as string, payload.path))).toEqual(bytes)
    }
  })

  it('rejects only missing or undecodable file names and invalid headers', async () => {
    const base = await boot()
    expect((await fetch(`${base}${OPEN_IN_APP_ATTACH_ROUTE}`)).status).toBe(405)
    expect((await attach(base, 'slides.pptx', 'data', { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await attach(base, 'slides.pptx', 'data', { 'x-session-id': '' })).status).toBe(400)
    for (const name of ['', '/', '..', '  .. ', '\\']) {
      expect((await attach(base, name, 'data')).status).toBe(400)
    }
    expect((await attach(base, 'x.pptx', 'data', { 'x-file-name': '%FF' })).status).toBe(400)
    await expect(readdir(uploadDirectory())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses missing sessions, absent workspace and relative or invalid cwd without leaking paths', async () => {
    const base = await boot()
    const missing = await attach(base, 'file.pptx', 'data', { 'x-session-id': 'missing' })
    expect(missing.status).toBe(404)
    expect(await missing.text()).not.toContain(root as string)
    sessions.set('session', { header: { id: 'session' } })
    const absent = await attach(base, 'file.pptx', 'data')
    expect(absent.status).toBe(409)
    expect(await absent.text()).not.toContain(root as string)
    sessions.set('session', { header: { id: 'session', cwd: 'relative' } })
    expect((await attach(base, 'file.pptx', 'data')).status).toBe(409)
    sessions.set('session', { header: { id: 'session', cwd: join(root as string, 'missing') } })
    expect((await attach(base, 'file.pptx', 'data')).status).toBe(409)
  })

  it.each([
    ['removed', 404],
    ['rebound', 409],
    ['cwd-changed', 409],
  ] as const)('removes a partially written file when its session is %s before commit', async (change, status) => {
    const base = await boot()
    const original = sessions.get('session')!
    const otherCwd = join(root as string, 'other')
    const pending = pausedUpload(base, 'first half', 'second half')
    await pending.started
    await expect.poll(async () => (await readdir(uploadDirectory())).length).toBe(1)
    switch (change) {
      case 'removed': sessions.delete('session'); break
      case 'rebound': sessions.set('session', { header: { id: 'session', cwd: root as string } }); break
      case 'cwd-changed': original.header.cwd = otherCwd; break
    }
    const response = await pending.finish()
    expect(response.status).toBe(status)
    expect(await response.text()).not.toContain(root as string)
    expect(await readdir(uploadDirectory())).toEqual([])
  })

  it('refuses SSH launch, valid and malformed remote markers', async () => {
    const ssh = await boot([{ source: 'process', values: { SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' } }])
    expect((await attach(ssh, 'file.pptx', 'data')).status).toBe(409)
    await context?.fiber.dispose()
    context = undefined
    const local = await boot()
    await writeFile(join(root as string, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 2, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1,
    }))
    expect((await attach(local, 'file.pptx', 'data')).status).toBe(409)
    await writeFile(join(root as string, REMOTE_WORKSPACE_MARKER), '{invalid-json')
    expect((await attach(local, 'file.pptx', 'data')).status).toBe(409)
    await expect(readdir(uploadDirectory())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an upload directory replaced before commit without leaving partial bytes', async () => {
    const base = await boot()
    const pending = pausedUpload(base, 'first half', 'second half')
    await pending.started
    await expect.poll(async () => (await readdir(uploadDirectory())).length).toBe(1)
    const displaced = join(root as string, 'displaced-uploads')
    await rename(uploadDirectory(), displaced)
    const response = await pending.finish()
    expect(response.status).toBe(409)
    expect(await readdir(displaced)).toEqual([])
  })

  it('refuses an upload directory replaced by a symlink before commit without following it', async () => {
    const base = await boot()
    const pending = pausedUpload(base, 'first half', 'second half')
    await pending.started
    await expect.poll(async () => (await readdir(uploadDirectory())).length).toBe(1)
    const elsewhere = await mkdtemp(join(tmpdir(), 'dsh-attachment-outside-'))
    const displaced = join(root as string, 'displaced-uploads')
    try {
      await rename(uploadDirectory(), displaced)
      await symlink(elsewhere, uploadDirectory(), 'dir')
      const response = await pending.finish()
      expect(response.status).toBe(409)
      expect(await readdir(displaced)).toEqual([])
      expect(await readdir(elsewhere)).toEqual([])
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('refuses an existing symlink upload directory instead of writing through it', async () => {
    const base = await boot()
    const elsewhere = await mkdtemp(join(tmpdir(), 'dsh-attachment-outside-'))
    try {
      await symlink(elsewhere, uploadDirectory(), 'dir')
      expect((await attach(base, 'file.pptx', 'data')).status).toBe(409)
      expect(await readdir(elsewhere)).toEqual([])
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('refuses a symlink workspace parent before creating an upload directory', async () => {
    const base = await boot()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-attachment-parent-'))
    try {
      const alias = join(root as string, 'alias')
      await symlink(outside, alias, 'dir')
      sessions.set('session', { header: { id: 'session', cwd: alias } })
      expect((await attach(base, 'file.pptx', 'data')).status).toBe(409)
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('honors exact 32 MiB and removes the partial file when the stream exceeds the limit', async () => {
    const base = await boot()
    const limit = Buffer.alloc(32 * 1024 * 1024, 37)
    expect((await attach(base, 'exact.pptx', limit)).status).toBe(200)
    const before = await readdir(uploadDirectory())
    expect(before).toHaveLength(1)
    const oversized = await attach(base, 'large.pptx', Buffer.concat([limit, Buffer.from([1])]))
    expect(oversized.status).toBe(413)
    expect(await readdir(uploadDirectory())).toEqual(before)
    const port = Number(new URL(base).port)
    const declaredStatus = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.end([
          `POST ${OPEN_IN_APP_ATTACH_ROUTE} HTTP/1.1`,
          `host: 127.0.0.1:${String(port)}`,
          'content-type: application/octet-stream',
          'x-session-id: session',
          'x-file-name: declared.pptx',
          `content-length: ${String(limit.byteLength + 1)}`,
          'connection: close',
          '',
          'small',
        ].join('\r\n'))
      })
      let response = ''
      socket.on('data', (chunk) => { response += String(chunk) })
      socket.on('close', () => { resolve(response) })
      socket.on('error', reject)
    })
    expect(declaredStatus).toMatch(/^HTTP\/1\.1 413/u)
    expect(await readdir(uploadDirectory())).toEqual(before)
  })

  it('removes a partially written file after a client disconnects mid-body', async () => {
    const base = await boot()
    const port = Number(new URL(base).port)
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write([
          `POST ${OPEN_IN_APP_ATTACH_ROUTE} HTTP/1.1`,
          `host: 127.0.0.1:${String(port)}`,
          'content-type: application/octet-stream',
          'x-session-id: session',
          'x-file-name: incomplete.pptx',
          'content-length: 1000000',
          '',
          'some bytes',
        ].join('\r\n'))
        setTimeout(() => socket.destroy(), 60)
      })
      socket.on('close', () => { resolve() })
      socket.on('error', reject)
    })
    await expect.poll(async () => (await readdir(uploadDirectory())).length).toBe(0)
  })

  it('unregisters the upload route on plugin disposal', async () => {
    const base = await boot()
    const entry = [...(context as Context).loader.entries()]
      .find(candidate => candidate.options.name === 'coding-host-open-in-app')
    await entry?.fiber?.dispose()
    expect((await attach(base, 'after.pptx', 'data')).status).toBe(404)
    await expect(readdir(uploadDirectory())).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
