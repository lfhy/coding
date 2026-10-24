import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsTargetKey } from 'coding-fs'
import type { FsRegistry } from 'coding-fs'
import { remoteWorkspaceTargetKey } from 'coding-subprocess'
import SandboxPolicyService from 'coding-sandbox-policy'
import { FsWorkspace } from '../src/index.ts'

describe('FsWorkspace 装配', () => {
  it('把沙箱化的本地后端与 Remote-SSH 后端注册到同一个 ctx.fs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coding-fs-workspace-'))
    await writeFile(join(directory, 'a.txt'), 'hello')
    const ctx = new Context()
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: directory })
    await ctx.plugin(FsWorkspace, { cwd: directory })
    try {
      const fs = ctx.fs as FsRegistry
      expect(fs.backends).toEqual(['local', 'remote-workspace'])
      // 部署级沙箱模式来自包了围栏的本地后端。
      expect(fs.sandboxMode).toBe('workspace-write')
      // 本地读取照常分派到本地后端。
      const target = await fs.resolve('a.txt', { cwd: directory })
      expect(await fs.readText(target)).toBe('hello')
      // 远端目标按 target key 前缀同步分派，不需要 bridge 连接。
      const remoteKey = remoteWorkspaceTargetKey({
        markerRoot: directory, remoteRoot: '/srv/project', remotePath: '/srv/project/a.ts',
        connectionId: 'connection-1', markerGeneration: 1, mode: 'basic',
      })
      expect(fs.processPath({ targetKey: FsTargetKey(remoteKey), displayPath: '/srv/project/a.ts' }))
        .toBe('/srv/project/a.ts')
      expect(fs.fileUrl({ targetKey: FsTargetKey(remoteKey), displayPath: '/srv/project/a.ts' }))
        .toBe('file:///srv/project/a.ts')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('没有显式绑定时按 matches 选择后端，未知工作区回退本地', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coding-fs-workspace-'))
    await writeFile(join(directory, 'b.txt'), 'fallback')
    const ctx = new Context()
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: directory })
    await ctx.plugin(FsWorkspace, { cwd: directory })
    try {
      const fs = ctx.fs as FsRegistry
      const target = await fs.resolve('b.txt', { cwd: join(directory, 'nested') })
      expect(fs.processPath(target)).toBe(join(await realpath(directory), 'nested', 'b.txt'))
      expect(fs.sandboxMode).toBe('danger-full-access')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
