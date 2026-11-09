import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

describe('ui-files registration', () => {
  it('向设置槽注册独立只读分区及双语文案', () => {
    type Entry = { id: string; order: number; locale: string; inject: () => { list: unknown } }
    type Dictionaries = { zh: Record<string, string>; en: Record<string, string> }
    const register = vi.fn((_options: Entry, _component: unknown) => () => {})
    const localeRegister = vi.fn((_namespace: string, _dictionaries: Dictionaries) => () => {})
    const ctx = {
      effect: (install: () => unknown) => { install() },
      locale: { register: localeRegister, bind: () => (key: string) => key },
      slots: { inject: (_name: string, install: () => unknown) => { install() }, register },
    }
    apply(ctx as never)
    expect(inject).toEqual(['slots', 'locale'])
    expect(localeRegister.mock.calls[0]?.[0]).toBe('settings.files')
    expect(localeRegister.mock.calls[0]?.[1].zh.nav).toBe('文件管理')
    expect(localeRegister.mock.calls[0]?.[1].en.nav).toBe('Files')
    const entry = register.mock.calls[0]?.[0]
    if (entry === undefined) throw new Error('文件管理分区未注册')
    expect(entry).toMatchObject({ id: 'files', order: 14, locale: 'settings.files' })
    expect(entry.inject().list).toEqual(expect.any(Function))
  })
})
