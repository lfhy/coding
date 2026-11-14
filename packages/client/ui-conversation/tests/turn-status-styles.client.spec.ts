// 活动进度可能很长，布局必须先裁切标签，不能挤掉时钟或形成第二行。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../src/client/chat/TurnStatus.module.css', import.meta.url), 'utf8')

describe('回合状态行样式', () => {
  it('只裁切标签，保留圆环和时钟的完整宽度', () => {
    const root = styles.match(/\.root\s*\{([^}]+)\}/)?.[1]
    const label = styles.match(/\.label\s*\{([^}]+)\}/)?.[1]
    expect(root).toContain('max-width: 100%')
    expect(root).toContain('min-width: 0')
    expect(label).toContain('min-width: 0')
    expect(label).toContain('overflow: hidden')
    expect(label).toContain('text-overflow: ellipsis')
    expect(label).toContain('white-space: nowrap')
    expect(styles.match(/\.clock\s*\{([^}]+)\}/)?.[1]).toContain('flex: none')
    expect(styles.match(/\.spinner\s*\{([^}]+)\}/)?.[1]).toContain('flex: none')
  })

  it('只消费语义主题变量，并保留减少动态效果的静止状态', () => {
    expect(styles).toContain('var(--dsw-alias-state-business-primary)')
    expect(styles).not.toContain('--dsw-static-')
    expect(styles).not.toMatch(/#[\da-f]{3,8}\b|\brgba?\(/i)
    const reduced = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.label\s*\{[^}]*animation: none/)
    expect(reduced).toMatch(/\.spinner\s*\{[^}]*animation: none/)
  })
})
