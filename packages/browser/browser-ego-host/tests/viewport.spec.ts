/** 模拟 ego CLI 执行 Host 拼装的视口脚本，固定设备度量与实测读回的语义。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from 'coding-session/types'
import type { SubprocessSpawnSpec } from 'coding-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import EgoBrowserHost from '../src/index.ts'
import { recentActions } from '../src/activity.ts'
import { spaceNameForSession } from '../src/session-space.ts'

type Script = (taskSpaces: unknown, browser: unknown, ego: unknown, page: unknown, cdp: unknown,
  console: unknown) => Promise<void>
const AsyncFunction = (async function () {}).constructor as new (...args: string[]) => Script

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
})

interface FixtureOptions {
  /** 空间里是否存在可操作的页面；false 时模拟冷启动的空空间。 */
  readonly pages?: boolean
  /** 让 CLI 进程以非零码退出。 */
  readonly fails?: boolean
}

/**
 * 用 vm 同形地执行 Host 生成的脚本：`cdp` 只记录方法，并维护一份可以被读回的度量。
 * 页面读回值刻意取自已生效的覆盖，这样「实测值」不是请求值的回显。
 */
async function fixture(options: FixtureOptions = {}) {
  root = await mkdtemp(join(tmpdir(), 'coding-ego-viewport-'))
  const session = SessionId('viewport-session')
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const spaces: string[] = []
  const selected: string[] = []
  let metrics: { width: number; height: number; deviceScaleFactor: number } | null = null
  ctx = new Context()
  ctx.provide('sessions', { get: (id: string) => id === session ? { id } : undefined } as never)
  ctx.provide('subprocess', { spawn: (spec: SubprocessSpawnSpec) => {
    let stdout = ''
    const script = typeof spec.stdio.stdin === 'string' ? '' : spec.stdio.stdin.data
    const done = (async () => {
      try {
        const run = new AsyncFunction('taskSpaces', 'browser', 'ego', 'page', 'cdp', 'console', script)
        await run(
          { useOrCreate: async (name: string) => { spaces.push(name) } },
          {
            listTabs: async () => options.pages === false ? [] : [{ targetId: 'tab-1', url: 'http://127.0.0.1/', active: true }],
            switchTab: async (id: string) => { selected.push(id) },
          },
          {},
          {
            evaluate: async (expression: string) => {
              expect(expression).toContain('window.innerWidth')
              return { width: metrics?.width ?? 1280, height: metrics?.height ?? 800,
                devicePixelRatio: metrics?.deviceScaleFactor ?? 1 }
            },
            waitForTimeout: async () => {},
          },
          async (method: string, params?: Record<string, unknown>) => {
            calls.push(params === undefined ? { method } : { method, params })
            if (method === 'Emulation.setDeviceMetricsOverride') {
              metrics = { width: params?.width as number, height: params?.height as number,
                deviceScaleFactor: params?.deviceScaleFactor as number }
            } else if (method === 'Emulation.clearDeviceMetricsOverride') metrics = null
            return {}
          },
          { log: (line: string) => { stdout += `${line}\n` } },
        )
        return { exitCode: options.fails === true ? 1 : 0 }
      } catch { return { exitCode: 1 } }
    })()
    return { done, collected: { stdout: { readFrom: () => ({ text: stdout }) } } }
  } } as never)
  await ctx.plugin(EgoBrowserHost).await()
  return { session, calls, spaces, selected, metrics: () => metrics }
}

describe('设备模拟视口', () => {
  it('在会话空间设置设备度量并回报页面自己读到的尺寸', async () => {
    const browser = await fixture()
    const outcome = await ctx!.egoBrowser.emulateViewport({
      sessionId: browser.session,
      input: { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 },
    })
    expect(outcome).toEqual({ ok: true, width: 390, height: 844, devicePixelRatio: 3 })
    expect(browser.spaces).toEqual([spaceNameForSession(browser.session)])
    expect(browser.selected).toEqual(['tab-1'])
    expect(browser.calls).toEqual([{ method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true } }])
    // 视口变化是用户能看到的画面变化，必须计入可见活动。
    expect(recentActions(browser.session).some(action => action.tool === 'browser_viewport')).toBe(true)
  })

  it('缺省的移动端与像素比按桌面、1 倍收敛', async () => {
    const browser = await fixture()
    expect(await ctx!.egoBrowser.emulateViewport({ sessionId: browser.session, input: { width: 768, height: 1024 } }))
      .toEqual({ ok: true, width: 768, height: 1024, devicePixelRatio: 1 })
    expect(browser.calls[0]?.params).toEqual({ width: 768, height: 1024, deviceScaleFactor: 1, mobile: false })
  })

  it('reset 清除覆盖并回报恢复后的窗口尺寸', async () => {
    const browser = await fixture()
    await ctx!.egoBrowser.emulateViewport({ sessionId: browser.session, input: { width: 390, height: 844 } })
    const outcome = await ctx!.egoBrowser.emulateViewport({ sessionId: browser.session, input: { reset: true } })
    expect(outcome).toEqual({ ok: true, width: 1280, height: 800, devicePixelRatio: 1 })
    expect(browser.calls.map(call => call.method))
      .toEqual(['Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride'])
    expect(browser.metrics()).toBeNull()
  })

  it('空间里没有页面时说明原因，不去 attach 不存在的目标', async () => {
    const browser = await fixture({ pages: false })
    const outcome = await ctx!.egoBrowser.emulateViewport({ sessionId: browser.session, input: { width: 390, height: 844 } })
    expect(outcome).toMatchObject({ ok: false })
    if (outcome.ok) throw new Error('a page-less space must not report success')
    expect(outcome.reason).toContain('no page is open')
    expect(browser.calls).toEqual([])
  })

  it('会话已结束时不启动浏览器进程', async () => {
    const browser = await fixture()
    expect(await ctx!.egoBrowser.emulateViewport({ sessionId: SessionId('gone'), input: { width: 390, height: 844 } }))
      .toEqual({ ok: false, reason: 'the session is no longer open' })
    expect(browser.spaces).toEqual([])
  })

  it('CLI 非零退出时报告失败而不是伪造视口', async () => {
    const browser = await fixture({ fails: true })
    expect(await ctx!.egoBrowser.emulateViewport({ sessionId: browser.session, input: { width: 390, height: 844 } }))
      .toEqual({ ok: false, reason: 'the browser did not return a viewport measurement' })
  })

  it('参数越界、缺失与互相矛盾都在启动进程前拒绝', async () => {
    const browser = await fixture()
    const call = (input: Record<string, unknown>) =>
      ctx!.egoBrowser.emulateViewport({ sessionId: browser.session, input })
    await expect(call({})).rejects.toThrow('width and height are required')
    await expect(call({ width: 199, height: 844 })).rejects.toThrow('width must be an integer between 200 and 3840')
    await expect(call({ width: 390, height: 2161 })).rejects.toThrow('height must be an integer between 200 and 2160')
    await expect(call({ width: 390.5, height: 844 })).rejects.toThrow('width must be an integer')
    await expect(call({ width: 390, height: 844, mobile: 'yes' })).rejects.toThrow('mobile must be a boolean')
    await expect(call({ width: 390, height: 844, deviceScaleFactor: 4 }))
      .rejects.toThrow('deviceScaleFactor must be a number between 0.5 and 3')
    await expect(call({ reset: true, width: 390, height: 844 })).rejects.toThrow('reset cannot be combined')
    expect(browser.spaces).toEqual([])
  })
})
