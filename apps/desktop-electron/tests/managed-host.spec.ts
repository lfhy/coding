import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
import { ensureManagedHost } from '../src/managed-host.ts'

interface RecordShape {
  type: 'coding-host-ready'
  port: number
  pid: number
  version: 'dev'
  protocol: 1
  token: string
}

interface FakeChild extends EventEmitter {
  stdout: PassThrough & { unref: ReturnType<typeof vi.fn> }
  pid: number
  exitCode: number | null
  signalCode: string | null
  kill: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as ReturnType<typeof fakeChild>
  child.pid = process.pid
  child.exitCode = null
  child.signalCode = null
  child.stdout = Object.assign(new PassThrough(), { unref: vi.fn() })
  child.unref = vi.fn()
  child.kill = vi.fn((signal: string) => {
    child.signalCode = signal
    child.emit('exit', null, signal)
    return true
  })
  return child
}

describe('Electron managed Host', () => {
  let home: string
  let cwd: string
  let server: Server | undefined
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-electron-host-'))
    cwd = join(home, 'workspace')
    spawnMock.mockReset()
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await new Promise<void>((resolveClose) => {
      if (server) server.close(() => { resolveClose() })
      else resolveClose()
    })
    server = undefined
    await rm(home, { recursive: true, force: true })
  })

  async function endpoint(token = 'test-record-token'): Promise<RecordShape> {
    const listeningServer = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/api/host.describe') {
        response.writeHead(404).end()
        return
      }
      let body = ''
      request.on('data', (chunk) => { body += String(chunk) })
      request.on('end', () => {
        const payload = JSON.parse(body) as { rpcId: string; type: string; method: string; payload: object }
        expect(payload).toMatchObject({ type: 'client-request', method: 'host.describe', payload: {} })
        response.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ type: 'server-response', rpcId: payload.rpcId, result: { ok: true, value: { version: 'dev', managedHostToken: token } } }))
      })
    })
    server = listeningServer
    await new Promise<void>((resolveListen) => { listeningServer.listen(0, '127.0.0.1', resolveListen) })
    const address = listeningServer.address()
    if (typeof address !== 'object' || address === null) throw new Error('No server address')
    return { type: 'coding-host-ready', port: address.port, pid: process.pid, version: 'dev', protocol: 1, token: 'test-record-token' }
  }

  const options = (home: string, cwd: string, signal?: AbortSignal) => ({
    home,
    cwd,
    repoRoot: '/tmp/dsh-repository',
    nodePath: process.execPath,
    ...(signal ? { signal } : {}),
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink home before creating a lock or agents directory', async () => {
    const target = join(home, 'actual-home')
    const linkedHome = join(home, 'linked-home')
    await mkdir(target)
    await symlink(target, linkedHome, 'dir')

    await expect(ensureManagedHost(options(linkedHome, cwd))).rejects.toThrow('Managed Host home must not be a symbolic link')
    await expect(stat(join(target, 'host.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(target, 'agents'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('rejects an agents directory linked outside the private home', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-external-agents-'))
    try {
      await symlink(outside, join(home, 'agents'), 'dir')
      await expect(ensureManagedHost(options(home, cwd))).rejects.toThrow(
        'Managed Host agents directory must remain inside its home',
      )
      expect(spawnMock).not.toHaveBeenCalled()
      await expect(stat(join(outside, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a malformed live discovery record without starting or replacing a Host', async () => {
    const record = await endpoint()
    await writeFile(join(home, 'host.json'), JSON.stringify({ ...record, protocol: 7 }))
    await expect(ensureManagedHost(options(home, cwd))).rejects.toThrow('Unverified live Host discovery record')
    expect(spawnMock).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(home, 'host.json'), 'utf8'))).toMatchObject({ protocol: 7 })
  })

  it('refuses a live PID with a spoofed port response', async () => {
    const record = await endpoint('other-process-token')
    await writeFile(join(home, 'host.json'), JSON.stringify(record))
    await expect(ensureManagedHost(options(home, cwd))).rejects.toThrow('Unverified live Host discovery record')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('cancels an unready spawn and stops only its own child', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const aborter = new AbortController()
    const pending = ensureManagedHost(options(home, cwd, aborter.signal))
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalledOnce() })
    aborter.abort()
    await expect(pending).rejects.toThrow('Host launch cancelled')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('checks stdout, disk and RPC before returning, then reuses the surviving Host', async () => {
    vi.stubEnv('DSH_REMOTE_BRIDGE_URL', 'http://127.0.0.1:49152')
    vi.stubEnv('DSH_REMOTE_BRIDGE_TOKEN', 'old-wails-window-token')
    vi.stubEnv('DSH_AGENTS_HOME', '/tmp/ambient-agents-home')
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-only-inherited-key')
    const record = await endpoint()
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const pending = ensureManagedHost(options(home, cwd))
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalledOnce() })
    const [executable, args, settings] = spawnMock.mock.calls[0] as [string, string[], { cwd: string; env: NodeJS.ProcessEnv }]
    expect(executable).toBe(process.execPath)
    expect(args).toEqual(['--import', 'tsx/esm', '/tmp/dsh-repository/apps/cli/src/bin.ts', 'web', '--coding-host'])
    expect(settings.cwd).toBe('/tmp/dsh-repository')
    expect(settings.env).toMatchObject({
      DSH_HOME: home,
      DSH_CWD: cwd,
      DSH_APP_VERSION: 'dev',
      DSH_AGENTS_HOME: join(home, 'agents'),
      DEEPSEEK_API_KEY: 'test-only-inherited-key',
    })
    expect(settings.env).not.toHaveProperty('DSH_REMOTE_BRIDGE_URL')
    expect(settings.env).not.toHaveProperty('DSH_REMOTE_BRIDGE_TOKEN')
    const agentsDirectory = await stat(join(home, 'agents'))
    expect(agentsDirectory.isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(agentsDirectory.mode & 0o777).toBe(0o700)
    await writeFile(join(home, 'host.json'), `${JSON.stringify(record)}\n`)
    child.stdout.write(`${JSON.stringify(record)}\n`)
    expect(await pending).toEqual({ origin: `http://127.0.0.1:${record.port}` })
    expect(child.kill).not.toHaveBeenCalled()
    expect(child.unref).toHaveBeenCalledOnce()
    expect(await ensureManagedHost(options(home, cwd))).toEqual({ origin: `http://127.0.0.1:${record.port}` })
    expect(spawnMock).toHaveBeenCalledOnce()
  })

  it('rejects a new child whose stdout does not match the disk record', async () => {
    const record = await endpoint()
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const pending = ensureManagedHost(options(home, cwd))
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalledOnce() })
    await writeFile(join(home, 'host.json'), JSON.stringify({ ...record, token: 'different' }))
    child.stdout.write(`${JSON.stringify(record)}\n`)
    await expect(pending).rejects.toThrow('Host stdout and discovery record disagree')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('restarts after a stale record but rejects a different child PID', async () => {
    const record = await endpoint()
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    await writeFile(join(home, 'host.json'), JSON.stringify({ ...record, pid: 99_999_999, token: 'stale-token' }))
    const pending = ensureManagedHost(options(home, cwd))
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalledOnce() })
    child.stdout.write(`${JSON.stringify({ ...record, pid: 99_999_999 })}\n`)
    await expect(pending).rejects.toThrow('Invalid Host readiness record or PID')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
