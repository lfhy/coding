/**
 * 虚拟路径前缀（`registerPathAlias`）的契约：注册、最长前缀匹配、计数合并、
 * 冲突拒绝与撤销，以及分派时「后端拿到真实路径、调用方拿到虚拟路径」的分工。
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { FsRegistry } from '../src/index.ts'
import type { FsProvider } from '../src/index.ts'
import { FsError, FsTargetKey, FsVersion } from '../src/types.ts'
import type { FsDirEntry, FsTarget } from '../src/types.ts'

/** 记录 resolve 收到的路径；target key 直接编码真实路径，展示路径固定成后端自己的形式。 */
function recordingBackend(id: string): RecordingBackend {
  const resolved: string[] = []
  const lstatted: string[] = []
  return {
    id,
    resolved,
    lstatted,
    sandboxMode: undefined,
    matches: () => false,
    owns: () => true,
    async resolve(path: string) {
      resolved.push(path)
      return { targetKey: FsTargetKey(path), displayPath: `${id}:${path}` } satisfies FsTarget
    },
    processPath: (target: FsTarget) => String(target.targetKey),
    fileUrl: (target: FsTarget) => `file://${String(target.targetKey)}`,
    contains: () => false,
    async stat() { return undefined },
    async lstat(path: string) {
      lstatted.push(path)
      return undefined
    },
    async readText() { return '' },
    async streamText() { return (async function* () {})() },
    async readBytes() { return new Uint8Array() },
    async listDir() { return [] as FsDirEntry[] },
    async writeText() {
      return { operation: 'create' as const, version: FsVersion('v1'), before: null, after: '' }
    },
    async editText() {
      return { version: FsVersion('v2'), before: '', after: '' }
    },
  }
}

/** 记录 resolve/lstat 收到路径的后端。 */
interface RecordingBackend extends FsProvider {
  resolved: string[]
  lstatted: string[]
}

/** 挂载注册表与一个记录型后端。 */
async function boot() {
  const ctx = new Context()
  const fiber = await ctx.plugin(FsRegistry)
  const fs = ctx.fs as FsRegistry
  const backend = recordingBackend('local')
  ctx.effect(() => fs.register(backend, { fallback: true }))
  return { ctx, fs, backend, dispose: async () => { await fiber.dispose() } }
}

describe('filesystem path aliases', () => {
  it('resolves a prefixed path through the owning backend and keeps the display path virtual', async () => {
    const { fs, backend, dispose } = await boot()
    try {
      const stop = fs.registerPathAlias('${INTERNAL_SKILL_DIR}/coding-skill-demo', '/opt/app/assets')
      const target = await fs.resolve('${INTERNAL_SKILL_DIR}/coding-skill-demo/notes/intro.md')
      expect(target.displayPath).toBe('${INTERNAL_SKILL_DIR}/coding-skill-demo/notes/intro.md')
      expect(String(target.targetKey)).toBe('/opt/app/assets/notes/intro.md')
      expect(backend.resolved).toEqual(['/opt/app/assets/notes/intro.md'])
      stop()
    } finally {
      await dispose()
    }
  })

  it('resolves the bare prefix to the registered directory', async () => {
    const { fs, backend, dispose } = await boot()
    try {
      fs.registerPathAlias('${INTERNAL_SKILL_DIR}/demo/', '/opt/app/assets')
      const target = await fs.resolve('${INTERNAL_SKILL_DIR}/demo')
      expect(target.displayPath).toBe('${INTERNAL_SKILL_DIR}/demo')
      expect(backend.resolved).toEqual(['/opt/app/assets'])
    } finally {
      await dispose()
    }
  })

  it('prefers the longest matching prefix', async () => {
    const { fs, backend, dispose } = await boot()
    try {
      fs.registerPathAlias('${INTERNAL_SKILL_DIR}', '/opt/app')
      fs.registerPathAlias('${INTERNAL_SKILL_DIR}/demo', '/opt/app/assets')
      await fs.resolve('${INTERNAL_SKILL_DIR}/demo/a.md')
      await fs.resolve('${INTERNAL_SKILL_DIR}/other/a.md')
      expect(backend.resolved).toEqual(['/opt/app/assets/a.md', '/opt/app/other/a.md'])
    } finally {
      await dispose()
    }
  })

  it('requires a separator boundary so a longer name is not captured', async () => {
    const { fs, dispose } = await boot()
    try {
      fs.registerPathAlias('${INTERNAL_SKILL_DIR}/demo', '/opt/app/assets')
      expect(fs.pathAliasPrefixes).toEqual(['${INTERNAL_SKILL_DIR}/demo'])
      await expect(fs.resolve('${INTERNAL_SKILL_DIR}/demolition/a.md')).resolves.toBeDefined()
    } finally {
      await dispose()
    }
  })

  it('merges duplicate registrations of the same prefix and directory, releasing on the last dispose', async () => {
    const { fs, dispose } = await boot()
    try {
      const first = fs.registerPathAlias('${INTERNAL_SKILL_DIR}/demo', '/opt/app/assets')
      const second = fs.registerPathAlias('${INTERNAL_SKILL_DIR}/demo/', '/opt/app/assets')
      expect(fs.pathAliasPrefixes).toEqual(['${INTERNAL_SKILL_DIR}/demo'])
      first()
      first()
      expect(fs.pathAliasPrefixes).toEqual(['${INTERNAL_SKILL_DIR}/demo'])
      second()
      expect(fs.pathAliasPrefixes).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('rejects a conflicting directory and an empty prefix or directory', async () => {
    const { fs, dispose } = await boot()
    try {
      fs.registerPathAlias('${INTERNAL_SKILL_DIR}/demo', '/opt/app/assets')
      expect(() => fs.registerPathAlias('${INTERNAL_SKILL_DIR}/demo', '/opt/other')).toThrow(FsError)
      expect(() => fs.registerPathAlias('', '/opt/app')).toThrow(FsError)
      expect(() => fs.registerPathAlias('${INTERNAL_SKILL_DIR}/demo', ' ')).toThrow(FsError)
    } finally {
      await dispose()
    }
  })

  it('expands aliases for lstat and leaves unrelated paths untouched', async () => {
    const { fs, backend, dispose } = await boot()
    try {
      fs.registerPathAlias('${INTERNAL_SKILL_DIR}/demo', '/opt/app/assets')
      await fs.lstat('${INTERNAL_SKILL_DIR}/demo/a.md')
      await fs.resolve('/workspace/src/a.ts')
      expect(backend.lstatted).toEqual(['/opt/app/assets/a.md'])
      expect(backend.resolved).toEqual(['/workspace/src/a.ts'])
    } finally {
      await dispose()
    }
  })
})
