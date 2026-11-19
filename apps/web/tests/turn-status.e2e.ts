/** 真实 Web 回归：验证首条消息交接和轮次进度，模型输出由回放脚本提供。 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import type { Agent } from 'coding-agent'
import type { ClientRequest } from 'coding-host-apiproxy'
import { CallId, type GenerateOptions, type StreamChunk } from 'coding-llm'
import type { ReplayEntry } from 'coding-llm-replay'
import type {} from 'coding-goal'
import type {} from 'coding-tool-status'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, connectFreshWorkspaceZh, newEnglishPage, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const MANUAL = '正在定位会话进度的更新入口'
const TODO = '验证待办更新会接管当前进度'
const SECOND_MANUAL = '正在核对待办与手动状态的交接'
const GOAL = '完成会话进度的可见性验证'
const LONG_MANUAL = `正在核对${'页面边界与状态更新'.repeat(11)}`
const FINAL_MANUAL = '正在整理本轮验证结果'
const CLOCK_TEXT = /^\d+(?:m \d+)?s$/u
const STATUS_SELECTOR = '[data-chat-flow] > [role="status"]'

/** 脚本模型发出普通工具调用，真实 AgentLoop 负责执行和提交副作用。 */
function toolResponse(id: string, name: string, args: object): ReplayEntry {
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: CallId(id), name, arguments: JSON.stringify(args) },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  return { kind: 'chunks', chunks }
}

/** 保留模型自然收尾路径，不以测试代码伪造 turn/end。 */
function textResponse(text: string): ReplayEntry {
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  }
}

/** 暂停测试控制的异步边界；取消时不等放行即可退出。 */
async function waitForRelease(released: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted()
  let abort: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => { reject(signal?.reason instanceof Error ? signal.reason : new Error('测试等待已取消')) }
      signal?.addEventListener('abort', abort, { once: true })
      void released.then(resolve, reject)
    })
  } finally {
    if (abort !== undefined) signal?.removeEventListener('abort', abort)
  }
}

/** 从实际绘制几何检查单行截断和计时，不修改任何页面样式。 */
async function expectBoundedStatus(page: Page, status: Locator, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  await status.scrollIntoViewIfNeeded()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth), { timeout: 10_000 })
    .toBeLessThanOrEqual(width + 1)
  // 侧栏收起和网格列宽使用过渡；文档先收敛不代表中间列已分到最终宽度。
  await expect.poll(() => status.locator('span[title]').evaluate(element => element.clientWidth), { timeout: 10_000 })
    .toBeGreaterThan(0)
  const layout = await status.evaluate((element) => {
    const label = element.querySelector<HTMLElement>('span[title]')
    const clock = [...element.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')]
      .find(span => /^\d+(?:m \d+)?s$/u.test(span.textContent ?? ''))
    if (label === null || clock === undefined) throw new Error('running status must have a label and clock')
    const rootBox = element.getBoundingClientRect()
    const labelBox = label.getBoundingClientRect()
    const clockBox = clock.getBoundingClientRect()
    const style = getComputedStyle(label)
    return {
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      rootLeft: rootBox.left, rootRight: rootBox.right, rootHeight: rootBox.height,
      labelRight: labelBox.right, labelWidth: label.clientWidth, labelContentWidth: label.scrollWidth,
      clockLeft: clockBox.left, clockRight: clockBox.right, clockWidth: clockBox.width,
      whiteSpace: style.whiteSpace, overflow: style.overflow, textOverflow: style.textOverflow,
      clockText: clock.textContent,
    }
  })
  expect(layout.documentWidth).toBeLessThanOrEqual(width + 1)
  expect(layout.documentHeight).toBeLessThanOrEqual(height + 1)
  expect(layout.rootLeft).toBeGreaterThanOrEqual(0)
  expect(layout.rootRight).toBeLessThanOrEqual(width + 1)
  expect(layout.rootHeight).toBe(26)
  expect(layout.labelWidth).toBeGreaterThan(0)
  expect(layout.labelContentWidth).toBeGreaterThan(layout.labelWidth)
  expect(layout.labelRight).toBeLessThanOrEqual(layout.clockLeft)
  expect(layout.clockWidth).toBeGreaterThan(0)
  expect(layout.clockRight).toBeLessThanOrEqual(layout.rootRight + 1)
  expect(layout.clockText).toBe('1m 05s')
  expect(layout.whiteSpace).toBe('nowrap')
  expect(layout.overflow).toBe('hidden')
  expect(layout.textOverflow).toBe('ellipsis')
}

