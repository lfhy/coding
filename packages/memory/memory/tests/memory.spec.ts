import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_MEMORY_FILE,
  Memory,
  MemoryConfig,
  appendMemoryEntry,
  findMemoryEntries,
  memoryFileName,
  memoryProjectKey,
  removeMemorySection,
  replaceMemoryEntry,
  resolveMemoryProject,
  type MemoryFileSummary,
  type MemoryProject,
} from '../src/index.ts'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

/** 内存 Provider：把四个存储原语放在 Map 上，让策略测试不依赖文件系统。 */
class MemoryFixture extends Memory {
  readonly files = new Map<string, string>()

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, MemoryConfig(config))
  }

  protected async listFiles(_project: MemoryProject): Promise<MemoryFileSummary[]> {
    return [...this.files.entries()].map(([name, content]) => ({
      name,
      title: name,
      bytes: Buffer.byteLength(content, 'utf8'),
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))
  }

  protected async readFile(_project: MemoryProject, name: string): Promise<string | undefined> {
    return this.files.get(name)
  }

  protected async writeFile(_project: MemoryProject, name: string, content: string): Promise<void> {
    this.files.set(name, content)
  }

  protected async removeFile(_project: MemoryProject, name: string): Promise<boolean> {
    return this.files.delete(name)
  }
}

function mountMemory(config: Record<string, unknown> = {}): MemoryFixture {
  const ctx = new Context()
  return new MemoryFixture(ctx, config)
}

describe('memory project scope', () => {
  it('keys a project by the realpath of its root marker', async () => {
    const root = await tempDir('dsh-memory-project-')
    const nested = join(root, 'packages', 'app', 'src')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(nested, { recursive: true })
    const memoryRoot = join(root, 'home', 'memory')

    const fromRoot = resolveMemoryProject(root, ['.git'], memoryRoot)
    const fromNested = resolveMemoryProject(nested, ['.git'], memoryRoot)

    expect(fromNested).toEqual(fromRoot)
    expect(fromNested.key).toBe(memoryProjectKey(await realpath(root)))
    expect(fromNested.directory).toBe(join(memoryRoot, fromRoot.key))
  })

  it('falls back to the session directory when no marker exists', async () => {
    const root = await tempDir('dsh-memory-markerless-')
    const project = resolveMemoryProject(root, ['.git'], join(root, 'memory'))

    expect(project.path).toBe(await realpath(root))
  })

  it('accepts only same-directory markdown file names', () => {
    expect(memoryFileName()).toBe(DEFAULT_MEMORY_FILE)
    expect(memoryFileName('decisions.md')).toBe('decisions.md')
    expect(() => memoryFileName('../escape.md')).toThrow(/invalid memory file/)
    expect(() => memoryFileName('nested/notes.md')).toThrow(/invalid memory file/)
    expect(() => memoryFileName('.hidden.md')).toThrow(/invalid memory file/)
    expect(() => memoryFileName('notes.txt')).toThrow(/invalid memory file/)
  })
})

describe('memory entry rendering', () => {
  it('starts a new file with a title and the requested section', () => {
    const content = appendMemoryEntry('', 'app', '要点', '第一条')

    expect(content).toBe('# app 记忆\n\n## 要点\n\n- 第一条\n')
  })

  it('appends into the existing section and keeps later sections intact', () => {
    const first = appendMemoryEntry('', 'app', '要点', '第一条')
    const withLater = `${first}\n## 决策\n\n- 沿用它\n`
    const next = appendMemoryEntry(withLater, 'app', '要点', '第二条')

    expect(next).toContain('## 要点\n\n- 第一条\n- 第二条\n')
    expect(next).toContain('## 决策\n\n- 沿用它')
  })

  it('adds a missing section at the end', () => {
    const next = appendMemoryEntry('# app 记忆\n\n## 要点\n\n- 第一条\n', 'app', '坑', '第二条')

    expect(next).toContain('## 坑\n\n- 第二条\n')
  })

  it('indents continuation lines of a multi-line entry', () => {
    const content = appendMemoryEntry('', 'app', '要点', '第一行\n第二行')

    expect(content).toContain('- 第一行\n  第二行\n')
  })

  it('removes only the named section', () => {
    const content = '# app 记忆\n\n## 要点\n\n- 第一条\n\n## 决策\n\n- 沿用它\n'
    const stripped = removeMemorySection(content, '要点')

    expect(stripped.removed).toBe(true)
    expect(stripped.content).not.toContain('第一条')
    expect(stripped.content).toContain('## 决策')
    expect(removeMemorySection(content, '不存在').removed).toBe(false)
  })
})

