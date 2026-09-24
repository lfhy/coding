import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./dev-desktop.mjs', import.meta.url))
interface Fixture {
  directory: string
  pidFile: string
  runner: ReturnType<typeof spawn>
  result: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  stderr: () => string
}
const fixtures: Fixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    try {
      if (fixture.runner.exitCode === null && fixture.runner.signalCode === null) {
        fixture.runner.kill('SIGINT')
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            fixture.result,
            new Promise((resolve) => { timer = setTimeout(resolve, 2_000) }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
        if (fixture.runner.exitCode === null && fixture.runner.signalCode === null) fixture.runner.kill('SIGKILL')
      }
      if (existsSync(fixture.pidFile)) {
        const [watcherPid] = readPids(fixture.pidFile)
        if (groupExists(watcherPid)) {
          try {
            process.kill(-watcherPid, 'SIGKILL')
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== 'ESRCH' && code !== 'EPERM') throw error
          }
        }
        await until(() => !groupExists(watcherPid), 2_000)
      }
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  }
})

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function readPids(path: string): [number, number] {
  const match = /^(\d+),(\d+)$/.exec(readFileSync(path, 'utf8'))
  if (match === null) throw new Error('invalid watcher fixture PID record')
  return [Number(match[1]), Number(match[2])]
}

async function until(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for desktop dev process')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

function startFixture(wailsSource: string, ignoreTermination = false) {
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-desktop-dev-'))
  const pidFile = join(fixture, 'watcher-pid')
  const watcherSource = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(`${ignoreTermination ? "process.on('SIGTERM', () => {});" : ''}setInterval(() => {}, 1000)`)}], { stdio: 'ignore' });
    writeFileSync(process.env.DSH_TEST_WATCHER_PID, String(process.pid) + ',' + String(child.pid));
    ${ignoreTermination ? "process.on('SIGTERM', () => {});" : ''}
    setInterval(() => {}, 1000);
  `
  const options = {
    watcherCommand: process.execPath,
    watcherArgs: ['-e', watcherSource],
    wailsCommand: process.execPath,
    wailsArgs: ['-e', wailsSource],
    cwd: fixture,
    env: process.env,
  }
  const runner = spawn(process.execPath, [
    '--input-type=module', '-e',
    `import { runDesktopDev } from ${JSON.stringify(pathToFileURL(script).href)}; process.exitCode = await runDesktopDev(${JSON.stringify(options)})`,
  ], {
    cwd: fixture,
    env: { ...process.env, DSH_TEST_WATCHER_PID: pidFile },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  runner.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    runner.once('error', reject)
    runner.once('exit', (code, signal) => { resolve({ code, signal }) })
  })
  const record = { directory: fixture, pidFile, runner, result, stderr: () => stderr }
  fixtures.push(record)
  return record
}

describe('make dev watcher lifecycle', () => {
  it('rejects Windows before starting a detached watcher', () => {
    const result = spawnSync(process.execPath, [
      '--input-type=module', '-e',
      `import { assertDesktopDevPlatform } from ${JSON.stringify(pathToFileURL(script).href)}; assertDesktopDevPlatform('win32')`,
    ], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unsupported platform: win32')
  })

  describe.skipIf(process.platform === 'win32')('POSIX process groups', () => {
    it('cleans pnpm-like descendants when Wails exits', async () => {
      const fixture = startFixture('setTimeout(() => process.exit(0), 500)')
      await until(() => existsSync(fixture.pidFile))
      const [watcherPid, descendantPid] = readPids(fixture.pidFile)
      expect(groupExists(watcherPid)).toBe(true)
      expect((await fixture.result).code, fixture.stderr()).toBe(0)
      await until(() => !groupExists(watcherPid))
      expect(() => process.kill(descendantPid, 0)).toThrow()
    }, 15_000)

    it.each([['SIGINT', 130], ['SIGHUP', 129]] as const)('cleans pnpm-like descendants on %s', async (signal, exitCode) => {
      const fixture = startFixture('setInterval(() => {}, 1000)')
      await until(() => existsSync(fixture.pidFile))
      const [watcherPid, descendantPid] = readPids(fixture.pidFile)
      fixture.runner.kill(signal)
      expect((await fixture.result).code, fixture.stderr()).toBe(exitCode)
      await until(() => !groupExists(watcherPid))
      expect(() => process.kill(descendantPid, 0)).toThrow()
    }, 15_000)

    it('waits for the process group after escalating to SIGKILL', async () => {
      const fixture = startFixture('setTimeout(() => process.exit(0), 500)', true)
      await until(() => existsSync(fixture.pidFile))
      const [watcherPid, descendantPid] = readPids(fixture.pidFile)
      expect((await fixture.result).code).toBe(0)
      expect(groupExists(watcherPid)).toBe(false)
      expect(() => process.kill(descendantPid, 0)).toThrow()
    }, 15_000)
  })
})
