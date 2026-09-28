import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SettingsRoot.module.css', import.meta.url)), 'utf8')

/**
 * 读取设置外壳样式表中一个精确选择器的声明。
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
  it('lets the settings trigger finish at the sidebar content edge', () => {
    expect(declarations('.trigger')?.get('margin')).toBe('4px -2px 0')
    expect(declarations('.trigger.rail')?.get('margin')).toBe('8px 0 0')
  })

  it('shares the viewport-bound model-sized frame and navigation across every section', () => {
    expect(declarations('.overlay')?.get('position')).toBe('fixed')
    expect(declarations('.overlay')?.get('inset')).toBe('0')
    expect(declarations('.panel')?.get('width')).toBe('min(1380px, calc(100vw - 48px))')
    expect(declarations('.panel')?.get('height')).toBe('min(936px, calc(100vh - 48px))')
    expect(declarations('.panel')?.get('max-width')).toBe('calc(100vw - 48px)')
    expect(declarations('.options')?.get('overflow-y')).toBe('auto')
    expect(declarations('.nav')?.get('width')).toBe('250px')
    expect(declarations('.navList')?.get('overflow-y')).toBe('auto')
    expect(declarations('.navCell')?.get('flex')).toBe('none')
    expect(declarations('.content')?.get('min-height')).toBe('0')
    expect(declarations('.modelsPanel')).toBeUndefined()
    expect(declarations('.modelsPanel .nav')).toBeUndefined()
    expect(declarations('.modelsPanel .navList')).toBeUndefined()
  })

  it('leaves model content layout and scrolling to the model section', () => {
    expect(declarations('.modelsPanel .options')?.get('padding')).toBe('0')
    expect(declarations('.modelsPanel .options')?.get('overflow')).toBe('hidden')
  })

  it('puts every section navigation above scrollable content on narrow screens', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 620px)'))
    expect(declarations('.panel', narrow)?.get('flex-direction')).toBe('column')
    expect(declarations('.panel', narrow)?.get('width')).toBe('calc(100vw - 24px)')
    expect(declarations('.panel', narrow)?.get('max-width')).toBe('calc(100vw - 24px)')
    expect(declarations('.panel', narrow)?.get('height')).toBe('calc(100vh - 24px)')
    expect(declarations('.nav', narrow)?.get('width')).toBe('100%')
    expect(declarations('.navList', narrow)?.get('flex-direction')).toBe('row')
    expect(declarations('.navList', narrow)?.get('overflow-x')).toBe('auto')
    expect(declarations('.navList', narrow)?.get('overflow-y')).toBe('hidden')
    expect(css).not.toContain('.visionPanel')
  })
})