describe('memory service limits', () => {
  const project: MemoryProject = { path: '/repo', key: 'k', directory: '/repo-memory' }

  it('saves an entry and reports the written file', async () => {
    const memory = mountMemory()

    const written = await memory.save(project, { content: '约定：测试用 pnpm' })

    expect(written).toMatchObject({ name: DEFAULT_MEMORY_FILE })
    await expect(memory.read(project, DEFAULT_MEMORY_FILE)).resolves.toMatchObject({
      content: expect.stringContaining('- 约定：测试用 pnpm') as unknown as string,
      truncated: false,
    })
  })

  it('refuses an empty entry and an oversized entry', async () => {
    const memory = mountMemory({ maxEntryBytes: 8 })

    await expect(memory.save(project, { content: '   ' })).rejects.toThrow(/empty entry/)
    await expect(memory.save(project, { content: 'x'.repeat(9) })).rejects.toThrow(/above the 8-byte limit/)
  })

  it('refuses a write that would exceed the per-file or per-project limit', async () => {
    const perFile = mountMemory({ maxFileBytes: 24 })
    await expect(perFile.save(project, { content: 'x'.repeat(40) })).rejects.toThrow(/above the 24-byte file limit/)

    // 每条写入都带上标题与小节头，所以预算要给足第一条、卡住第二条。
    const perProject = mountMemory({ maxProjectBytes: 100 })
    await expect(perProject.save(project, { content: 'y'.repeat(20) })).resolves.toBeDefined()
    await expect(perProject.save(project, { content: 'y'.repeat(40), file: 'other.md' })).rejects.toThrow(/above the 100-byte limit/)
  })

  it('refuses a new file once the file-count limit is reached', async () => {
    const memory = mountMemory({ maxFiles: 1 })
    await memory.save(project, { content: '第一条' })

    await expect(memory.save(project, { content: '第二条', file: 'other.md' })).rejects.toThrow(/1-file limit/)
  })

  it('removes a section, then the whole file once it empties', async () => {
    const memory = mountMemory()
    await memory.save(project, { content: '第一条' })

    await expect(memory.remove(project, DEFAULT_MEMORY_FILE, '要点')).resolves.toBe(true)
    // 只剩标题的空壳文件同样算清空，删除后不应再出现在列表里。
    await expect(memory.read(project, DEFAULT_MEMORY_FILE)).resolves.toBeUndefined()
    await expect(memory.list(project)).resolves.toEqual([])
  })

  it('renders a bounded excerpt and reports what it left out', async () => {
    const memory = mountMemory({ injectBytes: 60 })
    await memory.save(project, { content: '第一条要点' })
    await memory.save(project, { content: 'z'.repeat(80), file: 'long.md' })

    const excerpt = await memory.excerpt(project)

    expect(excerpt.files).toContain(DEFAULT_MEMORY_FILE)
    expect(excerpt.truncated).toBe(true)
    expect(Buffer.byteLength(excerpt.text, 'utf8')).toBeLessThanOrEqual(80)
  })

  it('returns an empty excerpt without memory', async () => {
    const memory = mountMemory()

    await expect(memory.excerpt(project)).resolves.toMatchObject({ text: '', files: [] })
  })
})

