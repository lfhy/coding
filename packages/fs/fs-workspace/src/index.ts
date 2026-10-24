/**
 * 多后端文件系统装配：`ctx.fs` 是分派注册表，默认注册沙箱包装后的本地后端
 * 与 Remote-SSH 后端。工作区创建时可以用 `ctx.fs.bind(cwd, backendId)` 记录
 * 显式绑定；没有记录时按后端的 `matches(cwd)` 选择，最后使用本地回退后端。
 *
 * 这个包取代默认组合里直接加载 `coding-fs-sandbox` 的单后端装配：工具层仍然
 * 只调用 `ctx.fs`，无需知道一个 Host 里有几个执行世界。
 *
 * @module coding-fs-workspace
 */

import { Context } from '@deepseek-ai/cordis'
import { FsRegistry } from 'coding-fs'
import { LocalFileSystemBackend, RemoteWorkspaceRouter } from 'coding-fs-local'
import type { Config as LocalConfig } from 'coding-fs-local'
import { SandboxedBackend } from 'coding-fs-sandbox'
import type {} from 'coding-sandbox-policy'
import z from '@deepseek-ai/schemastery'

/** 装配配置：本地后端的参数原样转发。 */
export type Config = LocalConfig

/**
 * 默认多后端装配。加载它即提供 `ctx.fs`；`sandboxPolicy` 就绪后本地与远端后端都按策略
 * 围栏，远端后端沿用 Remote-SSH 的整机访问语义，但 `workspace-write` 仍只允许会话远端根内的变更。
 */
export class FsWorkspace extends FsRegistry {
  static inject = ['sandboxPolicy']

  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    cwd: z.string().default(process.cwd()),
    diffBasisMaxBytes: z.number().default(10 * 1024 * 1024),
  })

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const local = new LocalFileSystemBackend(config)
    this.register(new SandboxedBackend(ctx, local), { fallback: true })
    this.register(new SandboxedBackend(ctx, new RemoteWorkspaceRouter()))
  }
}

export default FsWorkspace
