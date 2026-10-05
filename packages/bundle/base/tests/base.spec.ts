/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { type Duplex } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader, { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import PlaywrightBrowserUse from '../../../browser/browser-playwright/src/index.ts'
import ElectronBrowserUse from '../../../browser/browser-electron/src/index.ts'

const baseRoot = fileURLToPath(new URL('..', import.meta.url))
const bridgeOrigin = 'DSH_DESKTOP_BROWSER_BRIDGE_ORIGIN'
const bridgeToken = 'DSH_DESKTOP_BROWSER_BRIDGE_TOKEN'
const validToken = 'f'.repeat(64)
const contexts: Context[] = []
const fixtureRoots: string[] = []

interface BrowserRow {
  id: string
  name: string
  disabled?: { __jsExpr: string }
  config?: Record<string, unknown>
}

function browserRows(): BrowserRow[] {
  const patches = yaml.load(readFileSync(resolve(baseRoot, 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema }) as { insert?: BrowserRow[] }[]
  const rows = patches.flatMap(patch => patch.insert ?? [])
  const selected = rows.filter(row => row.id === 'browser-playwright' || row.id === 'browser-electron')
  expect(selected.map(row => row.id)).toEqual(['browser-playwright', 'browser-electron'])
  expect(selected.map(row => row.name)).toEqual([
    '@deepseek-ai/dsh-browser-playwright', '@deepseek-ai/dsh-browser-electron',
  ])
  for (const mode of ['web-app', 'headless']) {
    const modePatch = yaml.load(readFileSync(resolve(baseRoot, `../${mode}/cordis.patch.yml`), 'utf8'),
      { schema: entryListSchema }) as { id?: string; insert?: { id?: string }[] }[]
    const modeIds = modePatch.flatMap(patch => patch.insert?.map(row => row.id) ?? [patch.id])
    expect(modeIds, `${mode} must inherit the base browser selection`).not.toContain('browser-playwright')
    expect(modeIds, `${mode} must inherit the base browser selection`).not.toContain('browser-electron')
  }
  return selected
}

async function bootBrowserRows(): Promise<Context> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-browser-composition-'))
  fixtureRoots.push(root)
  writeFileSync(join(root, 'cordis.yml'), '[]\n')
  // Loader 使用 Node 解析插件名；薄转发模块将真实源码提供方放进测试专用组合树。
  for (const [id, name] of [
    ['browser-playwright', '__dshBasePlaywright'],
    ['browser-electron', '__dshBaseElectron'],
  ]) writeFileSync(join(root, `${id}.mjs`), `export default globalThis.${name}\n`)
  const globals = globalThis as unknown as {
    __dshBasePlaywright: typeof PlaywrightBrowserUse
    __dshBaseElectron: typeof ElectronBrowserUse
  }
  globals.__dshBasePlaywright = PlaywrightBrowserUse
  globals.__dshBaseElectron = ElectronBrowserUse

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    name: 'cordis:include',
    config: {
      path: pathToFileURL(join(root, 'cordis.yml')).href,
      patches: [{ insert: browserRows().map(row => ({ ...row, name: `./${row.id}.mjs` })) }],
    },
  })
  await ctx.loader.await()
  return ctx
}

function mountedBrowserRows(ctx: Context): string[] {
  return [...ctx.loader.entries()]
    .filter(entry => (entry.options.id === 'browser-playwright' || entry.options.id === 'browser-electron') &&
      entry.fiber !== undefined)
    .map(entry => entry.options.id)
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
  Reflect.deleteProperty(globalThis, '__dshBasePlaywright')
  Reflect.deleteProperty(globalThis, '__dshBaseElectron')
})

describe('dsh-base bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string; config?: Record<string, unknown> }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.config?.['mode']).toEqual({
      __jsExpr: "process.env.DSH_TELEMETRY_MODE || 'DISABLED'",
    })
    expect(rows.filter(row => row.id === 'subagent-codex')).toHaveLength(0)
    expect(rows.filter(row => row.id === 'subagent-claude-code')).toHaveLength(0)
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-codex')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-claude-code')
  })

  it('gates each shell stack by platform with a symmetric disabled expression', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    // Symmetric gating: each stack's executor and tool rows carry the same
    // platform fact, inverted between the bash and pwsh twins, so exactly one
    // shell stack mounts per host. Evaluate with a platform-scoped context
    // (the `with` scope shadows the global `process`) so both outcomes pin on
    // every host.
    for (const [id, win32, linux] of [
      ['bash-sandbox', true, false],
      ['tool-bash', true, false],
      ['pwsh-sandbox', false, true],
      ['tool-pwsh', false, true],
    ] as const) {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`base patch must mount ${id}`)
      const expression = (row.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      if (expression === undefined) throw new Error(`${id} must gate on a !!js disabled expression`)
      expect(Boolean(evaluate({ process: { platform: 'win32' } }, expression)), `${id} on win32`).toBe(win32)
      expect(Boolean(evaluate({ process: { platform: 'linux' } }, expression)), `${id} on linux`).toBe(linux)
    }
    // The platform layer folded into these rows: no separate patch file ships.
    expect(existsSync(resolve(root, 'windows.cordis.patch.yml'))).toBe(false)
  })
})

describe('shared Web and headless browser provider composition', () => {
  it('mounts only Playwright without desktop bridge environment', async () => {
    vi.stubEnv(bridgeOrigin, undefined)
    vi.stubEnv(bridgeToken, undefined)
    const ctx = await bootBrowserRows()
    expect(mountedBrowserRows(ctx)).toEqual(['browser-playwright'])
    expect(ctx.get('browserUse')).toBeInstanceOf(PlaywrightBrowserUse)
    expect(ctx.get('browserUse')).not.toBeInstanceOf(ElectronBrowserUse)
  })

  it('mounts only Electron with an authenticated private bridge', async () => {
    const server = createServer()
    const peers = new Set<Duplex>()
    const requests: { url: string | undefined; authorization: string | undefined }[] = []
    server.on('upgrade', (request, socket) => {
      requests.push({ url: request.url, authorization: request.headers.authorization })
      const key = request.headers['sec-websocket-key']
      if (typeof key !== 'string') { socket.destroy(); return }
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      peers.add(socket)
      socket.on('close', () => { peers.delete(socket) })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      vi.stubEnv(bridgeOrigin, `ws://127.0.0.1:${(server.address() as AddressInfo).port}/browser-bridge`)
      vi.stubEnv(bridgeToken, validToken)
      const ctx = await bootBrowserRows()
      expect(mountedBrowserRows(ctx)).toEqual(['browser-electron'])
      expect(ctx.get('browserUse')).toBeInstanceOf(ElectronBrowserUse)
      expect(ctx.get('browserUse')).not.toBeInstanceOf(PlaywrightBrowserUse)
      await vi.waitFor(() => { expect(requests).toHaveLength(1) })
      expect(requests).toEqual([{ url: '/browser-bridge', authorization: `Bearer ${validToken}` }])
    } finally {
      for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
      for (const socket of peers) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it.each([undefined, 'invalid-token'])('fails closed when the bridge token is %s', async (token) => {
    vi.stubEnv(bridgeOrigin, 'ws://127.0.0.1:12345/browser-bridge')
    vi.stubEnv(bridgeToken, token)
    await expect(bootBrowserRows()).rejects.toThrow(/desktop browser bridge environment is missing or invalid/)
    const ctx = contexts[0]!
    expect(mountedBrowserRows(ctx)).not.toContain('browser-playwright')
    expect(ctx.get('browserUse')).toBeUndefined()
  })
})
