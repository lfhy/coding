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
})
