/** Filesystem-seam source access for the generic stdio LSP provider. */

import { Buffer } from 'node:buffer'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import {
  isRemoteAbsolutePath,
  isRemotePathWithin,
  parseRemoteWorkspaceTargetKey,
  remoteWorkspaceLocalPath,
  verifyRemoteWorkspaceTarget,
} from '@deepseek-ai/dsh-subprocess'
import type { RemoteWorkspaceTarget } from '@deepseek-ai/dsh-subprocess'
import { throwIfAborted } from './abort.ts'

/** A canonical workspace in the filesystem/subprocess execution world. */
export interface HostWorkspace {
  /** Stable filesystem identity used for provider pooling. */
  readonly target: FsTarget
  /** Canonical absolute path accepted as a subprocess cwd. */
  readonly canonicalPath: string
  /** Canonical file URI sent during LSP initialization. */
  readonly fileUrl: string
  /** Workspace 属于远端执行世界时使用的 Remote-SSH marker 身份。 */
  readonly remoteTarget?: RemoteWorkspaceTarget
  /** 供文件系统再次解析相对源文件的本地 marker 路径；不会传给远端进程。 */
  readonly fsCwd?: string
}

/** A validated source and the exact URI sent to the language server. */
export interface HostSource {
  /** Canonical file URI in the execution world's platform syntax. */
  readonly fileUrl: string
  /** Current complete UTF-8 text. */
  readonly text: string
}

/**
 * Resolve and validate one workspace through `ctx.fs`.
 * @param fs - filesystem provider sharing the language server's execution world.
 * @param workspaceRoot - caller-supplied workspace path.
 * @param signal - optional cancellation around provider operations.
 * @returns stable identity plus process path and file URI.
 */
export async function canonicalizeWorkspace(
  fs: FileSystem,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<HostWorkspace> {
  throwIfAborted(signal)
  let target: FsTarget
  try {
    target = await fs.resolve(workspaceRoot, signal === undefined ? {} : { signal })
  } catch (error: unknown) {
    throwIfAborted(signal)
    throw new Error(`workspace root "${workspaceRoot}" cannot be resolved: ${messageOf(error)}`, { cause: error })
  }
  throwIfAborted(signal)
  const info = await fs.stat(target, signal).catch((error: unknown) => {
    throwIfAborted(signal)
    throw error
  })
  throwIfAborted(signal)
  if (info?.type !== 'directory') {
    throw new Error(`workspace root "${workspaceRoot}" is not a directory`)
  }
  const parsedRemote = parseRemoteWorkspaceTargetKey(String(target.targetKey))
  const remoteTarget = parsedRemote === undefined ? undefined : await verifyRemoteWorkspaceTarget(parsedRemote, signal)
  throwIfAborted(signal)
  return {
    target,
    canonicalPath: fs.processPath(target),
    fileUrl: fs.fileUrl(target),
    ...remoteTarget === undefined ? {} : {
      remoteTarget,
      fsCwd: remoteWorkspaceLocalPath(remoteTarget, remoteTarget.remotePath),
    },
  }
}

/**
 * Resolve, contain, and read one byte-bounded query source through `ctx.fs`.
 * This layer owns the LSP-specific complete-document cap while the filesystem
 * provider owns streaming, regular-file checks, and UTF-8 validation.
 * @param fs - filesystem provider sharing the server's execution world.
 * @param filePath - absolute source path or path relative to `workspace`.
 * @param workspace - already-canonical workspace.
 * @param maxDocumentBytes - largest complete source accepted by this host.
 * @param signal - optional cancellation.
 * @returns canonical file URI and current text.
 */
export async function readHostSource(
  fs: FileSystem,
  filePath: string,
  workspace: HostWorkspace,
  maxDocumentBytes: number,
  signal?: AbortSignal,
): Promise<HostSource> {
  throwIfAborted(signal)
  const remoteTarget = workspace.remoteTarget === undefined
    ? undefined
    : await verifyRemoteWorkspaceTarget(workspace.remoteTarget, signal)
  throwIfAborted(signal)
  let path = filePath
  let cwd = workspace.fsCwd ?? workspace.canonicalPath
  if (remoteTarget !== undefined) {
    cwd = remoteWorkspaceLocalPath(remoteTarget, remoteTarget.remotePath)
    if (isRemoteAbsolutePath(filePath)) {
      if (!isRemotePathWithin(remoteTarget.remoteRoot, filePath)) {
        throw new Error(`source "${filePath}" resolves outside the workspace`)
      }
      // LSP 请求使用语言服务器的远端 URI 命名空间；文件系统 Provider 必须经由
      // 本地 marker 命名空间路由，不能把形似远端绝对路径的 Host 路径交给本机。
      path = remoteWorkspaceLocalPath(remoteTarget, filePath)
    }
  }
  let target: FsTarget
  try {
    target = await fs.resolve(path, {
      cwd,
      ...signal === undefined ? {} : { signal },
    })
  } catch (error: unknown) {
    throwIfAborted(signal)
    throw new Error(`source "${filePath}" cannot be resolved: ${messageOf(error)}`, { cause: error })
  }
  throwIfAborted(signal)
  if (!fs.contains(workspace.target, target)) {
    throw new Error(`source "${filePath}" resolves outside the workspace`)
  }
  const chunks: string[] = []
  let bytes = 0
  try {
    // XXX(lsp-source-replacement): Revisit stable-handle identity only if a real query observes
    // replacement between canonical containment and the provider opening this stream.
    const stream = await fs.streamText(target, signal)
    for await (const chunk of stream) {
      throwIfAborted(signal)
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxDocumentBytes) break
      chunks.push(chunk)
    }
  } catch (error: unknown) {
    throwIfAborted(signal)
    throw new Error(`source "${filePath}" could not be read: ${messageOf(error)}`, { cause: error })
  }
  if (bytes > maxDocumentBytes) {
    throw new Error(
      `source "${filePath}" exceeds the ${maxDocumentBytes}-byte limit; reading stopped after ${bytes} bytes`,
    )
  }
  throwIfAborted(signal)
  return {
    fileUrl: fs.fileUrl(target),
    text: chunks.join(''),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
