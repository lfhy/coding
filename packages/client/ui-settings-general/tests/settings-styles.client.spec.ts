import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SettingsRoot.module.css', import.meta.url)), 'utf8')

/**
 * 读取设置外壳样式表中一个精确选择器的声明。
 * @param selector - 要检查的 CSS 选择器。
 * @returns 选择器的声明；找不到时返回 undefined。
 */
function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
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

  it('keeps the ordinary panel viewport-bound and gives Models a three-column frame', () => {
    expect(declarations('.overlay')?.get('position')).toBe('fixed')
    expect(declarations('.overlay')?.get('inset')).toBe('0')
    expect(declarations('.panel')?.get('width')).toBe('800px')
    expect(declarations('.panel')?.get('height')).toBe('min(800px, calc(100vh - 48px))')
    expect(declarations('.panel')?.get('max-width')).toBe('calc(100vw - 48px)')
    expect(declarations('.options')?.get('overflow-y')).toBe('auto')
    expect(declarations('.modelsPanel')?.get('width')).toBe('min(1380px, calc(100vw - 48px))')
    expect(declarations('.modelsPanel')?.get('height')).toBe('min(936px, calc(100vh - 48px))')
    expect(declarations('.modelsPanel .nav')?.get('width')).toBe('250px')
    expect(declarations('.modelsPanel .nav')?.has('display')).toBe(false)
    expect(declarations('.modelsPanel .options')?.get('padding')).toBe('0')
    expect(declarations('.modelsPanel .options')?.get('overflow')).toBe('hidden')
  })

  it('puts model and image-recognition navigation above their content on narrow screens', () => {
    expect(css).toMatch(/@media \(max-width: 620px\) \{[\s\S]*?\.modelsPanel,\s*\.visionPanel \{\s*flex-direction: column;/)
    expect(css).toMatch(/\.modelsPanel \.nav,\s*\.visionPanel \.nav \{\s*width: 100%;/)
    expect(css).toMatch(/\.modelsPanel \.navList,\s*\.visionPanel \.navList \{\s*flex-direction: row;\s*overflow-x: auto;/)
    expect(css).toMatch(/\.modelsPanel \.navCell,\s*\.visionPanel \.navCell \{\s*flex: none;/)
  })
})
