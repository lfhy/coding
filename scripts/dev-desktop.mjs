/**
 * 将 Web watcher 与 Wails 开发进程分别托管；Wails 的 watcher 收尾存在状态竞争，
 * 因此不能让它持有会继续派生 tsc/tsx 的 pnpm 进程组。
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 检查开发进程组所需的平台支持，失败时不启动 watcher 或 Wails。
 * @param {NodeJS.Platform} platform - Node 识别的平台名称。
 * @returns {void}
 */
export function assertDesktopDevPlatform(platform = process.platform) {
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`make dev requires macOS or Linux process groups; unsupported platform: ${platform}`)
  }
}

/**
 * 启动桌面开发进程，并在任一进程退出或收到中断、挂断时清理整个 watcher 进程组。
 * @param {{ watcherCommand: string, watcherArgs: string[], wailsCommand: string, wailsArgs: string[], cwd: string, env: NodeJS.ProcessEnv }} options - 可执行文件、参数与工作目录。
 * @returns {Promise<number>} 开发进程的退出码；watcher 意外退出视为失败。
 */
export async function runDesktopDev(options) {
  assertDesktopDevPlatform()
  const watcher = spawn(options.watcherCommand, options.watcherArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    detached: true,
  })
  const watcherDone = childResult(watcher)
  let stopping = false
  let wails
  let wailsDone
  let forceWails

  function signalWatcher(signal) {
    if (watcher.pid === undefined) return
    try {
      // detached watcher 的 PID 就是 PGID；包括已脱离 pnpm 的 tsx/tsc 后代。
      process.kill(-watcher.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }

  function stop(signal) {
    if (stopping) return
    stopping = true
    signalWatcher('SIGTERM')
    if (wails?.pid !== undefined && wails.exitCode === null && wails.signalCode === null) {
      wails.kill(signal)
      forceWails = setTimeout(() => wails.kill('SIGKILL'), 10_000)
      forceWails.unref()
    }
  }

  let interrupted
  const onInterrupt = () => { interrupted = 'SIGINT'; stop('SIGINT') }
  const onTerminate = () => { interrupted = 'SIGTERM'; stop('SIGTERM') }
  const onHangup = () => { interrupted = 'SIGHUP'; stop('SIGTERM') }
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  process.on('SIGHUP', onHangup)
  try {
    wails = spawn(options.wailsCommand, options.wailsArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    })
    wailsDone = childResult(wails)

    const first = await Promise.race([
      watcherDone.then(result => ({ source: 'watcher', result })),
      wailsDone.then(result => ({ source: 'wails', result })),
    ])
    if (first.source === 'watcher' && !stopping) {
      console.error(`dev-desktop: Web watcher exited unexpectedly (${describeResult(first.result)})`)
      stop('SIGINT')
    }
    const wailsResult = await wailsDone
    stop('SIGTERM')
    // pnpm 可以在后代尚存时退出；等进程组清空后再允许 make 返回。
    await waitForWatcherGroup(watcher.pid, signalWatcher)
    await watcherDone
    if (interrupted === 'SIGINT') return 130
    if (interrupted === 'SIGTERM') return 143
    if (interrupted === 'SIGHUP') return 129
    if (first.source === 'watcher') return 1
    if (wailsResult.error !== undefined) {
      console.error(`dev-desktop: cannot start Wails: ${wailsResult.error.message}`)
      return 1
    }
    return wailsResult.code ?? (wailsResult.signal === null ? 1 : 128)
  } finally {
    if (forceWails !== undefined) clearTimeout(forceWails)
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
    process.off('SIGHUP', onHangup)
  }
}

function childResult(child) {
  return new Promise(resolve => {
    child.once('error', error => resolve({ error, code: null, signal: null }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

function describeResult(result) {
  return result.error?.message ?? (result.signal ?? `exit ${String(result.code)}`)
}

async function waitForWatcherGroup(pid, signalWatcher) {
  if (pid === undefined) return
  if (await waitUntilGroupGone(pid, 5_000)) return
  signalWatcher('SIGKILL')
  if (await waitUntilGroupGone(pid, 2_000)) return
  throw new Error(`dev-desktop: Web watcher process group ${pid} remains after SIGKILL`)
}

async function waitUntilGroupGone(pid, timeout) {
  const deadline = Date.now() + timeout
  do {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return true
      // macOS 在进程组最后的子进程待回收时可能暂时返回 EPERM。
      if (error.code !== 'EPERM') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  return false
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  if (process.argv[2] === '--check-platform') {
    assertDesktopDevPlatform()
  } else {
    process.exitCode = await runDesktopDev({
      watcherCommand: 'pnpm',
      watcherArgs: ['run', 'dev:web'],
      wailsCommand: join(repoRoot, '.dsh-build', 'wails'),
      wailsArgs: ['dev', '-tags', 'desktop', '-s', '-skipbindings', '-skipembedcreate', '-m', '-nosyncgomod'],
      cwd: join(repoRoot, 'apps', 'desktop'),
      env: { ...process.env, CGO_ENABLED: '1', CODING_REPO_ROOT: repoRoot },
    })
  }
}
