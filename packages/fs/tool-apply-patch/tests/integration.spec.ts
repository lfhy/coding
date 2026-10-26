/** 通过真实工具执行链验证 apply_patch 与文件观测策略的协作。 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from 'coding-llm'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime from 'coding-tools'
import LocalFileSystem from 'coding-fs-local'
import * as FsPolicy from 'coding-fs-observation-policy'
import * as ToolApplyPatch from 'coding-tool-apply-patch'

const signal = new AbortController().signal
const session = { header: {} }

let dir: string
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
let callCounter = 0

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-tool-apply-patch-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  fiber = await ctx.plugin(ToolApplyPatch)
})

afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

function applyPatch(input: string) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`apply-patch-${++callCounter}`),
    name: 'apply_patch',
    arguments: { input },
    agent: { session } as never,
  })
}

describe('apply_patch integration', () => {
  it('records an update read before requesting the guarded edit', async () => {
    const path = join(dir, 'src/components/files/files-page.tsx')
    await mkdir(join(dir, 'src/components/files'), { recursive: true })
    await writeFile(path, 'className="flex max-w-full items-center gap-3 text-left transition-colors hover:text-primary"\n')

    const result = await applyPatch(`*** Begin Patch
*** Update File: src/components/files/files-page.tsx
@@
-className="flex max-w-full items-center gap-3 text-left transition-colors hover:text-primary"
+className="flex w-full min-w-0 items-center gap-3 text-left transition-colors hover:text-primary"
*** End Patch`)

    expect(result.isError).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('className="flex w-full min-w-0 items-center gap-3 text-left transition-colors hover:text-primary"\n')
  })
})
