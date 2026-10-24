/**
 * Model-facing Codex-style patch application over `ctx.fs`.
 *
 * The tool accepts a JSON object with one required `input` string because the
 * current LLM seam is function/JSON based. The string itself uses Codex's
 * `*** Begin Patch` / `*** End Patch` envelope. Add and Update File are
 * supported; Delete File and Move to are rejected because `FileSystem` has no
 * delete or rename operation. All writes still pass through `fs/*` policy
 * listeners and the provider's sandbox boundary.
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
  + 'Supports `*** Add File` and `*** Update File`. `*** Delete File` and `*** Move to` are not supported; '
  + 'use the available file editing tools for those operations.'

const GUIDANCE = 'Use apply_patch for a small, targeted batch of file changes. Send the complete patch envelope '
  + 'as the input string. It supports Add File and Update File sections; Delete File and Move to are not '
  + 'available in this filesystem composition. Read existing files before updating them.'

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

function assertSafePath(path: string): void {
  if (path.trim().length === 0 || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw new PatchError(`path is not a workspace-relative file path: ${JSON.stringify(path)}`)
  }
  if (path.startsWith('.')) throw new PatchError(`path is not a workspace file path: ${JSON.stringify(path)}`)
}

function assertUniquePaths(files: readonly PatchFile[]): void {
  const seen = new Set<string>()
  for (const file of files) {
    assertSafePath(file.path)
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
  return { target, content: await ctx.fs.readText(target, exec.signal) }
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

/** Register the Codex-style patch tool. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'tool:apply_patch', order: 103, text: GUIDANCE })
  ctx.tools.register(defineTool({
    name: 'apply_patch',
    description: DESCRIPTION,
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
          if (existing.content !== undefined) throw new Error(`apply_patch: ${file.path} already exists; use Update File`)
          const intent = await ctx.waterfall('fs/write-intent', existing.target, exec, () => undefined)
          const outcome = await ctx.fs.writeText(existing.target, file.content, intent, exec.signal, policy)
          ctx.emit('fs/observed', existing.target, { kind: 'present', version: outcome.version }, exec)
          targets.push({ path: existing.target.displayPath, operation: 'create', before: outcome.before, after: outcome.after })
          continue
        }

        if (file.kind !== 'update') throw new Error(`apply_patch: unsupported file operation for ${file.path}`)
        const existing = await readExisting(ctx, file.path, exec, policy)
        if (existing.content === undefined) throw new Error(`apply_patch: ${file.path} does not exist; use Add File`)
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
