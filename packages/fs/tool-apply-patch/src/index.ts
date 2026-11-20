/**
 * 面向模型的 Codex 风格补丁工具，落在 `ctx.fs` seam 上。
 *
 * Responses 原生语法工具直接接收补丁文本；其他协议仍以 JSON `input` 字符串传递。
 * 两者共用 Codex `*** Begin Patch` / `*** End Patch` 封套与执行器，仅支持新建和
 * 编辑：删除和改名会被明确拒绝，因为 `FileSystem` 没有对应原语，需要时由 shell
 * 承担。所有写入仍会经过 `fs/*` 策略监听与提供方的沙箱边界。
 *
 * @module coding-tool-apply-patch
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from 'coding-tools'
import type { DiffCallView, DiffResultView, ToolExecution, ToolResult } from 'coding-tools'
import type { FsTarget } from 'coding-fs'
import type {} from 'coding-fs'
import type {} from 'coding-system-prompt'
import { applyPatchHunks, parsePatch, PatchError, type PatchFile, type ParsedPatch } from './patch.ts'
import type { SandboxExecutionPolicy } from 'coding-sandbox'
import type {} from 'coding-sandbox-policy'

export const name = 'tool-apply-patch'
export const inject = ['tools', 'fs', 'systemPrompt']

const DESCRIPTION = 'Apply a Codex-style patch to workspace files. The input must be a string containing '
  + '`*** Begin Patch` and `*** End Patch`; do not wrap the patch syntax in another JSON object. '
  + 'One patch can create files and edit existing ones: each section starts with a header line of the form '
  + '`*** Add File: <path>` or `*** Update File: <path>`, followed by that section\'s lines. '
  + 'This composition cannot delete or rename files; use the shell for those.'

const GUIDANCE = 'Use apply_patch for a small, targeted batch of file changes. Send the complete patch envelope '
  + 'as the input string. Read existing files before editing them; deleting or moving a file is not '
  + 'available in this filesystem composition.'

// 改编自 Codex 的 Apache-2.0 apply_patch.lark：仅保留本文件系统执行器支持的新增与更新。
// 原始来源：https://github.com/openai/codex/blob/main/codex-rs/core/assets/tools/apply_patch.lark
const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
update_hunk: "*** Update File: " filename LF change+

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change: change_context change_line+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`

interface ApplyPatchArgs { input: string }

interface ApplyPatchValue {
  files: Array<{ path: string; operation: 'create' | 'update'; before: string | null; after: string }>
}

interface PatchTarget {
  readonly path: string
  readonly operation: 'create' | 'update'
  readonly before: string | null
  readonly after: string
}

function patchError(error: unknown): Error {
  return error instanceof PatchError ? new Error(`apply_patch verification failed: ${error.message}`) : error as Error
}

function assertUniquePaths(files: readonly PatchFile[]): void {
  const seen = new Set<string>()
  for (const file of files) {
    if (file.kind === 'update' && file.moveTo !== undefined) {
      throw new PatchError(`Move to is not supported for ${file.path}`)
    }
    if (file.kind === 'delete') throw new PatchError(`Delete File is not supported for ${file.path}`)
    if (seen.has(file.path)) throw new PatchError(`the patch names ${file.path} more than once`)
    seen.add(file.path)
  }
}

async function readExisting(
  ctx: Context,
  path: string,
  exec: ToolExecution,
  sandboxPolicy?: SandboxExecutionPolicy,
): Promise<{ target: FsTarget; content: string | undefined }> {
  const target = await ctx.fs.resolve(path, {
    ...sandboxPolicy?.workspaceRoot === undefined ? {} : { cwd: sandboxPolicy.workspaceRoot },
    ...sandboxPolicy?.workspaceRoot === undefined && exec.agent?.session.header.cwd !== undefined
      ? { cwd: exec.agent.session.header.cwd } : {},
    signal: exec.signal,
  })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) return { target, content: undefined }
  if (info.type !== 'file') throw new PatchError(`${path} is not a regular file`)
  const content = await ctx.fs.readText(target, exec.signal)
  // 更新补丁的后续 edit-intent 依赖这次成功读取的版本；必须在内容读取完成后发布观测。
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  return { target, content }
}

function policyOf(ctx: Context, exec: ToolExecution): SandboxExecutionPolicy | undefined {
  const policy = ctx.get('sandboxPolicy')
  return policy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
}

function outputText(value: ApplyPatchValue): string {
  return value.files.length === 0
    ? 'No files changed.'
    : value.files.map(file => `${file.operation === 'create' ? 'Added' : 'Updated'} ${file.path}`).join('\n')
}

function patchDiffs(value: ApplyPatchValue): DiffCallView['diffs'] {
  return value.files.map(file => ({ path: file.path, oldText: file.before, newText: file.after }))
}

/**
 * 注册 Codex 风格补丁工具，所有文件操作仍通过文件系统策略。
 * @param ctx - 提供工具注册、提示词与文件系统能力的插件上下文。
 * @returns 无返回值；注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'tool:apply_patch', order: 103, text: GUIDANCE })
  ctx.tools.register(defineTool({
    name: 'apply_patch',
    description: DESCRIPTION,
    summaryParameter: false,
    inputFormat: {
      type: 'grammar',
      syntax: 'lark',
      definition: APPLY_PATCH_LARK_GRAMMAR,
      description: 'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
    },
    parameters: {
      input: { type: 'string', required: true, description: 'The complete Codex patch text; pass it as one string.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                operation: { type: 'string', required: true, enum: ['create', 'update'] },
                before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                after: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: outputText(value) }],
      presentationMeta: (_args, value) => ({
        diffs: patchDiffs(value).map(diff => ({
          path: diff.path,
          oldText: diff.oldText,
          newText: diff.newText,
        })),
      }),
    },
    async execute(args: ApplyPatchArgs, exec: ToolExecution) {
      let parsed: ParsedPatch
      try {
        parsed = parsePatch(args.input)
        assertUniquePaths(parsed.files)
      } catch (error) {
        throw patchError(error)
      }

      const targets: PatchTarget[] = []
      for (const file of parsed.files) {
        const policy = policyOf(ctx, exec)
        if (file.kind === 'add') {
          const existing = await readExisting(ctx, file.path, exec, policy)
          if (existing.content !== undefined) throw new Error(`apply_patch: ${file.path} already exists; an Add File section cannot overwrite it — use an Update File section instead`)
          const intent = await ctx.waterfall('fs/write-intent', existing.target, exec, () => undefined)
          const outcome = await ctx.fs.writeText(existing.target, file.content, intent, exec.signal, policy)
          ctx.emit('fs/observed', existing.target, { kind: 'present', version: outcome.version }, exec)
          targets.push({ path: existing.target.displayPath, operation: 'create', before: outcome.before, after: outcome.after })
          continue
        }

        if (file.kind !== 'update') throw new Error(`apply_patch: unsupported file operation for ${file.path}`)
        const existing = await readExisting(ctx, file.path, exec, policy)
        if (existing.content === undefined) throw new Error(`apply_patch: ${file.path} does not exist; an Update File section needs an existing file — use an Add File section instead`)
        const after = applyPatchHunks(file.path, existing.content, file.hunks)
        const intent = await ctx.waterfall('fs/edit-intent', existing.target, exec, () => undefined)
        const outcome = await ctx.fs.editText(existing.target, {
          oldString: existing.content,
          newString: after,
          replaceAll: false,
        }, intent, exec.signal, policy)
        ctx.emit('fs/observed', existing.target, { kind: 'present', version: outcome.version }, exec)
        targets.push({ path: existing.target.displayPath, operation: 'update', before: outcome.before, after: outcome.after })
      }
      return { files: targets }
    },
    presentCall: args => ({ card: 'diff', title: 'Apply patch', diffs: [{ path: '(patch)', oldText: null, newText: args.input }] }),
    presentResult: (_args, result: ToolResult): DiffResultView | undefined => {
      if (result.isError) return undefined
      const diffs = (result.meta as { diffs?: DiffResultView['diffs'] } | undefined)?.diffs
      return diffs === undefined ? undefined : { card: 'diff', title: 'Apply patch', diffs }
    },
  }))
}
