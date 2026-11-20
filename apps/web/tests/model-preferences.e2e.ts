/** 真实 Web 设置页的单模型协议与新会话默认模式；不发送模型请求。 */
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
    const protocol = first.getByRole('combobox', { name: '上游请求格式', exact: true })
    await protocol.waitFor()
    expect(await protocol.inputValue()).toBe('')
    expect(await protocol.locator('option[value="openai-responses"]').count()).toBe(1)
    await protocol.selectOption('openai-responses')
    await captureModelSettings(first)
    await first.getByRole('button', { name: '取消', exact: true }).click()
    expect(await settingsDocument()).toEqual(original)

    const second = await modelSettings(CUSTOM_MODEL)
    const selected = second.getByRole('combobox', { name: '上游请求格式', exact: true })
    expect(await selected.inputValue()).toBe('')
    await selected.selectOption('openai-responses')
    await second.getByRole('button', { name: '保存', exact: true }).click()
    expect(await settingsDocument()).toEqual(original)
    const drafted = await modelSettings(CUSTOM_MODEL)
    expect(await drafted.getByRole('combobox', { name: '上游请求格式', exact: true }).inputValue())
      .toBe('openai-responses')
    await drafted.getByRole('button', { name: '取消', exact: true }).click()
    await settings().getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => {
      const profiles = (await settingsDocument())['llm-pi-ai'] as {
        providers: Record<string, { models: { id: string; api?: string }[] }>
      }
      return profiles.providers[CUSTOM_PROVIDER]?.models.find(model => model.id === CUSTOM_MODEL)?.api
    }, { timeout: 10_000 }).toBe('openai-responses')
    await provider('Preference Gateway').click()
    const saved = await modelSettings(CUSTOM_MODEL)
    await saved.getByRole('combobox', { name: '上游请求格式', exact: true }).selectOption('')
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
})
