/**
 * `go-backend` 技能包的注册、加载与卸载契约。
 *
 * 正文断言选的是「会改变行为」的条款：把 context 传下去、错误用 %w 包装、查询用参数占位、
 * 交付前跑 vet 与 test。它们一旦被删，技能就退化成一份目录建议。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry, { renderSkillContent } from 'coding-skill'
import * as SkillGoBackend from 'coding-skill-go-backend'

const bodyUrl = new URL('../assets/go-backend.md', import.meta.url)
const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))
const description = '在写或改 Go 后端代码时使用：按项目已有布局与依赖实现 HTTP、后台任务、数据库访问与测试，涵盖 cmd／internal 分层、context 与并发生命周期、错误包装、参数化查询与迁移，以及 go vet、go test -race 的交付验证。'

describe('bundled go-backend skill', () => {
  it('registers, loads, and unregisters its published instructions', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillGoBackend)
    try {
      expect(await ctx.skills.list()).toEqual([{
        name: 'go-backend',
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'go-backend',
        source: 'bundled',
        resourceBase: { kind: 'directory', path: resourcePath },
      }])
      const loaded = await ctx.skills.get('go-backend')
      if (loaded === undefined) throw new Error('bundled go-backend skill is unavailable')
      expect(loaded.content).toBe(await readFile(bodyUrl, 'utf8'))
      expect(renderSkillContent(loaded)).toContain('<skill_instructions>')
      expect(loaded.content).toContain('context.Context` 是函数第一个参数')
      expect(loaded.content).toContain('fmt.Errorf("...: %w", err)')
      expect(loaded.content).toContain('查询用参数占位')
      expect(loaded.content).toContain('go vet ./...')
      expect(loaded.content).toContain('go test ./...')
      expect(loaded.content).toContain('go test -race')
      // 不存在于当前交付面的约束要显式拒绝，避免技能把「加框架」当默认选项。
      expect(loaded.content).toContain('没被要求就换框架')
    } finally {
      await fiber.dispose()
    }
    expect(await ctx.skills.list()).toEqual([])
  })
})
