/**
 * 沙箱围栏的后端装饰器：包装任意 `FsProvider`，只在两个变更原语上按调用策略
 * 施加围栏，读取直通。`SandboxedFileSystem` 与多后端注册表共用这份围栏。
 * @module coding-fs-sandbox/backend
 */

import { Context } from '@deepseek-ai/cordis'
import { FsError } from 'coding-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsProvider,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from 'coding-fs'
import {
  parseRemoteWorkspaceTargetKey,
  isRemotePathWithin,
  remoteWorkspacePath,
  verifyRemoteWorkspaceTarget,
  RemoteWorkspaceError,
} from 'coding-subprocess'
import { writableRoots } from 'coding-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from 'coding-sandbox'
import type {} from 'coding-sandbox-policy'
import { isPathUnder } from './containment.ts'

/**
 * 按调用策略围栏一个变更目标，返回必须用于变更的那个目标身份（检查即使用，
 * 避免 check-here-write-there）。`read-only` 拒绝；`workspace-write` 重新规范化
 * 后要求落在可写根内；`danger-full-access` 原样放行。
 * @param options.ctx - 提供 `sandboxPolicy` 的上下文。
 * @param options.resolve - 后端自己的 resolve，用于重新规范化本地目标。
 * @param options.target - 待变更的目标。
 * @param options.policy - 本次调用的策略；省略时用部署默认值。
 * @returns 允许变更时返回应使用的目标。
 * @throws {FsError} 拒绝时抛出结构化 `FS_SANDBOX_DENIED`。
 */
export async function fencedTarget(options: {
  ctx: Context
  resolve: (path: string) => Promise<FsTarget>
  target: FsTarget
  policy?: SandboxExecutionPolicy | undefined
}): Promise<FsTarget> {
  const { ctx, target } = options
  const policy = options.policy ?? ctx.sandboxPolicy.resolve()
  const { mode } = policy
  let remote
  try {
    remote = parseRemoteWorkspaceTargetKey(String(target.targetKey))
  } catch (error: unknown) {
    throw markerError(target, error)
  }
  if (remote !== undefined) {
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    if (mode === 'danger-full-access') return target
    try {
      const verified = await verifyRemoteWorkspaceTarget(remote)
      const workspace = await remoteWorkspacePath(policy.workspaceRoot)
      // workspace-write 的本地 root 必须就是本 target 所属 marker；不能让
      // 一个会话借由绝对本地 marker 路径写入另一个 SSH 工作区。
      if (workspace === undefined || workspace.markerRoot !== verified.markerRoot
        || workspace.remoteRoot !== verified.remoteRoot || workspace.connectionId !== verified.connectionId
        || !isRemotePathWithin(workspace.remotePath, verified.remotePath)) {
        throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
      }
      return target
    } catch (error: unknown) {
      if (error instanceof FsError) throw error
      throw markerError(target, error)
    }
  }
  if (mode === 'danger-full-access') return target
  if (mode === 'read-only') {
    throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
  }
  const fresh = await options.resolve(target.displayPath)
  let contained = false
  for (const root of writableRoots(policy)) {
    if (await isPathUnder(fresh.targetKey, root)) {
      contained = true
      break
    }
  }
  if (!contained) {
    throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
  }
  return fresh
}

/** 将 marker 校验失败归入 filesystem seam，而不泄漏 bridge 或认证细节。 */
function markerError(target: FsTarget, error: unknown): FsError {
  if (error instanceof RemoteWorkspaceError && error.code === 'REMOTE_BRIDGE_ABORTED') {
    return new FsError('write aborted', 'FS_ABORTED')
  }
  return new FsError(`cannot write "${target.displayPath}": remote workspace marker is unavailable`, 'FS_IO_ERROR')
}

/**
 * 包装任意后端：变更按策略围栏，其余原语原样委托。`id`、`matches`、`owns`
 * 与被包装后端一致，因此注册表分派不需要知道围栏的存在。
 */
export class SandboxedBackend implements FsProvider {
  constructor(private readonly ctx: Context, private readonly inner: FsProvider) {}

  get id(): string { return this.inner.id }

  get sandboxMode(): SandboxMode | undefined { return this.ctx.sandboxPolicy.defaultMode }

  matches(cwd: string): boolean { return this.inner.matches(cwd) }

  owns(targetKey: string): boolean { return this.inner.owns(targetKey) }

  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return this.inner.resolve(path, opts)
  }

  processPath(target: FsTarget): string { return this.inner.processPath(target) }

  fileUrl(target: FsTarget): string { return this.inner.fileUrl(target) }

  contains(parent: FsTarget, child: FsTarget): boolean { return this.inner.contains(parent, child) }

  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.inner.stat(target, signal)
  }

  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return this.inner.lstat(path, opts, signal)
  }

  readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.inner.readText(target, signal)
  }

  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return this.inner.streamText(target, signal)
  }

  readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return this.inner.readBytes(target, signal, maxBytes)
  }

  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return this.inner.listDir(target, signal)
  }

  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const fenced = await fencedTarget({
      ctx: this.ctx, resolve: path => this.inner.resolve(path), target, policy: sandboxPolicy,
    })
    return this.inner.writeText(fenced, content, expected, signal)
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const fenced = await fencedTarget({
      ctx: this.ctx, resolve: path => this.inner.resolve(path), target, policy: sandboxPolicy,
    })
    return this.inner.editText(fenced, edit, expected, signal)
  }
}
