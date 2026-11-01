/**
 * base 组合以 manifest 指定的 patch 为准；浏览器服务通过真实 Loader 组装验证，
 * 不执行页面操作或启动 Chrome。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader, { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import SessionStore from '../../../core/session/src/index.ts'
import LocalSubprocessRuntime from '../../../subprocess/subprocess-local/src/index.ts'

const baseRoot = fileURLToPath(new URL('..', import.meta.url))
const bridgeOrigin = 'DSH_DESKTOP_BROWSER_BRIDGE_ORIGIN'
const bridgeToken = 'DSH_DESKTOP_BROWSER_BRIDGE_TOKEN'
const contexts: Context[] = []
const fixtureRoots: string[] = []

interface BrowserRow {
  id: string
  name: string
}

function browserRows(): BrowserRow[] {
  const patches = yaml.load(readFileSync(resolve(baseRoot, 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema }) as { insert?: BrowserRow[] }[]
  const rows = patches.flatMap(patch => patch.insert ?? [])
  const selected = rows.filter(row => row.id === 'browser-ego-host')
  expect(selected).toEqual([{ id: 'browser-ego-host', name: 'coding-browser-ego-host' }])
  expect(rows.map(row => row.id)).not.toContain('browser-playwright')
  expect(rows.map(row => row.id)).not.toContain('browser-electron')
  for (const mode of ['web-app', 'headless']) {
    const modePatch = yaml.load(readFileSync(resolve(baseRoot, `../${mode}/cordis.patch.yml`), 'utf8'),
      { schema: entryListSchema }) as { id?: string; insert?: BrowserRow[] }[]
    const modeRows = modePatch.flatMap(patch => patch.insert ?? [])
    expect(modeRows.map(row => row.id), `${mode} must inherit the base browser service`).not.toContain('browser-ego-host')
    expect(modeRows.map(row => row.id), `${mode} must not mount legacy providers`).not.toContain('browser-playwright')
    expect(modeRows.map(row => row.id), `${mode} must not mount legacy providers`).not.toContain('browser-electron')
  }
  return selected
}

async function bootBrowserRows(): Promise<Context> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-browser-composition-'))
  fixtureRoots.push(root)
  writeFileSync(join(root, 'cordis.yml'), '[]\n')
  // 测试 Loader 使用真实 Host 源码；只替换包名解析，不启动浏览器进程。
  const host = await import('../../../browser/browser-ego-host/src/index.ts')

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['coding-session', SessionStore],
    ['coding-subprocess-local', LocalSubprocessRuntime],
    ['coding-browser-ego-host', host],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: {
      path: pathToFileURL(join(root, 'cordis.yml')).href,
      patches: [{ insert: [
        { id: 'session', name: 'coding-session' },
        { id: 'subprocess', name: 'coding-subprocess-local' },
        ...browserRows(),
      ] }],
    },
  })
  await ctx.loader.await()
  return ctx
}

function mountedBrowserRows(ctx: Context): string[] {
  return [...ctx.loader.entries()]
    .filter(entry => entry.options.id === 'browser-ego-host' && entry.fiber !== undefined)
    .map(entry => entry.options.id)
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
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
    // base 层只在空 profile 根插入一次行集合。
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
    expect(manifest.dependencies).not.toHaveProperty('coding-subagent-codex')
    expect(manifest.dependencies).not.toHaveProperty('coding-subagent-claude-code')
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
    // 两组 shell 执行器与工具按平台相反门控；用局部 process 求值固定双平台结果。
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
    // 平台差异已折叠在行内，不再额外交付 patch。
    expect(existsSync(resolve(root, 'windows.cordis.patch.yml'))).toBe(false)
  })
})

describe('shared Web and headless browser Host composition', () => {
  it.each([
    ['without desktop bridge environment', undefined, undefined],
    ['with desktop bridge environment', 'ws://127.0.0.1:12345/browser-bridge', 'f'.repeat(64)],
  ])('mounts the same sole ego Host %s', async (_scenario, origin, token) => {
    vi.stubEnv(bridgeOrigin, origin)
    vi.stubEnv(bridgeToken, token)
    const ctx = await bootBrowserRows()
    expect(mountedBrowserRows(ctx)).toEqual(['browser-ego-host'])
    expect([...ctx.loader.entries()].filter(entry => entry.fiber !== undefined &&
      entry.options.name === 'coding-browser-ego-host')).toHaveLength(1)
    expect(ctx.get('egoBrowser')).toBeDefined()
    expect(ctx.get('browserUse')).toBeUndefined()
  })
})
