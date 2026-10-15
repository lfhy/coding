import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PROJECT_META_FILE } from '@deepseek-ai/dsh-memory'
import LocalMemory from '@deepseek-ai/dsh-memory-local'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

/** 挂载 Provider，并返回它的项目记忆目录与一个属于该项目的会话 cwd。 */
async function mount(): Promise<{
  ctx: Context
  root: string
  cwd: string
  project: ReturnType<Context['memory']['projectFor']>
}> {
  const root = await tempDir('dsh-memory-local-')
  const cwd = join(root, 'repo', 'packages', 'app')
  await mkdir(join(root, 'repo', '.git'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(LocalMemory, { root: join(root, 'home', 'memory') })
  return { ctx, root, cwd, project: ctx.memory.projectFor(cwd) }
}

describe('local memory provider', () => {
  it('writes, lists, reads, and removes entries inside one project directory', async () => {
    const live = await mount()
    try {
      await live.ctx.memory.save(live.project, { content: '测试用 pnpm' })

      const [file] = await live.ctx.memory.list(live.project)
      expect(file).toMatchObject({ name: 'notes.md', title: 'repo 记忆' })
      expect(live.project.directory).toBe(join(live.root, 'home', 'memory', live.project.key))
      const written = await readFile(join(live.project.directory, 'notes.md'), 'utf8')
      expect(written).toContain('- 测试用 pnpm')

      await expect(live.ctx.memory.read(live.project, 'notes.md')).resolves.toMatchObject({
        content: expect.stringContaining('测试用 pnpm') as unknown as string,
      })
      await expect(live.ctx.memory.read(live.project, 'missing.md')).resolves.toBeUndefined()

      await expect(live.ctx.memory.remove(live.project, 'notes.md')).resolves.toBe(true)
      await expect(live.ctx.memory.remove(live.project, 'notes.md')).resolves.toBe(false)
      await expect(live.ctx.memory.list(live.project)).resolves.toEqual([])
    } finally {
      await live.ctx.fiber.dispose()
    }
  })

  it('records the project realpath beside the entries without listing it as memory', async () => {
    const live = await mount()
    try {
      await live.ctx.memory.save(live.project, { content: '第一条' })

      const meta = JSON.parse(await readFile(join(live.project.directory, PROJECT_META_FILE), 'utf8')) as {
        path: string
        key: string
      }
      expect(meta.path).toBe(live.project.path)
      expect(meta.key).toBe(live.project.key)
      await expect(live.ctx.memory.list(live.project)).resolves.toHaveLength(1)
    } finally {
      await live.ctx.fiber.dispose()
    }
  })

  it('keeps memory private to the user with 0700 directories and 0600 files', async () => {
    const live = await mount()
    try {
      await live.ctx.memory.save(live.project, { content: '第一条' })

      const directory = await stat(live.project.directory)
      const file = await stat(join(live.project.directory, 'notes.md'))
      expect(directory.mode & 0o777).toBe(0o700)
      expect(file.mode & 0o777).toBe(0o600)
    } finally {
      await live.ctx.fiber.dispose()
    }
  })

  it('refuses to write through a project directory that became a symlink', async () => {
    const live = await mount()
    const elsewhere = await tempDir('dsh-memory-elsewhere-')
    try {
      await mkdir(join(live.root, 'home', 'memory'), { recursive: true })
      await symlink(elsewhere, live.project.directory, 'dir')

      await expect(live.ctx.memory.save(live.project, { content: '第一条' })).rejects.toThrow(/redirected project directory/)
    } finally {
      await live.ctx.fiber.dispose()
    }
  })
})
