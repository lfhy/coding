import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import PptProjects from '../src/index.ts'

describe('PPT 工程服务依赖', () => {
  it('等待 WebServer 再注册路由，卸载时撤销注册', async () => {
    expect(PptProjects.inject).toEqual(['sessions', 'webServer', 'connection'])
    const ctx = new Context()
    const paths = new Set<string>()
    try {
      ctx.provide('sessions', { get: () => undefined } as never)
      const fiber = ctx.plugin(PptProjects)
      expect(ctx.get('pptProjects')).toBeUndefined()
      expect(paths.size).toBe(0)

      ctx.provide('webServer', {
        register(route: { path: string }) {
          paths.add(route.path)
          return () => { paths.delete(route.path) }
        },
      } as never)
      expect(ctx.get('pptProjects')).toBeUndefined()
      ctx.provide('connection', { requestRejection: () => undefined } as never)
      await fiber
      expect(ctx.get('pptProjects')).toBeInstanceOf(PptProjects)
      expect([...paths]).toContain('/api/ppt/state')
      expect([...paths]).toContain('/api/ppt/media')

      await fiber.dispose()
      expect(ctx.get('pptProjects')).toBeUndefined()
      expect(paths.size).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
