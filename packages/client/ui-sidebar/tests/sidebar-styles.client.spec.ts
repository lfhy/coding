/** 侧边栏壳层与它持有控件的样式契约。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SidebarRoot.module.css', import.meta.url)), 'utf8')
const root = readFileSync(fileURLToPath(new URL('../src/client/SidebarRoot.tsx', import.meta.url)), 'utf8')

/**
 * 取某条精确选择器的声明表。
 * @param selector - 选择器原文。
 * @returns 归一化后的声明；选择器不存在时为 undefined。
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

describe('SidebarRoot.module.css', () => {
  it('drags safe titlebar gaps but keeps traffic lights and row controls clear', () => {
    expect(root).toContain('<div className={css.windowDragInset} data-window-drag-inset data-window-drag-region aria-hidden="true" />')
    expect(root).toContain('<div className={css.logoRow} data-window-drag-region>')
    expect(declarations('.windowDragInset')?.get('left')).toBe('90px')
    expect(declarations('.windowDragInset')?.get('height')).toBe('var(--app-safe-area-inset-top, 0px)')
    expect(declarations('.windowDragInset')?.get('-webkit-app-region')).toBe('no-drag')
    expect(declarations('.collapsed .windowDragInset')?.get('display')).toBe('none')
    expect(declarations('.logoRow')?.get('-webkit-app-region')).toBe('no-drag')
    expect(css).toMatch(/\.logoRow :is\(button, a, input, select, textarea, \[role='button'\]\)\s*\{\s*-webkit-app-region: no-drag;/)
  })

  it('keeps the safe area and footer edge geometry structural', () => {
    const root = declarations('.root')
    expect(root?.get('--dsh-sidebar-inline-padding')).toBe('12px')
    expect(root?.get('padding')).toBe(
      'calc(6px + var(--app-safe-area-inset-top, 0px)) var(--dsh-sidebar-inline-padding) 0',
    )
    expect(declarations('.root.collapsed')?.get('padding')).toBe(
      'calc(28px + var(--app-safe-area-inset-top, 0px)) 10px 0',
    )
    expect(declarations('.regionArea')?.get('margin-left')).toBe('-4px')
    expect(declarations('.regionArea')?.get('padding-left')).toBe('4px')
    expect(declarations('.regionArea')?.get('margin-right')).toBe(
      'calc(-1 * var(--dsh-sidebar-inline-padding))',
    )
    expect(declarations('.collapsed .regionArea')?.get('margin-left')).toBe('0')
    expect(declarations('.collapsed .regionArea')?.get('padding-left')).toBe('0')
    expect(declarations('.collapsed .regionArea')?.get('margin-right')).toBe('0')
    expect(declarations('.footArea')?.get('margin-top')).toBe('auto')
  })

  it('moves the top entry seats and the region while the footer only fades', () => {
    const animation = 'rail-in 150ms var(--ds-ease-in-out) backwards'
    for (const selector of [
      '.railIn .iconButton',
      '.railIn .newSession',
      ".railIn [data-slot='sidebar.top.entry'] button",
      '.railIn .settingsArea',
      '.railIn .regionArea',
    ]) {
      expect(declarations(selector)?.get('animation')).toBe(animation)
    }
    expect(declarations('.railIn .footArea')?.get('animation')).toBe(
      'rail-fade-in 150ms var(--ds-ease-in-out) backwards',
    )
    expect(css).toMatch(
      /@keyframes rail-in\s*\{\s*from\s*\{\s*opacity: 0;\s*transform: translateX\(49px\);\s*}\s*}/,
    )
    expect(css).toMatch(/@keyframes rail-fade-in\s*\{\s*from\s*\{\s*opacity: 0;\s*}\s*}/)
    expect(declarations(".fading [data-slot='sidebar.top.entry'] button")?.get('opacity')).toBe('0')
  })

  it('gives shell rail controls the same base anchor for their shared translation', () => {
    expect(declarations('.collapsed .logoRow')?.get('justify-content')).toBe('flex-start')
    expect(declarations('.collapsed .logoRow')?.get('align-items')).toBe('flex-start')
    expect(declarations('.collapsed .newSession')?.get('align-self')).toBe('flex-start')
    expect(declarations('.collapsed .newSession')?.get('width')).toBe('36px')
  })

  it('leaves no wrapper space for an unavailable entry, and places the rail toggle after it', () => {
    expect(root).toContain("{renderSlot('sidebar.top.entry', { wide })}")
    expect(root).not.toContain('brandActions')
    expect(declarations('.toggleArea')?.get('margin-top')).toBe('12px')
    expect(declarations('.collapsed .settingsArea')?.get('margin-top')).toBe('12px')
  })

  it('gives the New chat entry the same row geometry as the settings entry', () => {
    expect(declarations('.logoRow')?.get('height')).toBe('42px')
    expect(declarations('.newSession')?.get('height')).toBe('42px')
    expect(declarations('.newSession')?.get('flex')).toBe('1')
    expect(declarations('.newSession')?.get('border-radius')).toBe('12px')
    expect(declarations('.newSession')?.get('border')).toBe('none')
    expect(declarations('.newSession')?.get('background')).toBe('transparent')
    expect(declarations('.newSession')?.get('padding')).toBe('0 10px 0 8px')
    expect(declarations('.collapsed .newSession')?.get('flex')).toBe('none')
    expect(declarations('.newSessionLabel')?.get('text-overflow')).toBe('ellipsis')
    // 图标贴左，文案紧接图标占满剩余空间（按钮默认居中文字，这里显式左对齐）。
    expect(declarations('.newSessionLabel')?.get('flex')).toBe('1')
    expect(declarations('.newSessionLabel')?.get('text-align')).toBe('start')
  })

  it('keeps the settings seat under the New chat entry above the entry divider', () => {
    expect(declarations('.settingsArea')?.get('width')).toBe('100%')
    expect(declarations('.settingsArea')?.get('margin-top')).toBe('2px')
    expect(declarations('.topDivider')?.get('height')).toBe('1px')
    expect(declarations('.topDivider')?.get('margin')).toBe('8px 0')
    expect(declarations('.topDivider')?.get('background')).toBe('var(--dsw-alias-border-l2)')
    expect(declarations('.collapsed .topDivider')?.get('width')).toBe('30px')
    expect(declarations('.collapsed .topDivider')?.get('margin')).toBe('10px auto')
    // 顶部入口区与浏览区域之间是分隔线，设置座位不再出现在页脚里。
    const settings = root.indexOf("renderSlot('sidebar.settings'")
    expect(settings).toBeGreaterThan(root.indexOf('css.logoRow'))
    expect(settings).toBeLessThan(root.indexOf('css.topDivider'))
    expect(settings).toBeLessThan(root.indexOf("renderSlot('sidebar.workspaces'"))
    expect(root.slice(root.indexOf('css.footArea'))).not.toContain("renderSlot('sidebar.settings'")
  })
})
