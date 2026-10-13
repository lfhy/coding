import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { llmBuildIdentity } from './llm-build-identity.ts'

const root = resolve(import.meta.dirname, '..')

describe('llmBuildIdentity', () => {
  it('pins UTC build date and the first six digits of the repository HEAD', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    expect(llmBuildIdentity(root, new Date('2026-10-14T00:00:00.000Z'))).toEqual({
      date: '2026.1014', commit: head.slice(0, 6),
    })
    expect(llmBuildIdentity(root, new Date('2026-10-13T23:59:59.000Z')).date).toBe('2026.1013')
  })

  it('rejects an invalid build clock', () => {
    expect(() => llmBuildIdentity(root, new Date(Number.NaN))).toThrow('valid build time')
  })
})
