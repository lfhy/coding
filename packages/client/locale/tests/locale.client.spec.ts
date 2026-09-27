// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { stubSettingsScope, type StubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { LocaleSettings, LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { FALLBACK_LOCALE, LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
const make = (host?: StubSettingsScope<LocaleSettings>): {
  ctx: Context
  svc: LocaleRuntime
  events: LocaleSnapshot[]
} => {
  const ctx = new Context()
  const events: LocaleSnapshot[] = []
  ctx.on('locale/change', (snapshot) => { events.push(snapshot) })
  return { ctx, svc: new LocaleRuntime(ctx, host?.scope), events }
}

/**
 * 模拟浏览器语言，证明无 Host 偏好时默认中文不受 navigator 影响；
 * 测试还要覆盖缺失 languages 列表和非浏览器运行。
 */
const stubLanguages = (...tags: string[]): void => {
  vi.stubGlobal('navigator', { languages: tags, language: tags[0] ?? '' })
}

describe('LocaleRuntime', () => {
  beforeEach(() => {
    // 默认中文不依赖浏览器语言，测试另行覆盖英文浏览器。
    stubLanguages('zh-CN')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('translates through the active-locale -> en -> key chain', () => {
    const { svc } = make()
    svc.register('ns', 'zh', { hello: '你好' })
    svc.register('ns', 'en', { hello: 'Hello', onlyEn: 'English only' })
    const t = svc.bind('ns')
    expect(svc.getLocale().active).toBe('zh')
    expect(t('hello')).toBe('你好')
    // The active locale misses this key; the en fallback supplies it.
    expect(t('onlyEn')).toBe('English only')
    svc.setLocale('en')
    expect(t('hello')).toBe('Hello')
    expect(t('missing.key')).toBe('missing.key')
  })

  it('falls through to the common vocabulary after the namespace misses (production keys)', () => {
    const { svc } = make()
    // The shipped common pair is registered by apply; the bench registers it
    // directly to pin the production chain: ns -> common -> en -> key.
    svc.register('common', 'zh', { retry: '重试' })
    svc.register('common', 'en', { retry: 'Retry' })
    svc.register('ns', 'en', { own: 'Own' })
    const t = svc.bind('ns')
    expect(t('retry')).toBe('重试')
    // zh is active and `ns` has no zh dictionary at all: the en fallback answers.
    expect(t('own')).toBe('Own')
    svc.setLocale('en')
    expect(t('retry')).toBe('Retry')
    expect(t('own')).toBe('Own')
    // common itself must not recurse: a miss inside common echoes the key.
    // (Wide-string ns hits the untyped bind overload — the typed one rejects
    // unknown keys at compile time, which is the point of the typed registry contract.)
    expect(svc.bind('common' as string)('nope')).toBe('nope')
  })

  it('interpolates {name} params and leaves unknown placeholders intact', () => {
    const { svc } = make()
    svc.register('ns', 'zh', { greet: '你好，{name}！第 {n} 次', partial: '{known} 与 {unknown}' })
    const t = svc.bind('ns')
    expect(t('greet', { name: '世界', n: 2 })).toBe('你好，世界！第 2 次')
    expect(t('partial', { known: 'A' })).toBe('A 与 {unknown}')
  })

  it('bind returns a stable per-namespace function identity', () => {
    const { svc } = make()
    expect(svc.bind('a')).toBe(svc.bind('a'))
    expect(svc.bind('a')).not.toBe(svc.bind('b'))
  })

  it('rejects duplicate (ns, locale) and disposer only removes its own dict', () => {
    const { svc } = make()
    const dispose = svc.register('ns', 'zh', { k: 'v1' })
    expect(() => svc.register('ns', 'zh', { k: 'v2' })).toThrow('already has locale')
    dispose()
    const t = svc.bind('ns')
    expect(t('k')).toBe('k')
    svc.register('ns', 'zh', { k: 'v2' })
    expect(t('k')).toBe('v2')
    dispose()
    expect(t('k')).toBe('v2')
  })

  it('serves the LocaleFace: snapshot revision moves on switch and registration, subscribers fire, unsubscribe stops them', () => {
    const { svc } = make()
    const seen: number[] = []
    const off = svc.subscribe(() => { seen.push(svc.getSnapshot().revision) })
    expect(svc.getSnapshot()).toBe(svc.getLocale())
    const r0 = svc.getSnapshot().revision
    svc.register('ns', 'zh', { k: 'v' })
    expect(svc.getSnapshot().revision).toBe(r0 + 1)
    svc.setLocale('en')
    expect(seen).toEqual([r0 + 1, r0 + 2])
    off()
    svc.setLocale('zh')
    expect(seen).toHaveLength(2)
  })

  it('isolates a throwing subscriber: the rest still see the new revision', () => {
    const { svc } = make()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const seen: number[] = []
      svc.subscribe(() => { throw new Error('boom') })
      svc.subscribe(() => { seen.push(svc.getSnapshot().revision) })
      svc.setLocale('en')
      expect(seen).toEqual([1])
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })

  it('register disposer republishes (mounted outlets drop the dead dictionary)', () => {
    const { svc } = make()
    const dispose = svc.register('ns', 'zh', { k: 'v' })
    const before = svc.getSnapshot().revision
    dispose()
    expect(svc.getSnapshot().revision).toBe(before + 1)
    // Second run hits the idempotent arm: nothing removed, no republish.
    dispose()
    expect(svc.getSnapshot().revision).toBe(before + 1)
  })

  it('setLocale writes through the scope and republishes only on a real change', () => {
    const host = stubSettingsScope<LocaleSettings>()
    const { svc, events } = make(host)
    svc.setLocale('en')
    expect(svc.getLocale().active).toBe('en')
    expect(host.set).toHaveBeenCalledWith('preference', 'en')
    expect(events).toHaveLength(1)
    expect(events[0]).toBe(svc.getLocale())
    expect(events[0]!.revision).toBe(1)
    // 重选当前语言不通知订阅者，但仍要把可能尚未保存的默认值写成显式偏好。
    svc.setLocale('en')
    expect(events).toHaveLength(1)
    expect(host.set).toHaveBeenCalledTimes(2)
    expect(host.set).toHaveBeenLastCalledWith('preference', 'en')
  })

  it('选择与默认值相同的中文也会持久化为显式偏好', () => {
    // 即使选中的仍是默认中文，也必须写入 Host，供其他浏览器沿用显式选择。
    stubLanguages('en-US')
    const host = stubSettingsScope<LocaleSettings>()
    const { svc } = make(host)
    expect(svc.getLocale().active).toBe('zh')
    expect(host.set).not.toHaveBeenCalled()
    svc.setLocale('zh')
    expect(host.set).toHaveBeenCalledWith('preference', 'zh')
  })

  it('setLocale without a host scope stays process-local', () => {
    const { svc, events } = make()
    svc.setLocale('en')
    expect(svc.getLocale().active).toBe('en')
    expect(events).toHaveLength(1)
  })

  it('throws on unknown locale ids', () => {
    const { svc } = make()
    expect(() => { svc.setLocale('fr') }).toThrow('not registered')
  })

  it('采用 Host 的英文偏好覆盖中文默认值且不回写', () => {
    const host = stubSettingsScope<LocaleSettings>()
    const { svc, events } = make(host)
    host.publish({ status: 'ready', value: { preference: 'en' }, revision: 1, writable: true })
    expect(svc.getLocale().active).toBe('en')
    expect(events).toHaveLength(1)
    expect(host.set).not.toHaveBeenCalled()
    host.publish({ value: { preference: 'en' }, revision: 2 })
    expect(events).toHaveLength(1)
  })

  it('Host 偏好被清除后回到中文默认值', () => {
    const host = stubSettingsScope<LocaleSettings>()
    const { svc } = make(host)
    host.publish({ status: 'ready', value: { preference: 'en' }, revision: 1, writable: true })
    expect(svc.getLocale().active).toBe('en')
    host.publish({ value: {}, revision: 2 })
    expect(svc.getLocale().active).toBe('zh')
  })

  it('adopts a section already standing at construction and releases its subscription on dispose', async () => {
    const host = stubSettingsScope<LocaleSettings>()
    host.publish({ status: 'ready', value: { preference: 'en' }, revision: 1, writable: true })
    const { ctx, svc } = make(host)
    expect(svc.getLocale().active).toBe('en')
    expect(host.listenerCount()).toBe(1)
    await ctx.fiber.dispose()
    expect(host.listenerCount()).toBe(0)
  })

  it('没有 Host 偏好时始终以中文启动，不读取浏览器语言', () => {
    stubLanguages('en-GB', 'zh-CN')
    expect(make().svc.getLocale().active).toBe('zh')
    stubLanguages('zh-Hant-TW')
    expect(make().svc.getLocale().active).toBe('zh')
    // 即使浏览器首选英文或其他未提供的语言，默认值也不改变。
    stubLanguages('fr-FR', 'en-US')
    expect(make().svc.getLocale().active).toBe('zh')
    vi.stubGlobal('navigator', { languages: [], language: 'en-US' })
    expect(make().svc.getLocale().active).toBe('zh')
    vi.stubGlobal('navigator', { language: 'en-US' })
    expect(make().svc.getLocale().active).toBe('zh')
  })

  it('非浏览器运行也以中文启动，不读取 Node 的 navigator', () => {
    vi.stubGlobal('window', undefined)
    stubLanguages('en-US')
    const { svc } = make()
    expect(svc.getLocale().active).toBe('zh')
    svc.setLocale('en')
    expect(svc.getLocale().active).toBe('en')
  })

  it('显式进程内选择仍可覆盖中文默认值', () => {
    stubLanguages('en-US')
    const { svc } = make()
    svc.setLocale('en')
    expect(svc.getLocale().active).toBe('en')
  })

  it('中文默认界面缺词时仍由英文字典兜底', () => {
    expect(FALLBACK_LOCALE).toBe('en')
    vi.stubGlobal('window', undefined)
    const { svc } = make()
    expect(svc.getLocale().active).toBe('zh')
    // 中文缺词时使用英文；反向缺词仍显示键名，不静默改变字典优先级。
    svc.register('ns', 'zh', {})
    svc.register('ns', 'en', { onlyEn: 'English only' })
    expect(svc.bind('ns')('onlyEn')).toBe('English only')
    svc.register('ns2', 'zh', { onlyZh: '仅中文' })
    svc.register('ns2', 'en', {})
    svc.setLocale('en')
    expect(svc.bind('ns2')('onlyZh')).toBe('onlyZh')
  })

  it('exposes the two shipped locales with self-described labels', () => {
    const { svc } = make()
    expect(svc.getLocale().locales).toEqual([
      { id: 'zh', label: '中文' },
      { id: 'en', label: 'English' },
    ])
  })
})
