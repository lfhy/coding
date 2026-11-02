/** 真 WebServer + Host 信任栅栏：任何拒绝都不读取载荷也不启动浏览器。 */
import { Context } from '@deepseek-ai/cordis'
import WebServer from 'coding-host-webserver'
import { SessionId } from 'coding-session/types'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { markToolStart } from '../src/activity.ts'
import EgoBrowserHost from '../src/index.ts'
import { spaceNameForSession } from '../src/session-space.ts'

let ctx: Context | undefined
let stateDir: string | undefined
let session: { id: ReturnType<typeof SessionId>; header: { cwd: string } }
let checks: ReturnType<typeof vi.fn>
let spawns: ReturnType<typeof vi.fn>
let settingsRegister: ReturnType<typeof vi.fn>

async function boot(rejection?: 403): Promise<string> {
  stateDir = await mkdtemp(join(tmpdir(), 'coding-ego-host-route-'))
  vi.stubEnv('EGO_LINUX_STATE_DIR', stateDir)
  session = { id: SessionId('session-abcdefgh-first'), header: { cwd: stateDir } }
  ctx = new Context()
  checks = vi.fn(() => rejection)
  spawns = vi.fn(() => { throw new Error('a rejected route must never spawn a worker') })
  ctx.provide('connection', { requestRejection: checks } as never)
  ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined } as never)
  ctx.provide('subprocess', { spawn: spawns } as never)
  settingsRegister = vi.fn(() => ({ get: () => ({}), watch: () => () => {} }))
  ctx.provide('settings', { register: settingsRegister } as never)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  await ctx.plugin(EgoBrowserHost).await()
  return `http://127.0.0.1:${String(ctx.webServer.port)}`
}

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  ctx = undefined
  stateDir = undefined
})

