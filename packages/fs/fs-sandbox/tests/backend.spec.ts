import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { FsTargetKey, FsVersion } from 'coding-fs'
import type { FsProvider, FsTarget } from 'coding-fs'
import type { SandboxExecutionPolicy } from 'coding-sandbox'
import { SandboxedBackend } from '../src/index.ts'

/** 只记录被调用原语的本地形状后端；targetKey 就是绝对路径。 */
function provider(): FsProvider & { writes: string[]; edits: string[] } {
  const writes: string[] = []
  const edits: string[] = []
  return {
    id: 'local',
    writes,
    edits,
    sandboxMode: undefined,
    matches: () => true,
    owns: () => true,
    async resolve(path: string) {
      return { targetKey: FsTargetKey(path), displayPath: path }
    },
    processPath: target => String(target.targetKey),
    fileUrl: target => `file://${String(target.targetKey)}`,
    contains: (parent, child) => String(child.targetKey).startsWith(String(parent.targetKey)),
    async stat() { return undefined },
    async lstat() { return undefined },
    async readText() { return 'content' },
    async streamText() { return (async function* () {})() },
    async readBytes() { return new Uint8Array() },
    async listDir() { return [] },
    async writeText(target) {
      writes.push(String(target.targetKey))
      return { operation: 'update' as const, version: FsVersion('v2'), before: '', after: '' }
    },
    async editText(target) {
      edits.push(String(target.targetKey))
      return { version: FsVersion('v3'), before: '', after: '' }
    },
  }
}

function contextWithPolicy(mode: SandboxExecutionPolicy['mode'], workspaceRoot = '/work'): Context {
  const ctx = new Context()
  ctx.reflect.provide('sandboxPolicy', {
    defaultMode: mode,
    workspaceRoot,
    resolve: (): SandboxExecutionPolicy => ({ mode, workspaceRoot }),
  })
  return ctx
}

const target = (path: string): FsTarget => ({ targetKey: FsTargetKey(path), displayPath: path })

describe('SandboxedBackend', () => {
  it('read-only 拒绝变更，读取照常委托', async () => {
    const ctx = contextWithPolicy('read-only')
    const inner = provider()
    const backend = new SandboxedBackend(ctx, inner)
    await expect(backend.writeText(target('/work/a.ts'), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(backend.editText(target('/work/a.ts'), { oldString: 'a', newString: 'b', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(backend.readText(target('/work/a.ts'))).resolves.toBe('content')
    expect(inner.writes).toEqual([])
    expect(inner.edits).toEqual([])
  })

  it('danger-full-access 直接委托，并沿用后端身份', async () => {
    const ctx = contextWithPolicy('danger-full-access')
    const inner = provider()
    const backend = new SandboxedBackend(ctx, inner)
    expect(backend.id).toBe('local')
    expect(backend.matches('/anywhere')).toBe(true)
    expect(backend.owns('/anywhere')).toBe(true)
    expect(backend.sandboxMode).toBe('danger-full-access')
    await expect(backend.writeText(target('/etc/hosts'), 'x')).resolves.toMatchObject({ version: 'v2' })
    expect(inner.writes).toEqual(['/etc/hosts'])
  })

  it('workspace-write 只放行工作区根内的变更', async () => {
    const ctx = contextWithPolicy('workspace-write', '/work')
    const inner = provider()
    const backend = new SandboxedBackend(ctx, inner)
    await expect(backend.writeText(target('/work/a.ts'), 'x')).resolves.toBeDefined()
    expect(inner.writes).toEqual(['/work/a.ts'])
    await expect(backend.writeText(target('/etc/hosts'), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(inner.writes).toEqual(['/work/a.ts'])
  })

  it('委托全部读取原语', async () => {
    const ctx = contextWithPolicy('workspace-write')
    const inner = provider()
    const stat = vi.spyOn(inner, 'stat')
    const backend = new SandboxedBackend(ctx, inner)
    await backend.stat(target('/work/a.ts'))
    await backend.lstat('/work/a.ts')
    await backend.listDir(target('/work'))
    await backend.readBytes(target('/work/a.ts'), undefined, 4)
    await backend.streamText(target('/work/a.ts'))
    expect(stat).toHaveBeenCalledOnce()
  })
})
