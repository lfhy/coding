/** StyleKit 目录快照生成器的字段校验、排序与 JSONL 往返行为。 */

import { describe, expect, it } from 'vitest'
import {
  buildStylekitCatalog,
  parseStylekitCatalog,
  serializeStylekitCatalog,
} from './gen-stylekit-catalog.ts'

/** 构造一条最小可用的上游风格记录；测试只覆盖目录层需要的字段。 */
function upstream(slug: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug,
    name: `名称${slug}`,
    nameEn: `Name ${slug}`,
    category: 'modern',
    styleType: 'visual',
    tags: ['minimal'],
    colors: { primary: '#18181B', secondary: '#ffffff', accent: ['#3B82F6'] },
    keywords: ['关键词'],
    description: '一句话描述',
    // 上游多出的字段（封面、变体等）不进入资产。
    cover: `/styles/${slug}.svg`,
    ...overrides,
  }
}

/** 构造满足最小条目数的上游响应。 */
function payload(count: number, override?: (index: number) => Record<string, unknown>): unknown {
  return { total: count, styles: Array.from({ length: count }, (_, index) => override?.(index) ?? upstream(`style-${String(index).padStart(3, '0')}`)) }
}

describe('stylekit catalog generator', () => {
  it('keeps only catalog fields and sorts entries by slug', () => {
    const entries = buildStylekitCatalog({
      total: 100,
      styles: [...Array.from({ length: 99 }, (_, index) => upstream(`style-${index + 2}`)), upstream('style-1')],
    })
    expect(entries).toHaveLength(100)
    expect(entries[0]?.slug).toBe('style-1')
    expect(entries[0]).toEqual({
      slug: 'style-1',
      name: '名称style-1',
      nameEn: 'Name style-1',
      category: 'modern',
      styleType: 'visual',
      tags: ['minimal'],
      colors: { primary: '#18181b', secondary: '#ffffff', accent: ['#3b82f6'] },
      keywords: ['关键词'],
      description: '一句话描述',
    })
  })

  it('accepts the rgba accent colors the upstream catalog publishes', () => {
    const entries = buildStylekitCatalog({
      total: 100,
      styles: [
        ...Array.from({ length: 99 }, (_, index) => upstream(`style-${index + 1}`)),
        upstream('glass', { colors: { primary: '#ffffff', secondary: '#000000', accent: ['rgba(255, 255, 255, 0.25)'] } }),
      ],
    })
    expect(entries.find(entry => entry.slug === 'glass')?.colors.accent).toEqual(['rgba(255, 255, 255, 0.25)'])
  })

  it('round-trips through JSONL and rejects non-canonical input', () => {
    const entries = buildStylekitCatalog(payload(100))
    const text = serializeStylekitCatalog(entries)
    expect(text.endsWith('}\n')).toBe(true)
    expect(parseStylekitCatalog(text)).toEqual(entries)
    expect(() => parseStylekitCatalog(`${text}\n`)).toThrow(/blank line at 101/)
    expect(() => parseStylekitCatalog([...entries].reverse().map(entry => `${JSON.stringify(entry)}\n`).join('')))
      .toThrow(/not sorted by slug/)
  })

  it('fails loudly on duplicate slugs, unsupported colors, and truncated catalogs', () => {
    expect(() => buildStylekitCatalog({ total: 100, styles: [...Array.from({ length: 99 }, (_, index) => upstream(`style-${index}`)), upstream('style-0')] }))
      .toThrow(/duplicate slug "style-0"/)
    expect(() => buildStylekitCatalog({ total: 100, styles: [...Array.from({ length: 99 }, (_, index) => upstream(`style-${index}`)), upstream('odd', { colors: { primary: 'black', secondary: '#ffffff', accent: ['#000000'] } })] }))
      .toThrow(/colors.primary must be a #rrggbb or rgb\(\)\/hsl\(\) color/)
    expect(() => buildStylekitCatalog(payload(99))).toThrow(/expected at least 100/)
    expect(() => buildStylekitCatalog({})).toThrow(/must be an object with a styles array/)
  })
})