describe.skipIf(MODE === 'record')('web e2e: first prompt and current-turn status', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let sidecarRoot: string | undefined
  let agent: Agent | undefined

  afterEach(async () => {
    const failures: unknown[] = []
    if (agent?.status === 'running') {
      agent.cancel({ kind: 'user' })
      await agent.whenIdle().catch((error: unknown) => failures.push(error))
    }
    agent = undefined
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (sidecarRoot !== undefined) {
      await rm(sidecarRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    sidecarRoot = undefined
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'turn-status teardown failed')
  })

  it('updates from real model tools, restores after reload and stays bounded at narrow widths', async () => {
    sidecarRoot = await mkdtemp(join(tmpdir(), 'dsh-web-turn-status-'))
    const readyFile = join(sidecarRoot, 'next-turn-ready')
    const fixture = join(sidecarRoot, 'session.jsonl')
    const override = join(sidecarRoot, 'replay.override.json')
    const script: ReplayEntry[] = [
      toolResponse('status-manual', 'set_status', { text: MANUAL }),
      toolResponse('status-todo', 'todo_write', { todos: [{ content: TODO, status: 'in_progress' }] }),
      toolResponse('status-second-manual', 'set_status', { text: SECOND_MANUAL }),
      toolResponse('status-auto-todo', 'set_status', { text: null }),
      toolResponse('status-complete-todo', 'todo_write', { todos: [{ content: TODO, status: 'completed' }] }),
      toolResponse('status-long', 'set_status', { text: LONG_MANUAL }),
      toolResponse('status-auto-random', 'set_status', { text: null }),
      toolResponse('status-final', 'set_status', { text: FINAL_MANUAL }),
      textResponse('本轮状态验证已完成。'),
      { kind: 'hang', readyFile },
    ]
    await writeFile(fixture, '{"type":"session","version":0,"id":"turn-status-script","createdAt":0}\n')
    await writeFile(override, JSON.stringify(script))
    scaffold = await launchWebScaffold({
      replayFixture: fixture, replayOverride: override, replayContextWindow: 1_000_000,
    })

    const requests: GenerateOptions[] = []
    const gates = script.map(() => Promise.withResolvers<undefined>())
    scaffold.ctx.on('llm/stream', (options, next) => (async function* () {
      const index = requests.length
      const gate = gates[index]
      if (gate === undefined || options.purpose !== undefined) throw new Error('unexpected turn-status model request')
      requests.push(options)
      await waitForRelease(gate.promise, options.signal)
      yield* next()
    })())

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-turn-status'))
    agent = scaffold.ctx.agents.roots()[0]
    if (agent === undefined) throw new Error('fresh workspace did not create its root Agent')
    const owner = agent
    const status = page.locator(STATUS_SELECTOR)
    const label = status.locator('span[title]')
    const clock = status.locator('span[aria-hidden="true"]').filter({ hasText: CLOCK_TEXT })
    const input = page.locator('textarea').first()
    const settled = scaffold.whenTurnSettled(90_000)
    await input.fill('验证会话运行进度的自动跟随与手动覆盖。')
    await input.press('Enter')
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1)
    expect(requests[0]?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['set_status', 'todo_write']))

    // 在开放轮次中创建真实目标并立即停用续行；仅目标投影参与展示，不启动额外模型轮次。
    const goal = scaffold.ctx.goals.create(owner, { objective: GOAL })
    scaffold.ctx.goals.disarm(owner)
    expect(scaffold.ctx.goals.get(owner)?.activation).toBe('disarmed')
    await expect.poll(() => label.textContent(), { timeout: 10_000 }).toBe(GOAL)

    gates[0]!.resolve(undefined)
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(2)
    await expect.poll(() => label.textContent(), { timeout: 10_000 }).toBe(MANUAL)
    expect(await status.getAttribute('aria-live')).toBe('polite')
    expect(owner.session.events.filter(event => event.type === 'status/set').at(-1)?.data.text).toBe(MANUAL)

    gates[1]!.resolve(undefined)
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(3)
    await expect.poll(() => label.textContent(), { timeout: 10_000 }).toBe(TODO)
    expect(scaffold.ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBeNull()

    gates[2]!.resolve(undefined)
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(4)
    await expect.poll(() => label.textContent(), { timeout: 10_000 }).toBe(SECOND_MANUAL)

    gates[3]!.resolve(undefined)
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(5)
    await expect.poll(() => label.textContent(), { timeout: 10_000 }).toBe(TODO)

    gates[4]!.resolve(undefined)
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(6)
    await expect.poll(() => label.textContent(), { timeout: 10_000 }).toBe(GOAL)
    scaffold.ctx.goals.clear(owner, { id: goal.id, revision: goal.revision })
    await expect.poll(() => status.textContent(), { timeout: 10_000 }).toContain('Coding...')
    expect(await label.textContent()).not.toBe('')
    expect(await label.getAttribute('aria-hidden')).toBe('true')

    gates[5]!.resolve(undefined)
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(7)
    await expect.poll(() => label.textContent(), { timeout: 10_000 }).toBe(LONG_MANUAL)
    const turnStart = owner.session.events.find(event => event.type === 'turn/start')
    if (turnStart === undefined) throw new Error('model tools ran without a durable turn/start')
    // 只固定浏览器挂钟，定时器、Host 事件和持久 turn/start 保持真实，避免等待一分钟。
    await page.clock.setFixedTime(turnStart.time + 65_000)
    await expect.poll(() => clock.textContent(), { timeout: 10_000 }).toBe('1m 05s')

    const warningsBeforeReload = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expect.poll(() => label.textContent(), { timeout: 15_000 }).toBe(LONG_MANUAL)
    await expect.poll(() => clock.textContent(), { timeout: 10_000 }).toBe('1m 05s')
    acknowledgeReloadConnectionLoss(tripwire, warningsBeforeReload)
    expect(requests).toHaveLength(7)
    expect(owner.status).toBe('running')
    for (const viewport of [
      { width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1680, height: 1000 },
    ]) {
      await expectBoundedStatus(page, status, viewport.width, viewport.height)
    }

    gates[6]!.resolve(undefined)
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(8)
    await expect.poll(() => status.textContent(), { timeout: 10_000 }).toContain('Coding...')
    expect(await label.textContent()).not.toBe(LONG_MANUAL)

    gates[7]!.resolve(undefined)
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(9)
    await expect.poll(() => label.textContent(), { timeout: 10_000 }).toBe(FINAL_MANUAL)
    gates[8]!.resolve(undefined)
    expect(await settled).toBe(owner.id)
    await owner.whenIdle()
    await expect.poll(() => status.count(), { timeout: 10_000 }).toBe(0)
    expect(scaffold.ctx.sessionProjections.snapshot(owner.session).values.turnStatus).toBeNull()

    const nextSettled = scaffold.whenTurnSettled(30_000)
    await input.fill('开始下一轮，检查没有沿用上轮状态。')
    await input.press('Enter')
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(10)
    await expect.poll(() => status.textContent(), { timeout: 10_000 }).toContain('Coding...')
    expect(await label.textContent()).not.toBe(FINAL_MANUAL)
    expect(await label.textContent()).not.toBe(LONG_MANUAL)
    gates[9]!.resolve(undefined)
    await expect.poll(() => existsSync(readyFile), { timeout: 15_000 }).toBe(true)
    await page.getByRole('button', { name: 'Stop generating' }).click()
    expect(await nextSettled).toBe(owner.id)
    await owner.whenIdle()
    await expect.poll(() => status.count(), { timeout: 10_000 }).toBe(0)

    const statusEvents = owner.session.events.filter(event => event.type === 'status/set')
    expect(statusEvents.map(event => event.data.text)).toEqual([
      MANUAL, SECOND_MANUAL, null, LONG_MANUAL, null, FINAL_MANUAL,
    ])
    expect(statusEvents.every(event => event.data.turn === turnStart.data.turn)).toBe(true)
    expect(owner.session.events.filter(event => event.type === 'todo/write')).toHaveLength(2)
    expect(owner.session.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
      .toEqual(['completed', 'aborted'])
    const toolResults = owner.session.events.filter(event => event.type === 'tool/result')
    expect(toolResults).toHaveLength(8)
    expect(toolResults.every(event => !event.data.message.content[0].isError)).toBe(true)
    expect(requests).toHaveLength(script.length)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 150_000)

  it.each([
    { outcome: '接纳后只显示一条正式消息', prompt: '首发回显验证：蓝杉', refuse: false },
    { outcome: '拒绝后保留可编辑草稿', prompt: '首发草稿验证：银杏', refuse: true },
  ])('首条普通消息：$outcome', async ({ prompt, refuse }) => {
    const reply = '收到这条测试消息。'
    const options = {
      localePreference: 'zh' as const,
      defaultModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }
    if (refuse) {
      // 无回放的组装只提供模型目录；若拒绝后仍发起模型调用，测试会失败。
      scaffold = await launchWebScaffold(options)
    } else {
      sidecarRoot = await mkdtemp(join(tmpdir(), 'dsh-web-first-prompt-'))
      const fixture = join(sidecarRoot, 'session.jsonl')
      const override = join(sidecarRoot, 'replay.override.json')
      await writeFile(fixture, '{"type":"session","version":0,"id":"first-prompt-script","createdAt":0}\n')
      await writeFile(override, JSON.stringify([textResponse(reply)]))
      scaffold = await launchWebScaffold({ ...options, replayFixture: fixture, replayOverride: override })
    }

    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    page.setDefaultTimeout(10_000)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-first-prompt'))
    agent = scaffold.ctx.agents.roots()[0]
    if (agent === undefined) throw new Error('测试工作区未创建空白会话')
    const owner = agent
    const chat = page.locator('[data-chat-flow]')
    const input = page.locator('[data-composer-seat] textarea')
    const sentText = chat.getByText(prompt, { exact: true })
    const formalRow = chat.locator('[data-chat-flow-kind="user"]').getByText(prompt, { exact: true })
    const activity = () => owner.session.events.filter(event => event.type === 'turn/start' || event.type === 'user/message')
    expect(activity()).toEqual([])
    expect(await sentText.count()).toBe(0)

    const promptUrl = `${scaffold.baseUrl}/api/session.prompt`
    const requests: ClientRequest[] = []
    const forward = Promise.withResolvers<boolean>()
    const prepare = Promise.withResolvers<undefined>()
    let atPreStep = false
    const offPrepare = scaffold.ctx.on('agent/pre-step', async ({ agent: candidate, turn, step, signal }, next) => {
      if (candidate === owner && turn === 1 && step === 1) {
        atPreStep = true
        await waitForRelease(prepare.promise, signal)
      }
      return await next()
    })
    await page.route(promptUrl, async (route) => {
      const request = route.request().postDataJSON() as ClientRequest & { payload: Record<string, unknown> }
      requests.push(request)
      if (!await forward.promise) {
        await route.abort()
        return
      }
      if (refuse) {
        // 用真实 Host 执行准入拒绝；保留请求标识、会话和消息，不替换响应或下行帧。
        await route.continue({
          postData: JSON.stringify({ ...request, payload: { ...request.payload, clientTimeZone: 'Test/Invalid_Zone' } }),
        })
      } else {
        await route.continue()
      }
    })

    try {
      await input.fill(prompt)
      await input.press('Enter')
      await expect.poll(() => requests.length, { timeout: 10_000 }).toBe(1)
      const [request] = requests
      if (request === undefined) throw new Error('未捕获首条消息请求')
      expect(request).toMatchObject({
        type: 'client-request', method: 'session.prompt',
        payload: { sessionId: owner.id, mode: 'queue', content: [{ type: 'text', text: prompt }] },
      })

      const sending = chat.locator('[data-pending-message="sending"]')
      await sending.getByText(prompt, { exact: true }).waitFor({ timeout: 10_000 })
      await sending.getByRole('status').filter({ hasText: /^正在发送…$/u }).waitFor({ timeout: 10_000 })
      expect(await sentText.count()).toBe(1)
      expect(await formalRow.count()).toBe(0)
      expect(activity()).toEqual([])

      const response = page.waitForResponse(promptUrl, { timeout: 15_000 })
      forward.resolve(true)
      const envelope: unknown = await (await response).json()
      if (refuse) {
        expect(envelope).toMatchObject({ rpcId: request.rpcId, result: { ok: false, error: { code: 'invalid-time-zone' } } })
        await expect.poll(async () => ({
          editable: await input.isEditable(), draft: await input.inputValue(), copies: await sentText.count(),
        }), { timeout: 10_000 }).toEqual({ editable: true, draft: prompt, copies: 0 })
        expect(owner.inbox.hasPending).toBe(false)
        expect(activity()).toEqual([])
      } else {
        expect(envelope).toMatchObject({ rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } })
        // 首步暂停在领取之后、写入会话历史之前。
        await expect.poll(() => atPreStep, { timeout: 15_000 }).toBe(true)
        await chat.locator('[data-pending-message="preparing"]').getByText(prompt, { exact: true })
          .waitFor({ timeout: 10_000 })
        expect(await sending.count()).toBe(0)
        expect(await sentText.count()).toBe(1)
        expect(await formalRow.count()).toBe(0)
        expect(owner.inbox.nextTurn).toHaveLength(0)
        expect(activity().map(event => event.type)).toEqual(['turn/start'])

        const settled = scaffold.whenTurnSettled()
        prepare.resolve(undefined)
        expect(await settled).toBe(owner.id)
        await formalRow.waitFor({ timeout: 10_000 })
        await chat.getByText(reply, { exact: true }).waitFor({ timeout: 10_000 })
        expect(await sentText.count()).toBe(1)
        expect(await chat.locator('[data-pending-message]').count()).toBe(0)
        await expect.poll(() => input.inputValue(), { timeout: 10_000 }).toBe('')
        const recorded = owner.session.events.filter(event =>
          event.type === 'user/message' && event.data.source.kind === 'user')
        expect(recorded.map(event => event.data)).toMatchObject([{
          content: [{ type: 'text', text: prompt }], source: { rpcId: request.rpcId },
        }])
      }
      expect(requests).toHaveLength(1)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      forward.resolve(false)
      prepare.resolve(undefined)
      offPrepare()
      if (!page.isClosed()) await page.unrouteAll({ behavior: 'wait' })
    }
  })
})
