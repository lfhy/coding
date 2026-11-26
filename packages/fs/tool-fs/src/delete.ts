/**
 * 面向模型的 `delete_file`：按一个路径或一组路径删除文件，目录需要显式 `recursive`。
 *
 * 删除落在解析后的目标上（与写入／编辑一致），因此工具先对原始路径做一次不跟随链接的
 * 探测，拒绝符号链接本身——否则一次删除会连带抹掉链接指向的文件。批量删除逐项执行，
 * 单项失败不会回滚已成功的删除；全部失败时按第一次失败的错误码抛出，让错误结果仍带
 * 结构化 code。
 * @module coding-tool-fs/src/delete
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from 'coding-tools'
import type { GenericCallView, GenericResultView, ToolExecution, ToolResult } from 'coding-tools'
import { FsError } from 'coding-fs'
import type { FsErrorCode, FsRemoveOutcome } from 'coding-fs'
import type {} from 'coding-fs'
import type {} from 'coding-system-prompt'
import { remediateFsError } from './error.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'

/** 一次批量删除中成功与被拒绝的条目，各自按调用参数顺序保序。 */
interface DeleteToolValue {
  deleted: Array<{ path: string; type: FsRemoveOutcome['type'] }>
  failed: Array<{ path: string; message: string }>
}

/**
 * `delete_file` 的已验证参数：基础参数加上仅在受限后端下公开的升权字段。
 */
interface DeleteToolArgs {
  file_path: string | string[]
  recursive?: boolean
  sandbox_permissions?: string
  justification?: string
}

/** 规范化后的删除目标：去重且保序，便于结果与调用参数一一对应。 */
interface DeleteInput {
  paths: string[]
  recursive: boolean
}

/**
 * 校验 schema 无法表达的取值约束：`file_path` 是非空字符串或非空字符串数组，
 * 每一项都必须包含非空白字符；重复路径只保留首次出现，避免第二次命中已不存在的目标。
 * @param args - schema 校验过的原始参数。
 * @returns 去重保序的路径列表与递归标志。
 */
export function parseDeleteArgs(args: { file_path: string | string[]; recursive?: boolean }): DeleteInput {
  const raw = typeof args.file_path === 'string' ? [args.file_path] : args.file_path
  if (raw.length === 0) throw new Error('file_path must be a non-empty string or a non-empty array of strings')
  const paths: string[] = []
  for (const path of raw) {
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new Error('file_path must be a non-empty string or a non-empty array of non-empty strings')
    }
    if (!paths.includes(path)) paths.push(path)
  }
  return { paths, recursive: args.recursive === true }
}

/**
 * 把删除结果转成模型可见文本：成功项逐条列出，失败项单独成段，避免模型把
 * 部分成功读成全部成功。
 * @param value - 本次批量删除的成功与失败条目。
 * @returns 供工具结果渲染的整段文本。
 */
export function formatDeleteOutput(value: DeleteToolValue): string {
  const lines: string[] = []
  if (value.deleted.length > 0) {
    lines.push(value.deleted.length === 1 ? 'Deleted 1 path.' : `Deleted ${value.deleted.length} paths.`)
    for (const entry of value.deleted) {
      lines.push(`- ${entry.path} (${entry.type === 'directory' ? 'directory, recursive' : entry.type})`)
    }
  }
  if (value.failed.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(value.failed.length === 1 ? '1 path was not deleted.' : `${value.failed.length} paths were not deleted.`)
    for (const entry of value.failed) lines.push(`- ${entry.path}: ${entry.message}`)
  }
  return lines.join('\n')
}

/** 一份删除结果的模型可见标题：单目标用完整路径，多目标用数量。 */
function deleteTitle(paths: readonly string[]): string {
  return paths.length === 1 ? `Delete ${paths[0]}` : `Delete ${paths.length} paths`
}

/** 从抛出物取模型可见文本；非 Error 抛出物按字符串化处理，保证结果可序列化。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从抛出物取稳定错误码；非 `FsError` 一律归入 `FS_IO_ERROR`。 */
function codeOf(error: unknown): FsErrorCode {
  return error instanceof FsError ? error.code : 'FS_IO_ERROR'
}

/**
 * 拒绝符号链接本身：`ctx.fs.resolve` 会把链接解析成真实目标，删除就会抹掉目标文件。
 * @param ctx - 提供路径形态元数据探测的上下文。
 * @param exec - 当前工具执行，携带会话 cwd 与取消信号。
 * @param path - 模型给出的原始路径。
 */
