import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// 此处刻意省略后缀：只有解析目录入口，才能检测 .js 对同名 .ts 的遮蔽。
import { sourceKind } from './fixtures/vitest-resolution'

describe('Vitest source resolution', () => {
  it('keeps TypeScript before JavaScript in both isolated projects', () => {
    // 只读配置源码，避免将根配置和其共享模块引入 Host aggregate 的编译边界。
    const config = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8')
    const projectPattern = new RegExp([
      /\{\s*plugins:\s*\[pathsPlugin\(\),\s*standardDecoratorPlugin\(\)\],/.source,
      /\s*resolve:\s*\{\s*extensions:\s*resolveExtensions\s*\},/.source,
      /\s*test:\s*\{\s*name:\s*'([^']+)'/.source,
    ].join(''), 'gu')
    const configuredProjects = [...config.matchAll(projectPattern)].map(match => match[1])
    expect(configuredProjects).toEqual(['thread-safe', 'process-bound'])
  })

  it('loads index.ts when index.js exists beside it', () => {
    expect(sourceKind).toBe('typescript-source')
  })
})
