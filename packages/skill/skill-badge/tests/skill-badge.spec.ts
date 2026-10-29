import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { FsRegistry } from 'coding-fs'
import { describe, expect, it } from 'vitest'
import SkillRegistry from 'coding-skill'
import * as SkillBadge from 'coding-skill-badge'

describe('dsh-skill-badge', () => {
  it('registers and disposes the bundled badge skill', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    // 内置技能的展示路径是虚拟前缀，插件挂载时把它注册到文件系统。
    await ctx.plugin(FsRegistry)
    const fiber = await ctx.plugin(SkillBadge)
    const resourcePrefix = '${INTERNAL_SKILL_DIR}/coding-skill-badge'

    expect(await ctx.skills.list()).toEqual([{
      name: 'dsh-badge',
      description: 'Add the official “powered by dsh” badge to documents, pull requests, merge requests, and other content produced with DeepSeek Harness. Use whenever creating a pull request or merge request. Also use when the user asks for a dsh badge, powered-by-dsh attribution, or a reusable dsh badge asset or snippet.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-badge',
      source: 'bundled',
      resourceBase: { kind: 'alias', path: resourcePrefix },
    }])
    expect(ctx.fs.pathAliasPrefixes).toEqual([resourcePrefix])
    const loaded = await ctx.skills.get('dsh-badge')
    expect(loaded?.content).toContain('Preserve the badge\'s 121×20 dimensions')
    expect(loaded?.resourceBase).toEqual({ kind: 'alias', path: resourcePrefix })

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('ships the official 726×120 PNG unchanged', async () => {
    const image = await readFile(new URL('../assets/dsh-badge.png', import.meta.url))
    expect(image.readUInt32BE(16)).toBe(726)
    expect(image.readUInt32BE(20)).toBe(120)
    expect(createHash('sha256').update(image).digest('hex')).toBe(
      'f2c4f5ec9cbe847c0c763545c4d839efa8485bc74203733d0a0e8259f233c653',
    )
  })
})
