import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsTargetKey } from 'coding-fs'
import type { FsRegistry } from 'coding-fs'
import { REMOTE_WORKSPACE_MARKER, remoteWorkspaceTargetKey } from 'coding-subprocess'
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
      expect(fs.sandboxMode).toBe('workspace-write')
      const target = await fs.resolve('a.txt', { cwd: directory })
      expect(await fs.readText(target)).toBe('hello')
      // 未携带 cwd 的调用也必须回到本地后端；Remote-SSH 后端不能吞掉宿主默认路径。
      const defaultTarget = await fs.resolve('a.txt')
      expect(await fs.readText(defaultTarget)).toBe('hello')
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

  it('远端后端也受同一份沙箱策略约束', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coding-fs-workspace-'))
    const ctx = new Context()
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: directory })
    await ctx.plugin(FsWorkspace, { cwd: directory })
    try {
      const fs = ctx.fs as FsRegistry
      const remoteKey = remoteWorkspaceTargetKey({
        markerRoot: await realpath(directory), remoteRoot: '/srv/project', remotePath: '/srv/project/source.ts',
        connectionId: 'connection-1', markerGeneration: 1, mode: 'basic',
      })
      const target = { targetKey: FsTargetKey(remoteKey), displayPath: '/srv/project/source.ts' }
      await expect(fs.writeText(target, 'blocked')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(fs.editText(target, { oldString: 'old', newString: 'new', replaceAll: false }))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('workspace-write 只允许当前远端工作区根内的变更', async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), 'coding-fs-workspace-'))
    const allowed = join(markerRoot, 'allowed')
    await mkdir(allowed)
    await writeFile(join(markerRoot, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 3,
      remoteRoot: '/srv/project',
      connectionId: 'connection-1',
      generation: 1,
      mode: 'basic',
    }))
    const ctx = new Context()
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: allowed })
    await ctx.plugin(FsWorkspace, { cwd: markerRoot })
    try {
      const fs = ctx.fs as FsRegistry
      const outside = {
        targetKey: FsTargetKey(remoteWorkspaceTargetKey({
          markerRoot: await realpath(markerRoot), remoteRoot: '/srv/project', remotePath: '/srv/project/outside.ts',
          connectionId: 'connection-1', markerGeneration: 1, mode: 'basic',
        })),
        displayPath: '/srv/project/outside.ts',
      }
      await expect(fs.writeText(outside, 'blocked')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
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
