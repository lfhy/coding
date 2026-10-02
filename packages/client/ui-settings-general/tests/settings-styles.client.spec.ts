import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SettingsRoot.module.css', import.meta.url)), 'utf8')

/**
 * 读取设置页面样式表中精确选择器的声明。
 * @param selector - 要检查的 CSS 选择器。
 * @param source - 样式表或限定媒体查询内的样式。
 * @returns 选择器的声明；找不到时返回 undefined。
 */
function declarations(selector: string, source = css): Map<string, string> | undefined {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

describe('SettingsRoot.module.css', () => {
  it('keeps the settings trigger within the sidebar', () => {
    expect(declarations('.trigger')?.get('margin')).toBe('4px -2px 0')
    expect(declarations('.trigger.rail')?.get('margin')).toBe('8px 0 0')
  })

  it('occupies the full viewport without a mask or floating modal frame', () => {
    expect(declarations('.page')?.get('position')).toBe('fixed')
    expect(declarations('.page')?.get('inset')).toBe('0')
    expect(declarations('.page')?.get('background')).toBe('var(--dsw-alias-bg-base)')
    expect(declarations('.panel')?.get('width')).toBe('100%')
    expect(declarations('.panel')?.get('height')).toBe('100%')
    expect(declarations('.panel')?.has('box-shadow')).toBe(false)
    expect(declarations('.mask')).toBeUndefined()
    expect(declarations('.overlay')).toBeUndefined()
    expect(declarations('.back')?.get('cursor')).toBe('pointer')
    expect(declarations('.back:focus-visible')?.get('outline')).toContain('2px solid')
  })

  it('keeps navigation and ordinary content independently scrollable', () => {
    expect(declarations('.nav')?.get('width')).toBe('250px')
    expect(declarations('.navList')?.get('overflow-y')).toBe('auto')
    expect(declarations('.options')?.get('overflow-y')).toBe('auto')
    expect(declarations('.modelsPanel .options')?.get('overflow')).toBe('hidden')
  })

  it('puts navigation above scrollable content on narrow screens', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 620px)'))
    expect(declarations('.panel', narrow)?.get('flex-direction')).toBe('column')
    expect(declarations('.nav', narrow)?.get('width')).toBe('100%')
    expect(declarations('.navList', narrow)?.get('flex-direction')).toBe('row')
    expect(declarations('.navList', narrow)?.get('overflow-x')).toBe('auto')
    expect(declarations('.navList', narrow)?.get('overflow-y')).toBe('hidden')
  })
})
