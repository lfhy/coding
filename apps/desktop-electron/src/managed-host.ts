/** Electron 开发壳的受管 Host 发现与启动。Host 就绪后独立存活。 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open, readFile, mkdir, rm, stat, lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'

type HostChild = ChildProcessByStdio<null, Readable, null>

interface HostRecord {
  type: 'coding-host-ready'
  port: number
  pid: number
  version: 'dev'
  protocol: 1
  token: string
}

export interface ManagedHostOptions {
  home: string
  cwd: string
  repoRoot: string
  signal?: AbortSignal
  /** Electron 可执行文件不能运行 Node 的 tsx 入口；默认从 PATH 查找 node。 */
  nodePath?: string
}

const POLL_MS = 100
const LOCK_TIMEOUT_MS = 30_000
const STARTUP_TIMEOUT_MS = 45_000
const PROBE_TIMEOUT_MS = 2_000

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function validRecord(value: unknown): value is HostRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.type === 'coding-host-ready'
    && Number.isSafeInteger(record.port) && (record.port as number) >= 1 && (record.port as number) <= 65535
    && Number.isSafeInteger(record.pid) && (record.pid as number) >= 1
    && record.version === 'dev' && record.protocol === 1
    && typeof record.token === 'string' && record.token.length > 0
}

function origin(record: HostRecord): string {
  return `http://127.0.0.1:${record.port}`
}

