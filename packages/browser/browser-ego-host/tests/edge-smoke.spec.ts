/** opt-in 真机 Edge：所有 profile/state 隔离在临时 XDG 根，完成后仅停止本次浏览器。 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from 'coding-session/types'
import type { SubprocessSpawnSpec } from 'coding-subprocess'
import type { ToolDefinition, ToolRunContext } from 'coding-tools'
import { describe, expect, it } from 'vitest'
import EgoBrowserHost from '../src/index.ts'

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const CLI = new URL('../runtime/ego-linux/bin/ego-browser.mjs', import.meta.url)

describe.skipIf(process.env.DSH_EGO_EDGE_SMOKE !== '1' || !existsSync(EDGE))('Edge 实际运行时', () => {
  it('隔离浏览器导航、快照、截图且按会话分离标签', { timeout: 125_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-ego-edge-smoke-'))
    process.env.EGO_LINUX_STATE_DIR = join(root, 'state')
    process.env.XDG_DATA_HOME = join(root, 'data')
    process.env.EGO_LINUX_CHROME = EDGE
    process.env.EGO_LINUX_HEADLESS = '1'
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(`<!doctype html><title>Ego Test</title>
<main>Session-only fixture</main>
<button id="plain">Plain</button>
<div id="shadow-host"></div>
<iframe id="frame" srcdoc="<button id='inner'>Inner</button>"></iframe>
<script>
const root = document.getElementById('shadow-host').attachShadow({ mode: 'open' })
root.innerHTML = '<button id="shadow-btn">Shadow</button>'
</script>`)
    })
    const origin = await new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    }))
    const ctx = new Context()
    const first = { id: SessionId('session-abc-one'), header: { cwd: root } }
    const second = { id: SessionId('session-abc-two'), header: { cwd: root } }
    ctx.provide('sessions', { get: (id: string) => [first, second].find(session => session.id === id) } as never)
    ctx.provide('subprocess', { spawn: (spec: SubprocessSpawnSpec) => {
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'], signal: spec.signal })
      const out: Buffer[] = [], err: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => { out.push(chunk) })
      child.stderr.on('data', (chunk: Buffer) => { err.push(chunk) })
      child.stdin.end(typeof spec.stdio.stdin === 'string' ? '' : spec.stdio.stdin.data)
      return { done: new Promise<{ exitCode: number | null }>(resolve => child.on('close', (exitCode) => { resolve({ exitCode }) })),
        collected: { stdout: { readFrom: () => ({ text: Buffer.concat(out).toString('utf8'), nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: Buffer.concat(err).toString('utf8'), nextOffset: 0, lossy: false }) } } }
    } } as never)
    const stop = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        const child = spawn(process.execPath, [CLI.pathname, '--stop'], { env: process.env, stdio: 'ignore' })
        child.on('close', () => { resolve() })
      })
      await ctx.fiber.dispose()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
      delete process.env.EGO_LINUX_STATE_DIR
      delete process.env.XDG_DATA_HOME
      delete process.env.EGO_LINUX_CHROME
      delete process.env.EGO_LINUX_HEADLESS
      await rm(root, { recursive: true, force: true })
    }
    try {
      await ctx.plugin(EgoBrowserHost).await()
      const tools = ctx.egoBrowser.toolDefinitions()
      const call = async (name: string, args: Record<string, unknown>, session = first): Promise<Record<string, unknown>> => {
        const tool = tools.find(item => item.name === name) as ToolDefinition
        const exec = { name, agent: { session }, signal: new AbortController().signal } as ToolRunContext
        return await tool.execute(args, exec) as Record<string, unknown>
      }
      expect((await call('ego_navigate', { url: origin })).ok).toBe(true)
      expect((await call('ego_page_info', { space: 'default' })).page).toMatchObject({ url: origin + '/' })
      expect((await call('ego_page_info', { space: '' })).page).toMatchObject({ url: origin + '/' })
      expect((await call('ego_snapshot', { space: 'default' })).text).toContain('Session-only fixture')
      expect((await call('ego_tabs', { space: 'default' })).tabs).toHaveLength(1)
      expect((await call('ego_tabs', { space: '' }, second)).tabs).toHaveLength(1)
      await expect(call('ego_tabs', { space: 'foreign' })).rejects.toThrow(/another task space is not available/u)
      // CSS 选择器只在顶层文档查询；命中 open shadow root 与同源 iframe 时回退到坐标点击。
      expect((await call('ego_click', { selector: '#shadow-btn' })).ok).toBe(true)
      expect((await call('ego_hover', { selector: '#shadow-btn' })).ok).toBe(true)
      expect((await call('ego_click', { selector: '#inner' })).ok).toBe(true)
      await expect(call('ego_click', { selector: '#missing-target' })).rejects.toThrow(/Element not found/u)
      // 旧 targetId 必须指出当前空间真正存在的 id，而不是只报告操作失败。
      const missing = await call('ego_tabs', { action: 'switch', targetId: 'deadbeef' })
      expect(missing.ok).toBe(false)
      expect(missing.error).toContain('not open in this task space')
      const screenshot = await call('ego_screenshot', { path: join(root, 'image.png') })
      expect(screenshot).toEqual({ ok: true, path: join(root, 'image.png') })
      expect((await stat(join(root, 'image.png'))).size).toBeGreaterThan(50)
    } finally { await stop() }
  })
})