describe('memory entry replacement', () => {
  const project: MemoryProject = { path: '/repo', key: 'k', directory: '/repo-memory' }

  /** 两小节各两条的记忆文件，覆盖「限定小节」与「续行条目」两种形态。 */
  function seededContent(): string {
    return '# app 记忆\n\n## 要点\n\n- 第一条\n- 第二条\n  续行\n\n## 决策\n\n- 第二条\n'
  }

  it('locates entries, their continuation lines, and honors the section filter', () => {
    const content = seededContent()

    expect(findMemoryEntries(content, '第一条')).toHaveLength(1)
    expect(findMemoryEntries(content, '第二条')).toHaveLength(2)
    expect(findMemoryEntries(content, '第二条', '要点')).toHaveLength(1)
    expect(findMemoryEntries(content, '第二条', '要点')?.[0]?.text).toBe('第二条\n续行')
    expect(findMemoryEntries(content, '不存在')).toEqual([])
    expect(findMemoryEntries(content, '第一条', '没有的小节')).toEqual([])
  })

  it('replaces one entry and leaves the rest of the file intact', async () => {
    const memory = mountMemory()
    await memory.save(project, { content: '旧约定：用 npm' })
    await memory.save(project, { content: '别的条目' })

    const updated = await memory.update(project, { match: '旧约定', content: '新约定：用 pnpm' })

    expect(updated.summary.name).toBe(DEFAULT_MEMORY_FILE)
    expect(updated.previous).toBe('旧约定：用 npm')
    const read = await memory.read(project, DEFAULT_MEMORY_FILE)
    expect(read?.content).toContain('- 新约定：用 pnpm')
    expect(read?.content).not.toContain('旧约定')
    expect(read?.content).toContain('- 别的条目')
  })

  it('rewrites a multi-line entry and keeps it as one bullet', async () => {
    const memory = mountMemory()
    await memory.save(project, { content: '标题\n正文' })

    await memory.update(project, { match: '标题', content: '改写标题\n改写正文' })

    const read = await memory.read(project, DEFAULT_MEMORY_FILE)
    expect(read?.content).toContain('- 改写标题\n  改写正文\n')
  })

  it('rejects missing, ambiguous, and empty matches', async () => {
    const memory = mountMemory()
    await memory.save(project, { content: '重复条目' })
    await memory.save(project, { content: '另一条重复条目' })

    await expect(memory.update(project, { match: '不存在', content: '新' })).rejects.toThrow(/no entry in notes\.md matches/)
    await expect(memory.update(project, { match: '重复条目', content: '新' })).rejects.toThrow(/2 entries in notes\.md match/)
    await expect(memory.update(project, { match: '  ', content: '新' })).rejects.toThrow(/refusing to update without a match/)
    await expect(memory.update(project, { match: '条目', content: '新', file: 'missing.md' }))
      .rejects.toThrow(/missing\.md does not exist/)
  })

  it('shares the entry, file, and project limits with save', async () => {
    const oversized = mountMemory({ maxEntryBytes: 8 })
    await expect(oversized.update(project, { match: 'x', content: 'y'.repeat(9) })).rejects.toThrow(/above the 8-byte limit/)

    const perFile = mountMemory({ maxFileBytes: 80 })
    await perFile.save(project, { content: 'x'.repeat(4) })
    await expect(perFile.update(project, { match: 'xxxx', content: 'y'.repeat(60) })).rejects.toThrow(/above the 80-byte file limit/)
  })

  it('replaces a located entry without touching surrounding lines', () => {
    const lines = ['# app 记忆', '', '## 要点', '', '- 保留', '- 替换我', '', '## 决策', '', '- 保留2', '']

    const next = replaceMemoryEntry(lines.join('\n'), { start: 5, end: 6, text: '替换我' }, '已替换\n两行')

    expect(next).toBe('# app 记忆\n\n## 要点\n\n- 保留\n- 已替换\n  两行\n\n## 决策\n\n- 保留2\n')
  })
})
