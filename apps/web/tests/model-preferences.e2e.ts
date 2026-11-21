/** 真实 Web 设置页的渠道／模型协议与新会话默认模式；不发送模型请求。 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { load } from 'js-yaml'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { credentialRef } from 'coding-credentials'
import { settingsNamespace } from 'coding-settings'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const DEEPSEEK_PROVIDER = 'deepseek-official'
const DEEPSEEK_MODEL = 'deepseek-v4-flash'
const CUSTOM_PROVIDER = 'preference-gateway'
const CUSTOM_MODEL = 'neutral-model'
const CHAT_FORMAT = 'OpenAI Chat Completions'
const AUTOMATIC_FORMAT = `自动 (${CHAT_FORMAT})`

describe('web e2e: per-model protocol and default Agent mode', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  const settings = () => page.getByRole('main', { name: '设置', exact: true }).first()
  const settingsDocument = async (): Promise<Record<string, unknown>> => {
    const contents = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    return load(contents) as Record<string, unknown>
  }
  const deepSeekProfile = async () => (await settingsDocument())['llm-deepseek'] as {
    channelName?: string
    baseURL?: string
    outbound?: { mode: string }
    api?: string
    models?: { id: string; name?: string; api?: string }[]
  } | undefined
  const provider = (name: string): Locator => settings()
    .getByRole('complementary', { name: '提供方' })
    .getByRole('button').filter({ hasText: name }).first()
  const modelSettings = async (modelId: string): Promise<Locator> => {
    const ids = settings().getByRole('textbox', { name: /^模型 ID \d+$/ })
    await expect.poll(() => ids.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value)))
      .toContain(modelId)
    const index = (await ids.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value)))
      .indexOf(modelId) + 1
    await settings().getByRole('button', { name: `模型设置 ${index}` }).click()
    const modal = page.getByRole('dialog', { name: `模型设置 ${index}` })
    await modal.waitFor()
    return modal
  }
  const createSession = async (sessionId: string, agentPreset?: string): Promise<string> => {
    const response = await fetch(`${scaffold.baseUrl}/api/session.create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: `model-preference-${sessionId}`, method: 'session.create',
        payload: { sessionId, cwd: scaffold.workspaceCwd, ...agentPreset === undefined ? {} : { agentPreset } },
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      result: { ok: true; value: { agentPreset?: string } } | { ok: false; error: { message: string } }
    }
    if (!body.result.ok) throw new Error(`session.create failed: ${body.result.error.message}`)
    return body.result.value.agentPreset ?? ''
  }

  const captureModelSettings = async (modal: Locator): Promise<void> => {
    const directory = process.env.DSH_SCREENSHOT_DIR
    if (directory === undefined) return
    await page.screenshot({ path: join(directory, 'model-preferences-desktop.png'), fullPage: false })
    await page.setViewportSize({ width: 375, height: 812 })
    const bounds = await modal.boundingBox()
    if (bounds === null) throw new Error('模型设置窗口未显示')
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(375)
    expect(await modal.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await modal.getByRole('button', { name: '保存', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(directory, 'model-preferences-mobile.png'), fullPage: false })
    await page.setViewportSize({ width: 1680, height: 1000 })
  }

  const expectFitsViewport = async (control: Locator, width: number): Promise<void> => {
    const bounds = await control.boundingBox()
    if (bounds === null) throw new Error('上游请求格式未显示')
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
  }
  const protocolOf = (scope: Locator) => scope.getByRole('button', { name: '上游请求格式', exact: true })
  const chooseProtocol = async (trigger: Locator, name: string): Promise<void> => {
    await trigger.click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      localePreference: null, deepSeekMissingCredential: true,
      defaultModel: { provider: DEEPSEEK_PROVIDER, model: DEEPSEEK_MODEL },
    })
    await scaffold.ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'sk-e2e-model-preferences')
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: {
        [CUSTOM_PROVIDER]: {
          displayName: 'Preference Gateway', api: 'openai-completions',
          baseURL: 'https://gateway.preferences.example/v1',
          models: [{ id: CUSTOM_MODEL, name: 'Neutral Model' }],
        },
      },
    })
    await scaffold.ctx.settings.update(settingsNamespace('agent-presets'), { default: 'chat' })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    expect(page.url()).toBe(`${scaffold.baseUrl}/`)
    expect(await page.title()).not.toBe('')
    expect(await page.locator('vite-error-overlay').count()).toBe(0)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await settings().getByRole('button', { name: '模型', exact: true }).click()
    await provider('DeepSeek').waitFor({ timeout: 10_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('stores a model protocol only after provider Apply and clears it back to channel inheritance', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-protocol'))
    await provider('Preference Gateway').click()
    const original = await settingsDocument()
    const first = await modelSettings(CUSTOM_MODEL)
    const inherited = `继承渠道格式 (${CHAT_FORMAT})`
    const protocol = protocolOf(first)
    await protocol.waitFor()
    expect(await protocol.textContent()).toBe(inherited)
    await chooseProtocol(protocol, 'OpenAI Responses')
    await captureModelSettings(first)
    await first.getByRole('button', { name: '取消', exact: true }).click()
    expect(await settingsDocument()).toEqual(original)

    const second = await modelSettings(CUSTOM_MODEL)
    const selected = protocolOf(second)
    expect(await selected.textContent()).toBe(inherited)
    await chooseProtocol(selected, 'OpenAI Responses')
    await second.getByRole('button', { name: '保存', exact: true }).click()
    expect(await settingsDocument()).toEqual(original)
    const drafted = await modelSettings(CUSTOM_MODEL)
    expect(await protocolOf(drafted).textContent()).toBe('OpenAI Responses')
    await drafted.getByRole('button', { name: '取消', exact: true }).click()
    await settings().getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => {
      const profiles = (await settingsDocument())['llm-pi-ai'] as {
        providers: Record<string, { models: { id: string; api?: string }[] }>
      }
      return profiles.providers[CUSTOM_PROVIDER]?.models.find(model => model.id === CUSTOM_MODEL)?.api
    }, { timeout: 10_000 }).toBe('openai-responses')
    // 磁盘写入先于设置镜像刷新和编辑器重挂载；等详情确认保存后再打开模型。
    await settings().getByRole('status').filter({ hasText: `已保存 Preference Gateway (${CUSTOM_PROVIDER})。` })
      .waitFor({ timeout: 10_000 })
    const saved = await modelSettings(CUSTOM_MODEL)
    await chooseProtocol(protocolOf(saved), inherited)
    await saved.getByRole('button', { name: '保存', exact: true }).click()
    await settings().getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => {
      const profiles = (await settingsDocument())['llm-pi-ai'] as {
        providers: Record<string, { api: string; models: { id: string; api?: string }[] }>
      }
      return profiles.providers[CUSTOM_PROVIDER]?.models.find(model => model.id === CUSTOM_MODEL)?.api
    }, { timeout: 10_000 }).toBeUndefined()
    const profile = ((await settingsDocument())['llm-pi-ai'] as {
      providers: Record<string, { models: { api?: string }[] }>
    }).providers[CUSTOM_PROVIDER]!
    expect(profile.models[0]?.api).toBeUndefined()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('uses the exact model default for new sessions without materializing inherited model rows', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-default-mode'))
    const existing = await createSession('model-preference-existing')
    expect(existing).toBe('chat')
    await provider('DeepSeek').click()
    const initial = await settingsDocument()
    const modal = await modelSettings(DEEPSEEK_MODEL)
    const mode = modal.getByRole('combobox', { name: '默认模式', exact: true })
    expect(await mode.inputValue()).toBe('')
    await mode.selectOption('standard')
    await modal.getByRole('button', { name: '取消', exact: true }).click()
    const unmodified = await modelSettings(DEEPSEEK_MODEL)
    const modeDraft = unmodified.getByRole('combobox', { name: '默认模式', exact: true })
    expect(await modeDraft.inputValue()).toBe('')
    await modeDraft.selectOption('minimal')
    await unmodified.getByRole('button', { name: '保存', exact: true }).click()
    expect(await settingsDocument()).toEqual(initial)
    await settings().getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => {
      const presets = (await settingsDocument())['agent-presets'] as {
        modelDefaults?: Record<string, Record<string, string>>
      }
      return presets?.modelDefaults?.[DEEPSEEK_PROVIDER]?.[DEEPSEEK_MODEL]
    }, { timeout: 10_000 }).toBe('minimal')
    const persisted = await settingsDocument()
    expect((persisted['llm-deepseek'] as { models?: unknown } | undefined)?.models).toBeUndefined()
    expect(await createSession('model-preference-new')).toBe('minimal')
    expect(await createSession('model-preference-explicit', 'standard')).toBe('standard')
    expect(scaffold.ctx.agentPresets.composedPreset(
      scaffold.ctx.agents.get('model-preference-existing' as never)!.ctx,
    )).toBe('chat')

    await provider('DeepSeek').click()
    const reopened = await modelSettings(DEEPSEEK_MODEL)
    const inherited = reopened.getByRole('combobox', { name: '默认模式', exact: true })
    expect(await inherited.inputValue()).toBe('minimal')
    await inherited.selectOption('')
    await reopened.getByRole('button', { name: '保存', exact: true }).click()
    expect((await settingsDocument())['agent-presets']).toEqual(persisted['agent-presets'])
    await settings().getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => {
      const presets = (await settingsDocument())['agent-presets'] as {
        modelDefaults?: Record<string, Record<string, string>>
      }
      return presets?.modelDefaults?.[DEEPSEEK_PROVIDER]?.[DEEPSEEK_MODEL]
    }, { timeout: 10_000 }).toBeUndefined()
    expect(await createSession('model-preference-inherited')).toBe('chat')
    expect((await settingsDocument())['llm-deepseek']).toEqual(persisted['llm-deepseek'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('persists and clears both DeepSeek protocol levels without changing the channel identity', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deepseek-protocol'))
    const original = {
      channelName: 'DeepSeek 兼容网关',
      baseURL: 'http://127.0.0.1:1/v1',
      outbound: { mode: 'direct' },
      models: [{ id: DEEPSEEK_MODEL, name: 'Flash' }, { id: 'gateway-extra', name: 'Extra' }],
    } as const
    // 先退出上一用例的 DeepSeek 草稿，重新打开时应从刚写入的 profile 取同一版配置。
    await provider('Free').click()
    await scaffold.ctx.settings.update(settingsNamespace('llm-deepseek'), original)
    const credentialsPath = join(scaffold.harnessHome, '.credentials.yaml')
    const savedCredentials = await readFile(credentialsPath)
    const channel = 'DeepSeek 兼容网关'
    await provider(channel).click()
    const detail = settings().getByRole('main', { name: channel, exact: true })
    const protocol = protocolOf(detail)
    const apply = async () => {
      await detail.getByRole('button', { name: '保存', exact: true }).click()
      await detail.getByRole('status').filter({ hasText: `已保存 ${channel} (${DEEPSEEK_PROVIDER})。` }).waitFor({ timeout: 10_000 })
    }
    const saveModel = (modal: Locator) => modal.getByRole('button', { name: '保存', exact: true }).click()

    await protocol.waitFor()
    expect(await protocol.textContent()).toBe(AUTOMATIC_FORMAT)
    await expectFitsViewport(protocol, 1680)
    await chooseProtocol(protocol, 'OpenAI Responses')
    const model = await modelSettings(DEEPSEEK_MODEL)
    const override = protocolOf(model)
    const inherited = '继承渠道格式 (OpenAI Responses)'
    expect(await override.textContent()).toBe(inherited)
    await page.setViewportSize({ width: 375, height: 812 })
    await expectFitsViewport(override, 375)
    await override.press('ArrowDown')
    const messages = page.getByRole('menuitem', { name: 'Anthropic Messages', exact: true })
    await expectFitsViewport(messages, 375)
    await page.keyboard.press('Escape')
    expect(await override.getAttribute('aria-expanded')).toBe('false')
    expect(await override.evaluate(node => node === document.activeElement)).toBe(true)
    await chooseProtocol(override, 'Anthropic Messages')
    await saveModel(model)
    await model.waitFor({ state: 'hidden' })
    await expectFitsViewport(protocol, 375)
    await page.setViewportSize({ width: 1680, height: 1000 })

    expect(await deepSeekProfile()).toEqual(original)
    await apply()
    await expect.poll(deepSeekProfile).toEqual({
      ...original,
      api: 'openai-responses',
      models: [{ ...original.models[0], api: 'anthropic-messages' }, original.models[1]],
    })
    await provider('Free').click()
    const free = settings().getByRole('main', { name: 'Free', exact: true })
    await free.getByRole('region', { name: '模型目录', exact: true }).first().waitFor()
    expect(await protocolOf(free).count()).toBe(0)
    expect(await free.getByRole('button', { name: /^模型设置/ }).count()).toBe(0)
    await provider(channel).click()
    expect(await protocol.textContent()).toBe('OpenAI Responses')
    const reopened = await modelSettings(DEEPSEEK_MODEL)
    expect(await protocolOf(reopened).textContent()).toBe('Anthropic Messages')
    await chooseProtocol(protocolOf(reopened), inherited)
    await saveModel(reopened)
    await apply()
    await expect.poll(deepSeekProfile).toEqual({ ...original, api: 'openai-responses' })

    await chooseProtocol(protocol, AUTOMATIC_FORMAT)
    await apply()
    await expect.poll(deepSeekProfile).toEqual(original)
    expect(await protocol.textContent()).toBe(AUTOMATIC_FORMAT)
    expect((await readFile(credentialsPath)).equals(savedCredentials)).toBe(true)
    expect(scaffold.ctx.llm.listProviders()).toContainEqual({ id: DEEPSEEK_PROVIDER, name: channel })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
