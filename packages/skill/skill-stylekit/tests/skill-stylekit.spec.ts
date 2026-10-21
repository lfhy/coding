import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry, { renderSkillContent } from 'coding-skill'
import * as SkillStylekit from 'coding-skill-stylekit'

const bodyUrl = new URL('../assets/stylekit.md', import.meta.url)
const catalogUrl = new URL('../assets/styles.jsonl', import.meta.url)
const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))
const description = '在需要给网页或界面一个具名视觉风格时使用：玻璃拟态、新野兽派、赛博朋克、包豪斯、瑞士网格、便当盒布局、Apple／Stripe／Notion／Linear 风格、日式极简、复古 Y2K 等 StyleKit 风格目录。用来把“做得好看点”落成可执行的配色、设计令牌与 do／don\'t 规则，并在项目现有技术栈内实现；风格指南不覆盖产品行为、无障碍与项目已有组件。'

describe('bundled stylekit skill', () => {
  it('registers and loads its published instructions', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillStylekit)
    try {
      expect(await ctx.skills.list()).toEqual([{
        name: 'stylekit', description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'stylekit', source: 'bundled',
        resourceBase: { kind: 'directory', path: resourcePath },
      }])
      const loaded = await ctx.skills.get('stylekit')
      expect(loaded).toBeDefined()
      if (loaded === undefined) throw new Error('bundled stylekit skill is unavailable')
      expect(loaded.content).toBe(await readFile(bodyUrl, 'utf8'))
      expect(renderSkillContent(loaded)).toContain('<skill_instructions>')
      expect(loaded.content).toContain('styles.jsonl')
      expect(loaded.content).toContain('https://www.stylekit.top/api/styles/<slug>')
      expect(loaded.content).toContain('https://www.stylekit.top/r/<slug>.json')
      expect(loaded.content).toContain('加载 `browser-use` 技能')
      expect(loaded.content).toContain('不要编造规则')
    } finally {
      await fiber.dispose()
    }
    expect(await ctx.skills.list()).toEqual([])
  })

  it('ships a searchable catalog snapshot with unique, ordered slugs', async () => {
    const lines = (await readFile(catalogUrl, 'utf8')).trimEnd().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(100)
    const entries = lines.map(readCatalogEntry)
    for (const entry of entries) {
      expect(entry.slug).toMatch(/^[a-z0-9-]+$/)
      expect(entry.colors.primary).toMatch(/^(#[0-9a-f]{6}|rgba?\()/)
      expect(entry.description.length).toBeGreaterThan(0)
    }
    const slugs = entries.map(entry => entry.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(slugs).toEqual([...slugs].sort((left, right) => left.localeCompare(right)))
    // 技能正文用这些 slug 举例，目录必须始终能解析到它们。
    const named = (await readFile(bodyUrl, 'utf8'))
      .split('\n').find(line => line.includes('用户点名了风格时用精确 `slug`'))
      ?.match(/`[a-z0-9-]+`/g) ?? []
    const examples = named.map(token => token.slice(1, -1)).filter(token => token !== 'slug')
    expect(examples.length).toBeGreaterThanOrEqual(8)
    for (const slug of examples) expect(slugs).toContain(slug)
  })
})

/** 解析一行 JSONL 风格条目；字段缺失即抛错，避免测试对不存在的结构做断言。 */
function readCatalogEntry(line: string): {
  slug: string
  description: string
  colors: { primary: string }
} {
  const value: unknown = JSON.parse(line)
  if (typeof value !== 'object' || value === null) throw new Error(`catalog line is not an object: ${line}`)
  const { slug, description, colors } = value as Record<string, unknown>
  if (typeof slug !== 'string' || typeof description !== 'string') {
    throw new Error(`catalog line lacks string slug/description: ${line}`)
  }
  if (typeof colors !== 'object' || colors === null) throw new Error(`catalog line lacks colors: ${line}`)
  const { primary } = colors as Record<string, unknown>
  if (typeof primary !== 'string') throw new Error(`catalog line lacks colors.primary: ${line}`)
  return { slug, description, colors: { primary } }
}