async function assertNotSymlink(ctx: Context, exec: ToolExecution, path: string): Promise<void> {
  const { cwd } = sessionResolveOptions(exec, path)
  const info = await ctx.fs.lstat(path, cwd === undefined ? {} : { cwd }, exec.signal)
  if (info?.type !== 'symlink') return
  throw new FsError(
    `cannot delete "${path}": path is a symbolic link; deleting follows it to its target, so use the shell to remove the link itself`,
    'FS_IO_ERROR',
  )
}

/**
 * 注册 `delete_file` 工具及其系统提示词指导。
 * @param ctx - 提供工具注册、提示词与文件系统能力的插件上下文。
 * @param sandbox - 与 write/edit 共用的沙箱升权 API。
 */
export function applyDeleteTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:delete_file',
    order: 104,
    text: 'Use delete_file to remove files, passing one path or an array of paths. Deleting a directory requires recursive: true and removes everything inside it, so list the directory first when its contents are not obvious. A path that is itself a symbolic link is refused because deletion follows the link to its target; use the shell to remove the link.',
  })

  ctx.tools.register(defineTool({
    name: 'delete_file',
    description: 'Delete one file or several files by path. A directory is deleted only with recursive: true.',
    // 标题完全由参数静态决定（单路径显示路径、多路径显示数量），不需要模型补写展示摘要。
    summaryParameter: false,
    parameters: {
      file_path: {
        required: true,
        oneOf: [
          { type: 'string', description: 'Path to delete, resolved by the filesystem backend.' },
          {
            type: 'array',
            items: { type: 'string' },
            description: 'Paths to delete, each resolved by the filesystem backend. Every path is attempted and each failure is reported.',
          },
        ],
      },
      recursive: {
        type: 'boolean',
        description: 'Delete a directory together with everything inside it. Required for directories; a file ignores it.',
      },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                type: { type: 'string', required: true, enum: ['file', 'directory', 'other'] },
              },
            },
          },
          failed: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatDeleteOutput(value) }],
    },
    async execute(args: DeleteToolArgs, exec) {
      const input = parseDeleteArgs(args)
      // 升权按整次调用解析一次：批量删除属于同一次操作，不在中途重新申请权限。
      const sandboxPolicy = await sandbox.resolvePolicy('delete_file', args, exec)
      const value: DeleteToolValue = { deleted: [], failed: [] }
      let firstFailure: { error: unknown; message: string } | undefined
      for (const path of input.paths) {
        const target = await ctx.fs.resolve(path, sessionResolveOptions(exec, path, sandboxPolicy?.workspaceRoot))
        try {
          await assertNotSymlink(ctx, exec, path)
          const outcome = await ctx.fs.remove(target, { recursive: input.recursive }, exec.signal, sandboxPolicy)
          // 删除成功后记录确认缺失：后续 edit 会据此报未找到，write 会重新建立文件。
          ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
          value.deleted.push({ path: target.displayPath, type: outcome.type })
        } catch (error: unknown) {
          const mapped = remediateFsError(sandbox.mapError(error, sandboxPolicy))
          firstFailure ??= { error: mapped, message: messageOf(mapped) }
          value.failed.push({ path: target.displayPath, message: messageOf(mapped) })
        }
      }
      // 全部失败时按第一次失败的 code 抛出：错误结果仍可被重试/权限层按 code 路由，
      // 部分成功则保留逐项结果，让模型知道哪些删除已经发生。
      if (value.deleted.length === 0 && firstFailure !== undefined) {
        throw new FsError(value.failed.map(entry => `${entry.path}: ${entry.message}`).join('\n'), codeOf(firstFailure.error), { cause: firstFailure.error })
      }
      return value
    },
    presentCall(args): GenericCallView {
      const paths = typeof args.file_path === 'string' ? [args.file_path] : args.file_path
      return {
        card: 'generic',
        title: deleteTitle(paths),
        kind: 'delete',
        locations: paths.map(path => ({ path })),
      }
    },
    presentResult(args, result: ToolResult): GenericResultView | undefined {
      if (result.isError) return undefined
      const paths = typeof args.file_path === 'string' ? [args.file_path] : args.file_path
      return { card: 'generic', title: deleteTitle(paths) }
    },
  }))
}
