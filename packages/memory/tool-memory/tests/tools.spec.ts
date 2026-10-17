import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from 'coding-llm'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime from 'coding-tools'
import LocalMemory from 'coding-memory-local'
import type { Agent } from 'coding-agent'
import * as ToolMemory from 'coding-tool-memory'

const cleanups: string[] = []
const testToolSignal = new AbortController().signal

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** 只有 cwd 的最小 agent；工具只读 `session.header.cwd` 来定位项目。 */
function stubAgent(cwd: string): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

async function mount(): Promise<{ ctx: Context; root: string; project: string; other: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-memory-'))
  cleanups.push(root)
  const project = join(root, 'repo')
  const other = join(root, 'other-repo')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(other, '.git'), { recursive: true })
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalMemory, { root: join(root, 'home', 'memory') })
  await ctx.plugin(ToolMemory)
  return { ctx, root, project, other }
}

function call(ctx: Context, agent: Agent, name: string, args: Record<string, unknown>) {
  return ctx.tools.execute({ signal: testToolSignal, callId: CallId(`call-${name}`), name, arguments: args, agent })
}

describe('project memory tools', () => {
  it('saves, lists, reads, and deletes memory for the session project', async () => {
    const live = await mount()
    const agent = stubAgent(live.project)
    try {
      const saved = await call(live.ctx, agent, 'memory_save', { content: '测试用 pnpm', section: '约定' })
      expect(saved.isError).toBe(false)
      expect(saved.content).toMatchObject([{ type: 'text', text: expect.stringContaining('notes.md') as unknown as string }])

      const listed = await call(live.ctx, agent, 'memory_list', {})
      expect(listed.isError).toBe(false)
      expect(listed.content).toMatchObject([{ type: 'text', text: expect.stringContaining('notes.md') as unknown as string }])

      const read = await call(live.ctx, agent, 'memory_read', { file: 'notes.md' })
      expect(read.isError).toBe(false)
      expect(read.content).toMatchObject([{ type: 'text', text: expect.stringContaining('测试用 pnpm') as unknown as string }])

      const removed = await call(live.ctx, agent, 'memory_delete', { file: 'notes.md' })
      expect(removed.isError).toBe(false)
      expect(removed.content).toMatchObject([{ type: 'text', text: expect.stringContaining('Removed the file') as unknown as string }])
      const afterDelete = await call(live.ctx, agent, 'memory_list', {})
      expect(afterDelete.content).toMatchObject([{ type: 'text', text: 'This project has no memory yet.' }])
    } finally {
      await live.ctx.fiber.dispose()
    }
  })

  it('keeps two projects isolated', async () => {
    const live = await mount()
    try {
      await call(live.ctx, stubAgent(live.project), 'memory_save', { content: '属于这个项目' })

      const otherList = await call(live.ctx, stubAgent(live.other), 'memory_list', {})
      expect(otherList.content).toMatchObject([{ type: 'text', text: 'This project has no memory yet.' }])
      const otherRead = await call(live.ctx, stubAgent(live.other), 'memory_read', { file: 'notes.md' })
      expect(otherRead.isError).toBe(true)
    } finally {
      await live.ctx.fiber.dispose()
    }
  })

  it('rejects a caller without an owning session', async () => {
    const live = await mount()
    try {
      const result = await call(live.ctx, undefined as unknown as Agent, 'memory_list', {})

      expect(result.isError).toBe(true)
      expect(result.content).toMatchObject([{ type: 'text', text: expect.stringContaining('owning agent session') as unknown as string }])
    } finally {
      await live.ctx.fiber.dispose()
    }
  })
})