describe('会话浏览器 Host 路由', () => {
  it('所有 API 端点和不存在的危险路由均执行可信连接检查', async () => {
    const origin = await boot(403)
    for (const path of [
      '/api/ego/spaces?sessionId=session-abcdefgh-first',
      '/api/ego/stream?sessionId=session-abcdefgh-first',
      '/api/ego/frame?sessionId=session-abcdefgh-first&targetId=x',
      '/api/ego/activity',
      '/api/ego/input',
      '/api/ego/navigation',
    ]) {
      const response = await fetch(origin + path, ['/api/ego/input', '/api/ego/navigation'].includes(path)
        ? { method: 'POST', body: '{bad' } : {})
      expect(response.status, path).toBe(403)
    }
    expect(checks.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(spawns).not.toHaveBeenCalled()
    for (const path of ['/api/ego/login-import', '/api/ego/close', '/api/ego/status', '/ego/api/set', '/api/ego/watch/start']) {
      expect([403, 401, 405, 404]).toContain((await fetch(origin + path)).status)
    }
  })

  it('拒绝不存在的 Session、跨 Session 帧和输入；不启动 worker', async () => {
    const origin = await boot()
    await writeFile(join(stateDir!, 'task-spaces.json'), JSON.stringify({ spaces: [
      { name: spaceNameForSession(SessionId('another-session')), targetIds: ['foreign'] },
      { name: spaceNameForSession(session.id), targetIds: ['owned'] },
    ] }))
    expect((await fetch(`${origin}/api/ego/spaces?sessionId=unknown`)).status).toBe(404)
    expect((await fetch(`${origin}/api/ego/frame?sessionId=${session.id}&targetId=foreign`)).status).toBe(404)
    expect((await fetch(`${origin}/api/ego/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, targetId: 'foreign', type: 'mousePressed', x: 1, y: 2 }),
    })).status).toBe(403)
    const postNavigation = (body: unknown): Promise<Response> => fetch(`${origin}/api/ego/navigation`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect((await postNavigation({ sessionId: 'unknown', targetId: 'owned', action: 'reload' })).status).toBe(400)
    expect((await postNavigation({ sessionId: session.id, targetId: 'foreign', action: 'reload' })).status).toBe(403)
    expect((await postNavigation({ sessionId: session.id, targetId: 'owned', action: 'navigate', url: 'javascript:alert(1)' })).status).toBe(400)
    expect((await postNavigation({ sessionId: session.id, targetId: 'owned', action: 'reload', cdp: 'Page.navigate' })).status).toBe(400)
    expect(spawns).not.toHaveBeenCalled()
  })

  it('空会话的 navigate 在派生空间中创建页面，拒绝已占用空间与其他动作', async () => {
    const origin = await boot()
    const action = { sessionId: session.id, action: 'navigate', url: 'https://example.com/' }
    const post = async (body: unknown): Promise<number> => (await fetch(`${origin}/api/ego/navigation`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).status
    expect(await post({ ...action, action: 'reload' })).toBe(400)
    expect(await post({ ...action, url: 'javascript:alert(1)' })).toBe(400)
    await writeFile(join(stateDir!, 'task-spaces.json'), JSON.stringify({ spaces: [
      { name: spaceNameForSession(session.id), targetIds: ['owned'] },
    ] }))
    expect(await post(action)).toBe(409)
    expect(spawns).not.toHaveBeenCalled()
    await writeFile(join(stateDir!, 'task-spaces.json'), JSON.stringify({ spaces: [] }))
    // 创建标签时必须使用会话哈希空间；模拟进程失败，不能误报页面已创建。
    expect(await post(action)).toBe(503)
    const spec = spawns.mock.calls.find(call => (call[0] as { argv?: string[] }).argv?.includes('nodejs'))?.[0] as {
      env?: NodeJS.ProcessEnv
      stdio?: { stdin?: { data?: string } }
    }
    expect(spec.stdio?.stdin?.data).toContain(`taskSpaces.useOrCreate(${JSON.stringify(spaceNameForSession(session.id))})`)
    expect(spec.stdio?.stdin?.data).toContain(`ego.createTab(${JSON.stringify(action.url)})`)
    expect(spec.env?.EGO_ISOLATE_SPACES).toBe('1')
  })

  it('空会话建页脚本能在 CLI 预置 page 形参下执行并登记目标', async () => {
    const origin = await boot()
    const space = spaceNameForSession(session.id)
    const address = 'https://example.org/'
    const AsyncFunction = (async () => {}).constructor as
      new (...args: string[]) => (...args: unknown[]) => Promise<void>
    spawns.mockImplementation((raw: unknown) => {
      const spec = raw as { stdio: { stdin: { data: string } } }
      const run = new AsyncFunction('taskSpaces', 'ego', 'page', 'console', spec.stdio.stdin.data)
      let stdout = ''
      return {
        done: run({ useOrCreate: async (name: string) => { expect(name).toBe(space) } },
          { createTab: async (url: string) => {
            expect(url).toBe(address)
            await writeFile(join(stateDir!, 'task-spaces.json'), JSON.stringify({ spaces: [
              { name: space, targetIds: ['created'] },
            ] }))
            return { targetId: 'created' }
          } }, {}, { log: (line: string) => { stdout += `${line}\n` } }).then(() => ({ exitCode: 0 })),
        collected: { stdout: { readFrom: () => ({ text: stdout }) } },
      }
    })
    const response = await fetch(`${origin}/api/ego/navigation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, action: 'navigate', url: address }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(spawns).toHaveBeenCalledTimes(1)
  })

  it('活动流重连时只回放存活会话的最近一次工具调用', async () => {
    const origin = await boot()
    const missing = SessionId('not-loaded-session')
    markToolStart(missing, 'ego_navigate')
    markToolStart(session.id, 'ego_navigate')
    markToolStart(session.id, 'ego_snapshot')
    const controller = new AbortController()
    const response = await fetch(`${origin}/api/ego/activity`, { signal: controller.signal })
    const reader = response.body!.getReader()
    const chunk = await reader.read()
    controller.abort()
    const text = new TextDecoder().decode(chunk.value)
    expect(text).toContain(`"sessionId":"${session.id}"`)
    expect(text).toContain('browser_snapshot')
    expect(text).not.toContain('not-loaded-session')
  })

  it('把上游浏览器设置注册为可编辑的插件命名空间', async () => {
    await boot()
    expect(settingsRegister).toHaveBeenCalled()
    expect(settingsRegister.mock.calls[0]?.[0]).toBe('ego-browser')
  })

  it('暴露上游完整工具集，浏览器前缀由消费方统一映射', async () => {
    await boot()
    const tools = ctx!.egoBrowser.toolDefinitions()
    const names = tools.map(tool => tool.name).sort()
    expect(names).toHaveLength(35)
    expect(names).toContain('ego_cli')
    expect(names).toContain('ego_script')
    expect(names).toContain('ego_space_open')
    expect(names).toContain('ego_download')
    expect(names).toContain('ego_upload')
    expect(names).toContain('ego_login_import')
    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ type: 'object' })
      expect(tool.name.startsWith('browser_')).toBe(false)
    }
    expect(spawns).not.toHaveBeenCalled()
  })

  it('只为已存在的会话打开浏览器窗口，并拒绝无效会话', async () => {
    const origin = await boot()
    const post = (body: unknown): Promise<Response> => fetch(`${origin}/api/ego/window`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect((await post({ sessionId: 'unknown' })).status).toBe(400)
    expect((await post({})).status).toBe(400)
    expect(spawns).not.toHaveBeenCalled()
    // 会话有效时向浏览器进程发出 --open；fixture 的 spawn 会抛错，因此以失败告知。
    expect((await post({ sessionId: session.id })).status).toBe(503)
    expect(spawns).toHaveBeenCalledTimes(1)
    // 这个进程也必须继承配置：否则打开的窗口里会重新出现厂商光标标签。
    const spec = spawns.mock.calls[0]?.[0] as { env?: NodeJS.ProcessEnv }
    expect(spec.env?.EGO_LINUX_CURSOR_NAME).toBe('Agent')
    expect(spec.env?.EGO_LINUX_HEADLESS).toBe('1')
  })

  it('把无窗口与光标标签配置传给浏览器进程', async () => {
    await boot()
    const tool = ctx!.egoBrowser.toolDefinitions().find(item => item.name === 'ego_status')
    try {
      await tool!.execute({}, {
        name: 'ego_status', agent: { session }, signal: new AbortController().signal,
      } as never)
    } catch { /* fixture 的 spawn 故意失败，捕获到的环境已足够断言。 */ }
    const spec = spawns.mock.calls.at(-1)?.[0] as { env?: NodeJS.ProcessEnv }
    // 缺少运行时配置字段时 resolveEgoEnv 读不到这两项，浏览器会照默认值弹出窗口
    // 并显示厂商标签，因此这里直接锁住注入结果。
    expect(spec.env?.EGO_LINUX_HEADLESS).toBe('1')
    expect(spec.env?.EGO_LINUX_CURSOR_NAME).toBe('Agent')
  })
})
