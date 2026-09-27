// @vitest-environment jsdom
/**
 * `<html lang>` tracks the active locale.
 *
 * HTML 标记可能与已保存的 Host 语言偏好不同；激活和切换时同步 lang，
 * 避免辅助技术及浏览器功能误判当前语言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { LOCALE_SETTINGS_NAMESPACE, LocaleSettingsSchema } from '../src/locale-settings.ts'

/** Boot the plugin over a stub Host settings document. */
async function bench(preference?: string) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  let stored = preference
  let revision = 0
  const namespace = () => ({
    ns: LOCALE_SETTINGS_NAMESPACE,
    schema: LocaleSettingsSchema.toJSON(),
    value: stored === undefined ? {} : { preference: stored },
    applies: 'live' as const,
    secrets: [],
    revision,
  })
  const describeRpc = vi.fn(async () => ({
    rpcId: 'locale-describe' as never,
    result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [namespace()] } },
  }))
  const mutate = vi.fn(async (request: { ops: { value: string }[] }) => {
    stored = request.ops[0]!.value
    revision += 1
    return { rpcId: 'locale-mutate' as never, result: { ok: true as const, value: namespace() } }
  })
  ctx.provide('connection', { api: { settings: { describe: describeRpc, mutate } }, isLoopback: true } as never)
  // The settings transport and the forwarded-event port the plugin injects.
  new TestRemote(ctx)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, locale: ctx.get('locale') as LocaleRuntime }
}

const langOf = (): string => document.documentElement.lang

describe('document language', () => {
  beforeEach(() => {
    // 即使初始标记与中文默认值不符，插件也必须主动同步。
    document.documentElement.lang = 'en'
    Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true })
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
  })

  afterEach(() => {
    // navigator properties are installed with defineProperty above, so they
    // are removed the same way; nothing here goes through vi.stubGlobal.
    const own = navigator as unknown as Record<string, unknown>
    delete own.languages
    delete own.language
  })

  it('激活时使用中文默认值更新文档语言，不跟随英文浏览器', async () => {
    const { locale } = await bench()
    expect(locale.getLocale().active).toBe('zh')
    expect(langOf()).toBe('zh-CN')
  })

  it('follows a locale switch in both directions with BCP 47 tags', async () => {
    const { locale } = await bench()
    expect(langOf()).toBe('zh-CN')
    locale.setLocale('en')
    // `en` needs no region; `zh` names its script variant, which bare `zh`
    // leaves ambiguous for pronunciation and font selection.
    expect(langOf()).toBe('en')
    locale.setLocale('zh')
    expect(langOf()).toBe('zh-CN')
  })

  it('已保存的 Host 英文偏好覆盖中文默认值', async () => {
    const { locale } = await bench('en')
    await vi.waitFor(() => { expect(locale.getLocale().active).toBe('en') })
    await vi.waitFor(() => { expect(langOf()).toBe('en') })
  })
})