function sameRecord(left: HostRecord, right: HostRecord): boolean {
  return left.port === right.port && left.pid === right.pid && left.token === right.token
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Host launch cancelled')
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePause, reject) => {
    if (signal?.aborted) {
      reject(new Error('Host launch cancelled'))
      return
    }
    const timer = setTimeout(finish, ms)
    function finish(): void {
      signal?.removeEventListener('abort', cancel)
      resolvePause()
    }
    function cancel(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      reject(new Error('Host launch cancelled'))
    }
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

/** 锁的 PID 只用于回收崩溃后的残留；未知持有者必须等待，不能擅自删除。 */
async function withLock<T>(home: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  const path = join(home, 'host.lock')
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let handle: Awaited<ReturnType<typeof open>>
  while (true) {
    aborted(signal)
    try {
      handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(`${process.pid}\n`)
      } catch (error) {
        await handle.close()
        await rm(path, { force: true })
        throw error
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let owner: number | undefined
    try {
      owner = Number((await readFile(path, 'utf8')).split('\n', 1)[0])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (Number.isSafeInteger(owner) && owner > 0 && !alive(owner)) {
      // 再读一次可避免删除刚好被别的启动器重建的锁。
      const latest = Number((await readFile(path, 'utf8').catch(() => '')).split('\n', 1)[0])
      if (latest === owner) await rm(path, { force: true })
      continue
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Host launch lock')
    await pause(POLL_MS, signal)
  }
  try {
    return await action()
  } finally {
    const identity = await handle.stat().catch(() => undefined)
    await handle.close()
    const current = await stat(path).catch(() => undefined)
    if (identity && current && identity.dev === current.dev && identity.ino === current.ino) {
      await rm(path, { force: true })
    }
  }
}

async function probe(record: HostRecord, signal?: AbortSignal): Promise<boolean> {
  const rpcId = randomUUID()
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const response = await fetch(`${origin(record)}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'host.describe', payload: {} }),
      signal: combined,
    })
    if (response.status !== 200) return false
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return false
    const envelope = body as {
      type?: unknown
      rpcId?: unknown
      result?: { ok?: unknown; value?: { version?: unknown; managedHostToken?: unknown } }
    }
    return envelope.type === 'server-response' && envelope.rpcId === rpcId
      && envelope.result?.ok === true && envelope.result.value?.version === record.version
      && envelope.result.value.managedHostToken === record.token
  } catch {
    return false
  }
}

async function readRecord(path: string): Promise<{ exists: false } | { exists: true; value: unknown }> {
  try {
    return { exists: true, value: JSON.parse(await readFile(path, 'utf8')) as unknown }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    // 损坏的记录不可证明没有活跃 Host，不能在它上面启动第二个进程。
    throw new Error('Unverified Host discovery record', { cause: error })
  }
}

async function discover(path: string, signal?: AbortSignal): Promise<HostRecord | undefined> {
  const disk = await readRecord(path)
  if (!disk.exists) return undefined
  if (!validRecord(disk.value)) {
    const pid = (disk.value as { pid?: unknown } | null)?.pid
    if (typeof pid === 'number' && !alive(pid)) return undefined
    throw new Error('Unverified live Host discovery record')
  }
  const running = alive(disk.value.pid)
  const responsive = await probe(disk.value, signal)
  aborted(signal)
  if (running !== responsive || (running && !responsive)) {
    throw new Error('Unverified live Host discovery record')
  }
  return running ? disk.value : undefined
}

function waitForReady(child: HostChild, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolveReady, reject) => {
    let buffer = ''
    let settled = false
    const finish = (error?: Error, record?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.stdout.removeListener('data', onData)
      child.stdout.removeListener('error', onError)
      child.stdout.removeListener('end', onEnd)
      if (error) reject(error)
      else resolveReady(record)
    }
    const onAbort = (): void => { finish(new Error('Host launch cancelled')) }
    const onError = (error: Error): void => { finish(error) }
    const onExit = (): void => { finish(new Error('Host exited before readiness')) }
    const onEnd = (): void => { finish(new Error('Host stdout ended before readiness')) }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 1_000_000) {
        finish(new Error('Host readiness line too long'))
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const value: unknown = JSON.parse(line)
          if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'coding-host-ready') {
            finish(undefined, value)
            return
          }
        } catch { /* 其余输出既不是协议，也不需要回显。 */ }
        newline = buffer.indexOf('\n')
      }
    }
    const timer = setTimeout(() => { finish(new Error('Host readiness timed out')) }, STARTUP_TIMEOUT_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', onError)
    child.on('exit', onExit)
    child.stdout.on('data', onData)
    child.stdout.on('error', onError)
    child.stdout.on('end', onEnd)
    if (signal?.aborted) onAbort()
  })
}

async function stopOwnChild(child: HostChild): Promise<void> {
  if (child.pid === undefined) return
  const running = (): boolean => child.exitCode === null && child.signalCode === null
  if (!running()) return
  const waitForExit = (timeoutMs: number): Promise<void> => new Promise((resolveExit) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolveExit()
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolveExit()
    }, timeoutMs)
    child.once('exit', onExit)
  })
  child.kill('SIGTERM')
  if (running()) await waitForExit(1_000)
  if (running()) {
    child.kill('SIGKILL')
    if (running()) await waitForExit(1_000)
  }
}

/**
 * 复用已认证的本地 Host，否则在跨进程锁内启动独立的开发 Host。
 * @param options - 隔离 home、workspace、源码根和可选取消信号。
 * @returns 只含回环地址，不向渲染进程暴露记录 token。
 */
export async function ensureManagedHost(options: ManagedHostOptions): Promise<{ origin: string }> {
  const home = resolve(options.home)
  const cwd = resolve(options.cwd)
  const repoRoot = resolve(options.repoRoot)
  if (cwd === repoRoot) throw new Error('Managed Host workspace must be separate from the repository')
  if (options.nodePath !== undefined && options.nodePath.length === 0) throw new Error('Empty Node executable path')
  aborted(options.signal)
  await mkdir(home, { recursive: true, mode: 0o700 })
  if ((await lstat(home)).isSymbolicLink()) throw new Error('Managed Host home must not be a symbolic link')
  return withLock(home, options.signal, async () => {
    const path = join(home, 'host.json')
    const existing = await discover(path, options.signal)
    if (existing) return { origin: origin(existing) }
    aborted(options.signal)
    const agentsHome = join(home, 'agents')
    await mkdir(agentsHome, { recursive: true, mode: 0o700 })
    if ((await lstat(agentsHome)).isSymbolicLink()
      || await realpath(agentsHome) !== join(await realpath(home), 'agents')) {
      throw new Error('Managed Host agents directory must remain inside its home')
    }
    // Go 桌面壳的桥接能力只属于原窗口；Electron Host 不得继承它们。
    const environment = { ...process.env }
    delete environment.DSH_REMOTE_BRIDGE_URL
    delete environment.DSH_REMOTE_BRIDGE_TOKEN
    environment.DSH_HOME = home
    environment.DSH_CWD = cwd
    environment.DSH_APP_VERSION = 'dev'
    environment.DSH_AGENTS_HOME = agentsHome
    const child = spawn(options.nodePath ?? 'node', [
      '--import', 'tsx/esm', join(repoRoot, 'apps/cli/src/bin.ts'), 'web', '--coding-host',
    ], {
      cwd: repoRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    try {
      const announced = await waitForReady(child, options.signal)
      if (!validRecord(announced) || announced.pid !== child.pid) throw new Error('Invalid Host readiness record or PID')
      const disk = await readRecord(path)
      if (!disk.exists || !validRecord(disk.value) || !sameRecord(disk.value, announced)) {
        throw new Error('Host stdout and discovery record disagree')
      }
      if (!alive(announced.pid) || !await probe(announced, options.signal)) throw new Error('Host readiness probe failed')
      aborted(options.signal)
      // 只放开父进程的事件循环；管道继续排空，关窗时不终止 Host。
      child.stdout.on('error', () => {})
      child.on('error', () => {})
      child.stdout.resume()
      const stdout = child.stdout as Readable & { unref?: () => void }
      stdout.unref?.()
      child.unref()
      return { origin: origin(announced) }
    } catch (error) {
      await stopOwnChild(child)
      throw error
    }
  })
}
