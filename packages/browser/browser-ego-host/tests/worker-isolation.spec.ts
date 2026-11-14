/** 两个真实画面 worker 使用不同状态目录时，后启动者不得终止先启动者。 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const WORKER = new URL('../bin/ego-cast-worker.mjs', import.meta.url)
const children: ChildProcess[] = []
const directories: string[] = []

/** 只停止本测试持有的子进程，绝不扫描或操作用户已有的浏览器进程。 */
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exit = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    child.kill('SIGTERM')
    await exit
  }
  children.length = 0
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
  directories.length = 0
})

async function startWorker(): Promise<{ child: ChildProcess; port: number }> {
  const directory = await mkdtemp(join(tmpdir(), 'coding-ego-worker-isolation-'))
  directories.push(directory)
  const child = spawn(process.execPath, [WORKER.pathname, JSON.stringify({ captureBackend: 'cdp' })], {
    env: { ...process.env, EGO_LINUX_STATE_DIR: directory, EGO_LINUX_CDP_URL: 'ws://127.0.0.1:1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  children.push(child)
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  let port = 0
  await vi.waitFor(async () => {
    const state = JSON.parse(await readFile(join(directory, 'ego-cast.json'), 'utf8')) as { pid: number; port: number }
    expect(child.exitCode, stderr).toBeNull()
    expect(state.pid).toBe(child.pid)
    port = state.port
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200)
  }, { interval: 100, timeout: 8000 })
  return { child, port }
}

it('后启动的隔离 worker 不影响其他状态目录的画面服务', async () => {
  const first = await startWorker()
  const second = await startWorker()
  expect(first.child.exitCode).toBeNull()
  expect(first.child.signalCode).toBeNull()
  expect((await fetch(`http://127.0.0.1:${first.port}/api/health`)).status).toBe(200)
  expect((await fetch(`http://127.0.0.1:${second.port}/api/health`)).status).toBe(200)
})
