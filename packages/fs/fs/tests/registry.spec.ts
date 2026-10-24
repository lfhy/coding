import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { FsRegistry } from '../src/index.ts'
import type { FsProvider } from '../src/index.ts'
import { FsError, FsTargetKey, FsVersion } from '../src/types.ts'
import type { FsDirEntry, FsTarget } from '../src/types.ts'

/** 最小后端：target key 带自己的前缀，记录被调用的原语。 */
function backend(id: string, prefix: string, options: { matches?: (cwd: string) => boolean } = {}): FsProvider & { calls: string[] } {
  const calls: string[] = []
  const target = (path: string): FsTarget => ({
    targetKey: FsTargetKey(`${prefix}:${path}`),
    displayPath: `${id}://${path}`,
  })
  return {
    id,
    calls,
    sandboxMode: undefined,
    matches: (cwd: string) => options.matches?.(cwd) ?? false,
    owns: (targetKey: string) => targetKey.startsWith(`${prefix}:`),
    async resolve(path: string) {
      calls.push(`resolve:${path}`)
      return target(path)
    },
    processPath: (value: FsTarget) => `${id}:${String(value.targetKey)}`,
    fileUrl: (value: FsTarget) => `file://${id}/${String(value.targetKey)}`,
    contains: (parent: FsTarget, child: FsTarget) => String(child.targetKey).startsWith(String(parent.targetKey)),
    async stat() {
      calls.push('stat')
      return undefined
    },
    async lstat() {
      calls.push('lstat')
      return undefined
    },
    async readText() {
      calls.push('readText')
      return id
    },
    async streamText() {
      calls.push('streamText')
      return (async function* () {})()
    },
    async readBytes() {
      calls.push('readBytes')
      return new Uint8Array()
    },
    async listDir() {
      calls.push('listDir')
      return [] as FsDirEntry[]
    },
    async writeText(value: FsTarget) {
      calls.push('writeText')
      return { operation: 'update' as const, version: FsVersion('v2'), before: '', after: String(value.targetKey) }
    },
    async editText() {
      calls.push('editText')
      return { version: FsVersion('v3'), before: '', after: '' }
    },
  }
}

describe('FsRegistry', () => {
  it('按工作区绑定选择后端，没有绑定时用 matches，最后回退最近注册的后端', async () => {
    const ctx = new Context()
    const registry = new FsRegistry(ctx)
    const local = backend('local', 'local', { matches: () => true })
    const remote = backend('remote', 'remote', { matches: cwd => cwd.includes('remote-workspaces') })
    const disposeLocal = registry.register(local, { fallback: true })
    registry.register(remote)
    expect(registry.backends).toEqual(['local', 'remote'])

    // 远端工作区按 matches 选中远端后端。
    const remoteTarget = await registry.resolve('file.ts', { cwd: '/home/me/.coding/remote-workspaces/aa/proj-bb' })
    expect(remoteTarget.displayPath).toBe('remote://file.ts')
    expect(remote.calls).toEqual(['resolve:file.ts'])

    // 显式绑定优先于 matches：同一目录也可以绑定到本地后端。
    const unbind = registry.bind('/home/me/.coding/remote-workspaces/aa/proj-bb', 'local')
    await registry.resolve('file.ts', { cwd: '/home/me/.coding/remote-workspaces/aa/proj-bb' })
    expect(local.calls).toEqual(['resolve:file.ts'])
    unbind()

    // 没有 cwd 时使用显式标记的本地回退后端。
    const fallback = await registry.resolve('other.ts')
    expect(fallback.displayPath).toBe('local://other.ts')

    disposeLocal()
    expect(registry.backends).toEqual(['remote'])
  })

  it('同步原语按 target key 找回后端，不做 I/O', () => {
    const ctx = new Context()
    const registry = new FsRegistry(ctx)
    const local = backend('local', 'local')
    const remote = backend('remote', 'remote')
    registry.register(local)
    registry.register(remote)
    const target = { targetKey: FsTargetKey('remote:/srv/app.ts'), displayPath: '/srv/app.ts' }
    expect(registry.processPath(target)).toBe('remote:remote:/srv/app.ts')
    expect(registry.fileUrl(target)).toBe('file://remote/remote:/srv/app.ts')
    expect(registry.contains(target, target)).toBe(true)
    expect(local.calls).toEqual([])
    expect(remote.calls).toEqual([])
  })

  it('部署级沙箱模式取第一个声明了模式的后端', async () => {
    const ctx = new Context()
    const registry = new FsRegistry(ctx)
    const plain = backend('local', 'local')
    const fenced = { ...backend('fenced', 'fenced'), sandboxMode: 'workspace-write' as const }
    registry.register(fenced)
    registry.register(plain)
    expect(registry.sandboxMode).toBe('workspace-write')
  })

  it('拒绝重复 id、重复回退与未注册的绑定，并在没有后端时报错', async () => {
    const ctx = new Context()
    const registry = new FsRegistry(ctx)
    expect(() => registry.bind('/w', 'local')).toThrow(FsError)
    await expect(registry.resolve('a.ts')).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    registry.register(backend('local', 'local'), { fallback: true })
    expect(() => registry.register(backend('local', 'local2'))).toThrow(/already registered/u)
    expect(() => registry.register(backend('other', 'other'), { fallback: true })).toThrow(/already marked as the fallback/u)
    expect(() => registry.bind('/w', 'remote')).toThrow(/not registered/u)
  })
})
