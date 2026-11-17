import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { REMOTE_WORKSPACE_MARKER, SubprocessRuntime } from 'coding-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec } from 'coding-subprocess'
import GitLocal from '../src/index.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 一次远端命令的脚本化答复：输出、标准错误与退出码。 */
interface Reply {
  stdout?: string
  stderr?: string
  code?: number | null
  /** 为真时 `done` 以传输失败 reject，模拟 bridge 断开。 */
  transportFailure?: boolean
}

/**
 * 记录远端 spawn 的 subprocess 替身。本机 `git` 绝不能被调用：用例在不存在仓库的
 * marker 目录里运行，任何本机执行都会以「不是仓库」失败而不是走到断言。
 */
class RecordingSubprocess extends SubprocessRuntime {
  readonly spawns: SubprocessSpawnSpec[] = []
  private readonly replies: Reply[] = []

  /** 追加一次远端命令的答复，按调用顺序消费。 */
  queue(...replies: Reply[]): void {
    this.replies.push(...replies)
  }

  override async resolveExecutable(command: string): Promise<string> { return command }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    const reply = this.replies.shift() ?? {}
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    const done = reply.transportFailure === true
      ? Promise.reject(new Error('bridge unavailable'))
      : Promise.resolve({ exitCode: reply.code ?? 0, signal: null })
    return {
      pid: 1,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: { stdout: reader(reply.stdout ?? ''), stderr: reader(reply.stderr ?? '') },
      done,
      terminate: () => {},
      waitForExit: async () => true,
    }
  }

  override async spawnTerminal(): Promise<never> {
    throw new Error('git never allocates a terminal')
  }
}

/** 建一个带 marker 的远端工作区占位目录。 */
function markerWorkspace(mode: 'basic' | 'agent' = 'agent'): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-remote-'))
  roots.push(root)
  writeFileSync(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
    version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode,
  }))
  return root
}

/** 启动带 subprocess 替身的 Git 服务。 */
async function gitService(): Promise<{ git: GitLocal; subprocess: RecordingSubprocess; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(RecordingSubprocess)
  await ctx.plugin(GitLocal)
  return {
    git: ctx.get('git') as GitLocal,
    subprocess: ctx.subprocess as RecordingSubprocess,
    dispose: () => ctx.fiber.dispose(),
  }
}

const signal = new AbortController().signal

describe('remote workspace Git routing', () => {
  it('reads status through the subprocess seam instead of local git', async () => {
    const { git, subprocess, dispose } = await gitService()
    const cwd = markerWorkspace()
    subprocess.queue(
      { stdout: 'true\n' }, // rev-parse --is-inside-work-tree
      { stdout: 'main\n' }, // symbolic-ref --short HEAD
      { stdout: ' M src/app.ts\0?? notes.md\0' }, // status --porcelain
      { stdout: '/srv/project\n' }, // rev-parse --show-toplevel
      { stdout: '' }, // rev-parse --verify HEAD
      { stdout: '3\t1\tsrc/app.ts\0' }, // diff HEAD --numstat
      { stdout: '', code: 128 }, // rev-parse @{upstream}: 没有上游
    )
    try {
      const status = await git.status(cwd, signal)

      expect(status).toMatchObject({ branch: 'main', ahead: 0, behind: 0, additions: 3, deletions: 1 })
      expect(status?.files.map(file => file.path)).toEqual(['src/app.ts', 'notes.md'])
      // 未跟踪文件的行数在远端工作区不统计（宿主读不到远端内容）。
      expect(status?.files[1]?.additions).toBe(0)
      expect(subprocess.spawns).toHaveLength(7)
      expect(subprocess.spawns[0]?.argv.slice(0, 2)).toEqual(['git', '--no-pager'])
      expect(subprocess.spawns[0]?.cwd).toBe(cwd)
      expect(subprocess.spawns[0]?.env).toMatchObject({ LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' })
      // 宿主的进程环境绝不转发给远端命令。
      expect(subprocess.spawns[0]?.env?.PATH).toBeUndefined()
      expect(subprocess.spawns[0]?.env?.HOME).toBeUndefined()
    } finally {
      await dispose()
    }
  })

  it('reports a workspace without a repository as empty status', async () => {
    const { git, subprocess, dispose } = await gitService()
    const cwd = markerWorkspace('basic')
    subprocess.queue({ stdout: '', stderr: 'fatal: not a git repository\n', code: 128 })
    try {
      expect(await git.status(cwd, signal)).toBeNull()
      expect(subprocess.spawns).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  it('reports a remote host without git as GIT_UNAVAILABLE', async () => {
    const { git, subprocess, dispose } = await gitService()
    const cwd = markerWorkspace()
    subprocess.queue({ stdout: '', stderr: 'bash: git: command not found\n', code: 127 })
    try {
      await expect(git.status(cwd, signal)).rejects.toMatchObject({ code: 'GIT_UNAVAILABLE' })
    } finally {
      await dispose()
    }
  })

  it('refuses credentials entered on this machine and keeps them off the remote command', async () => {
    const { git, subprocess, dispose } = await gitService()
    const cwd = markerWorkspace()
    try {
      await expect(git.push(cwd, signal, { credentials: { username: 'me', password: 'secret' } }))
        .rejects.toMatchObject({ code: 'GIT_REMOTE_UNAVAILABLE' })
      expect(subprocess.spawns).toHaveLength(0)
    } finally {
      await dispose()
    }
  })

  it('maps a remote authentication failure to an environment diagnostic', async () => {
    const { git, subprocess, dispose } = await gitService()
    const cwd = markerWorkspace()
    subprocess.queue(
      { stdout: 'true\n' }, // guard
      { stdout: 'main\n' }, // symbolic-ref
      { stdout: 'origin/main\n' }, // rev-parse @{upstream}
      { stdout: 'https://example.com/repo.git\n' }, // remote get-url
      { stdout: 'https://example.com/repo.git\n' }, // remote get-url --push
      { stderr: 'fatal: could not read Username for https://example.com', code: 128 }, // pull
    )
    try {
      const failure = await git.pull(cwd, signal).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'GIT_REMOTE_UNAVAILABLE' })
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('https://example.com')
      // 远端命令保留远端主机自己的凭据助手，宿主那侧不注入 askpass 套接字。
      expect(subprocess.spawns.at(-1)?.env?.DSH_GIT_ASKPASS_SOCKET).toBeUndefined()
      expect(subprocess.spawns.at(-1)?.env?.GIT_CONFIG_COUNT).toBe('1')
    } finally {
      await dispose()
    }
  })

  it('surfaces a broken bridge instead of falling back to a local command', async () => {
    const { git, subprocess, dispose } = await gitService()
    const cwd = markerWorkspace()
    subprocess.queue({ transportFailure: true })
    try {
      await expect(git.status(cwd, signal)).rejects.toMatchObject({ code: 'GIT_FAILED' })
      expect(subprocess.spawns).toHaveLength(1)
    } finally {
      await dispose()
    }
  })
})
