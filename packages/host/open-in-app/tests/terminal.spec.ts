/** 用户终端 query/frame、Shell 选择和 WebSocket 生命周期测试。 */

import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { REMOTE_WORKSPACE_MARKER } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessOutcome,
  SubprocessRuntime,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import WebSocket, { type RawData } from 'ws'
import {
  OpenInAppTerminalGateway,
  parseTerminalClientFrame,
  parseTerminalClientMessage,
  parseTerminalUpgradeUrl,
  resolveTerminalShell,
  TERMINAL_SHELL_CANDIDATES,
} from '../src/terminal.ts'

interface GatewayFixture {
  readonly gateway: OpenInAppTerminalGateway
  readonly subprocess: SubprocessRuntime
  readonly resolveExecutable: ReturnType<typeof vi.fn<(name: string) => Promise<string>>>
  readonly spawnTerminal: ReturnType<typeof vi.fn<(spec: SubprocessTerminalSpawnSpec) => Promise<SubprocessTerminalHandle>>>
  readonly session: { readonly header: { readonly cwd?: string } }
  readonly agents: Map<string, object>
  readonly sessions: Map<string, object>
  readonly trust: { rejection: 401 | 403 | undefined; available: boolean }
  readonly warnings: unknown[]
}

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  const pending = cleanup.splice(0).reverse()
  await Promise.allSettled(pending.map(close => close()))
})

function terminalFixture(terminateError?: Error) {
  const output = new PassThrough()
  const done = Promise.withResolvers<SubprocessOutcome>()
  let settled = false
  const resolve = (outcome: SubprocessOutcome): void => {
    if (settled) return
    settled = true
    output.end()
    done.resolve(outcome)
  }
  const reject = (error: unknown): void => {
    if (settled) return
    settled = true
    output.destroy()
    done.reject(error)
  }
  const write = vi.fn(async () => {})
  const resize = vi.fn(async () => {})
  const terminate = vi.fn(async () => {
    resolve({ exitCode: null, signal: 'SIGTERM' })
    if (terminateError !== undefined) throw terminateError
  })
  return {
    output,
    resolve,
    reject,
    write,
    resize,
    terminate,
    handle: {
      pid: 42,
      output,
      done: done.promise,
      write,
      resize,
      inspectForeground: vi.fn(),
      signalForeground: vi.fn(),
      terminate,
    },
  }
}

function gatewayFixture(
  terminal: ReturnType<typeof terminalFixture>,
  options: { readonly cwd?: string; readonly spawn?: (spec: SubprocessTerminalSpawnSpec) => Promise<SubprocessTerminalHandle> } = {},
): GatewayFixture {
  const session = { header: { ...options.cwd === undefined ? { cwd: '/workspace' } : { cwd: options.cwd } } }
  const sessions = new Map<string, object>([['session', session]])
  const agents = new Map<string, object>()
  const trust = { rejection: undefined as 401 | 403 | undefined, available: true }
  const warnings: unknown[] = []
  const resolveExecutable = vi.fn(async (name: string) => `/resolved/${name}`)
  const spawnTerminal = vi.fn(options.spawn ?? (async () => terminal.handle))
  const subprocess = {
    resolveExecutable,
    spawnTerminal,
  } as unknown as SubprocessRuntime
  const agentCtx = { get: (name: string) => name === 'subprocess' ? subprocess : undefined }
  const agent = { session, ctx: agentCtx }
  agents.set('session', agent)
  const ctx = {
    sessions: { get: (id: string) => sessions.get(id) },
    agents: { get: (id: string) => agents.get(id) },
    get: (name: string) => name === 'connection' && trust.available
      ? { requestRejection: () => trust.rejection }
      : undefined,
    logger: { warn: (value: unknown) => { warnings.push(value) } },
  } as unknown as Context
  return {
    gateway: new OpenInAppTerminalGateway(ctx),
    subprocess,
    resolveExecutable,
    spawnTerminal,
    session,
    agents,
    sessions,
    trust,
    warnings,
  }
}

async function serve(gateway: OpenInAppTerminalGateway): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const server = createServer()
  server.on('upgrade', (request, socket, head) => { gateway.handle(request, socket, head) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `ws://127.0.0.1:${String(port)}`,
    close: async () => {
      await gateway.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    },
  }
}

function messageText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return once(socket, 'message').then(([data]) => JSON.parse(messageText(data as RawData)) as Record<string, unknown>)
}

function frameReader(socket: WebSocket): () => Promise<Record<string, unknown>> {
  const queued: Record<string, unknown>[] = []
  const waiting: ((frame: Record<string, unknown>) => void)[] = []
  socket.on('message', (data) => {
    const frame = JSON.parse(messageText(data)) as Record<string, unknown>
    const resolve = waiting.shift()
    if (resolve === undefined) queued.push(frame)
    else resolve(frame)
  })
  return () => {
    const frame = queued.shift()
    if (frame !== undefined) return Promise.resolve(frame)
    return new Promise((resolve) => { waiting.push(resolve) })
  }
}

function unexpectedStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0
      response.resume()
      resolve(status)
    })
    socket.once('open', () => {
      socket.terminate()
      reject(new Error('upgrade unexpectedly succeeded'))
    })
    socket.once('error', () => { /* unexpected-response owns the status assertion. */ })
  })
}

describe('terminal wire parsers', () => {
  it('accepts one exact bounded query and rejects missing, duplicate, extra, or noncanonical values', () => {
    expect(parseTerminalUpgradeUrl('/open-in-app/terminal?sessionId=s&cols=80&rows=24'))
      .toEqual({ sessionId: 's', cols: 80, rows: 24 })
    const invalid = [
      undefined,
      'http://[',
      '/open-in-app/terminal?sessionId=s&cols=80',
      '/open-in-app/terminal?sessionId=s&cols=80&rows=24&extra=1',
      '/open-in-app/terminal?sessionId=s&sessionId=t&cols=80&rows=24',
      '/open-in-app/terminal?sessionId=s&cols=80&cols=81',
      '/open-in-app/terminal?sessionId=&cols=80&rows=24',
      `/open-in-app/terminal?sessionId=${encodeURIComponent('x\0y')}&cols=80&rows=24`,
      `/open-in-app/terminal?sessionId=${'x'.repeat(1025)}&cols=80&rows=24`,
      '/open-in-app/terminal?sessionId=s&cols=01&rows=24',
      '/open-in-app/terminal?sessionId=s&cols=1&rows=24',
      '/open-in-app/terminal?sessionId=s&cols=501&rows=24',
      '/open-in-app/terminal?sessionId=s&cols=80&rows=0',
      '/open-in-app/terminal?sessionId=s&cols=80&rows=201',
      `/open-in-app/terminal?sessionId=s&cols=${String(Number.MAX_SAFE_INTEGER)}0&rows=24`,
    ]
    for (const value of invalid) expect(parseTerminalUpgradeUrl(value)).toBeUndefined()
  })

  it('accepts only closed input, resize, and close frames within limits', () => {
    expect(parseTerminalClientFrame({ type: 'input', data: 'ls\r' }))
      .toEqual({ ok: true, frame: { type: 'input', data: 'ls\r' } })
    expect(parseTerminalClientFrame({ type: 'resize', cols: 120, rows: 40 }))
      .toEqual({ ok: true, frame: { type: 'resize', cols: 120, rows: 40 } })
    expect(parseTerminalClientFrame({ type: 'close' }))
      .toEqual({ ok: true, frame: { type: 'close' } })
    for (const value of [
      null,
      {},
      { type: 1 },
      { type: 'input', data: 1 },
      { type: 'input', data: '', extra: true },
      { type: 'input', data: 'x'.repeat(65_537) },
      { type: 'resize', cols: 1, rows: 24 },
      { type: 'resize', cols: 80, rows: 201 },
      { type: 'resize', cols: 80, rows: 24, extra: true },
      { type: 'close', extra: true },
      { type: 'unknown' },
    ]) expect(parseTerminalClientFrame(value).ok).toBe(false)
  })

  it('rejects binary, oversized, malformed UTF-8 and malformed JSON messages', () => {
    expect(parseTerminalClientMessage(Buffer.from('{}'), true).ok).toBe(false)
    expect(parseTerminalClientMessage(Buffer.alloc(68 * 1024 + 1), false).ok).toBe(false)
    expect(parseTerminalClientMessage(Buffer.from([0xff]), false).ok).toBe(false)
    expect(parseTerminalClientMessage(Buffer.from('{'), false).ok).toBe(false)
    expect(parseTerminalClientMessage(Buffer.from('{"type":"close"}'), false).ok).toBe(true)
    const arrayBuffer = Uint8Array.from(Buffer.from('{"type":"close"}')).buffer
    expect(parseTerminalClientMessage(arrayBuffer, false).ok).toBe(true)
    expect(parseTerminalClientMessage([Buffer.from('{"type":'), Buffer.from('"close"}')], false).ok).toBe(true)
  })
})

describe('terminal shell selection', () => {
  it('probes in order and gives POSIX, PowerShell, and cmd their native interactive arguments', async () => {
    expect(TERMINAL_SHELL_CANDIDATES).toEqual(['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd'])
    const calls: string[] = []
    const provider = {
      resolveExecutable: vi.fn(async (name: string) => {
        calls.push(name)
        if (name !== 'pwsh') throw new Error('missing')
        return String.raw`C:\Program Files\PowerShell\pwsh.exe`
      }),
    } as unknown as SubprocessRuntime
    await expect(resolveTerminalShell(provider, '/tmp', new AbortController().signal)).resolves.toEqual({
      path: String.raw`C:\Program Files\PowerShell\pwsh.exe`, name: 'pwsh', args: ['-NoLogo'],
    })
    expect(calls).toEqual(['zsh', 'bash', 'fish', 'pwsh'])

    const posix = { resolveExecutable: vi.fn(async () => '/bin/zsh') } as unknown as SubprocessRuntime
    await expect(resolveTerminalShell(posix, '/tmp', new AbortController().signal))
      .resolves.toEqual({ path: '/bin/zsh', name: 'zsh', args: ['-i'] })

    const cmd = {
      resolveExecutable: vi.fn(async (name: string) => {
        if (name !== 'cmd') throw new Error('missing')
        return String.raw`C:\Windows\System32\cmd.exe`
      }),
    } as unknown as SubprocessRuntime
    await expect(resolveTerminalShell(cmd, '/tmp', new AbortController().signal)).resolves.toEqual({
      path: String.raw`C:\Windows\System32\cmd.exe`, name: 'cmd', args: [],
    })
  })

  it('passes a verified Remote-SSH identity and stops on cancellation or total absence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-terminal-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 2, remoteRoot: String.raw`C:\repo`, connectionId: 'remote-1', generation: 2,
    }))
    let remote: unknown
    const provider = {
      resolveExecutable: vi.fn(async (_name: string, _env: unknown, _signal: unknown, target: unknown) => {
        remote = target
        return '/usr/bin/zsh'
      }),
    } as unknown as SubprocessRuntime
    await resolveTerminalShell(provider, root, new AbortController().signal)
    expect(remote).toMatchObject({
      markerRoot: await realpath(root), remoteRoot: String.raw`C:\repo`, remotePath: String.raw`C:\repo`,
    })

    const absent = { resolveExecutable: vi.fn(async () => { throw new Error('missing') }) } as unknown as SubprocessRuntime
    await expect(resolveTerminalShell(absent, '/tmp', new AbortController().signal))
      .rejects.toThrow('no supported interactive shell')

    const abort = new AbortController()
    abort.abort(new Error('closed'))
    await expect(resolveTerminalShell(absent, '/tmp', abort.signal)).rejects.toThrow('aborted')
  })
})

describe('terminal WebSocket gateway', () => {
  it('rejects untrusted, malformed, missing, mismatched, cwd-less, and provider-less upgrades before negotiation', async () => {
    const terminal = terminalFixture()
    const fixture = gatewayFixture(terminal)
    const host = await serve(fixture.gateway)
    cleanup.push(() => host.close())
    const url = (query: string): string => `${host.origin}/open-in-app/terminal?${query}`

    fixture.trust.rejection = 401
    expect(await unexpectedStatus(url('sessionId=session&cols=80&rows=24'))).toBe(401)
    fixture.trust.rejection = 403
    expect(await unexpectedStatus(url('sessionId=session&cols=80&rows=24'))).toBe(403)
    fixture.trust.rejection = undefined
    fixture.trust.available = false
    expect(await unexpectedStatus(url('sessionId=session&cols=80&rows=24'))).toBe(503)
    fixture.trust.available = true
    expect(await unexpectedStatus(url('sessionId=session&cols=1&rows=24'))).toBe(400)
    expect(await unexpectedStatus(url('sessionId=missing&cols=80&rows=24'))).toBe(404)

    fixture.agents.set('session', { session: {}, ctx: { get: () => fixture.subprocess } })
    expect(await unexpectedStatus(url('sessionId=session&cols=80&rows=24'))).toBe(404)
    const noCwd = { header: {} }
    fixture.sessions.set('session', noCwd)
    fixture.agents.set('session', { session: noCwd, ctx: { get: () => fixture.subprocess } })
    expect(await unexpectedStatus(url('sessionId=session&cols=80&rows=24'))).toBe(409)
    const session = { header: { cwd: '/workspace' } }
    fixture.sessions.set('session', session)
    fixture.agents.set('session', { session, ctx: { get: () => undefined } })
    expect(await unexpectedStatus(url('sessionId=session&cols=80&rows=24'))).toBe(503)
  })

  it('streams bounded output, applies ordered input/resize, reports exit, and terminates the PTY', async () => {
    const terminal = terminalFixture()
    const fixture = gatewayFixture(terminal)
    const host = await serve(fixture.gateway)
    cleanup.push(() => host.close())
    const socket = new WebSocket(`${host.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`)
    const read = frameReader(socket)
    const ready = await read()
    expect(ready).toMatchObject({
      type: 'ready', pid: 42, shell: { name: 'zsh', path: '/resolved/zsh' }, cwd: '/workspace', cols: 80, rows: 24,
    })
    expect(fixture.spawnTerminal.mock.calls).toEqual([[expect.objectContaining({
      argv: ['/resolved/zsh', '-i'], cwd: '/workspace', cols: 80, rows: 24,
      env: { DSH_SESSION_ID: 'session', TERM: 'xterm-256color' },
    })]])
    expect(fixture.warnings).toEqual([])
    expect(terminal.terminate.mock.calls).toHaveLength(0)
    expect(socket.readyState).toBe(WebSocket.OPEN)

    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify({ type: 'input', data: 'echo hi\r' }), (error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    })
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }), (error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    })
    await vi.waitFor(() => {
      expect(terminal.write.mock.calls).toEqual([['echo hi\r']])
      expect(terminal.resize.mock.calls).toEqual([[120, 40]])
    })

    terminal.output.write('x'.repeat(64 * 1024 + 1))
    expect((await read()).data).toHaveLength(64 * 1024)
    expect((await read()).data).toBe('x')
    const closed = once(socket, 'close')
    terminal.resolve({ exitCode: 0, signal: null })
    expect(await read()).toEqual({ type: 'exit', exitCode: 0, signal: null })
    await closed
    await vi.waitFor(() => { expect(terminal.terminate.mock.calls).toHaveLength(1) })
  })

  it('keeps simultaneous connections for one Session on separate PTYs', async () => {
    const first = terminalFixture()
    const second = terminalFixture()
    const handles = [first.handle, second.handle]
    const fixture = gatewayFixture(first, { spawn: async () => handles.shift()! })
    const host = await serve(fixture.gateway)
    cleanup.push(() => host.close())
    const url = `${host.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`
    const firstSocket = new WebSocket(url)
    const secondSocket = new WebSocket(url)
    const readFirst = frameReader(firstSocket)
    const readSecond = frameReader(secondSocket)

    expect(await readFirst()).toMatchObject({ type: 'ready' })
    expect(await readSecond()).toMatchObject({ type: 'ready' })
    expect(fixture.spawnTerminal).toHaveBeenCalledTimes(2)

    firstSocket.send(JSON.stringify({ type: 'input', data: 'first input' }))
    secondSocket.send(JSON.stringify({ type: 'input', data: 'second input' }))
    await vi.waitFor(() => {
      expect(first.write.mock.calls).toEqual([['first input']])
      expect(second.write.mock.calls).toEqual([['second input']])
    })
    first.output.write('first output')
    second.output.write('second output')
    expect(await readFirst()).toEqual({ type: 'output', data: 'first output' })
    expect(await readSecond()).toEqual({ type: 'output', data: 'second output' })

    const firstClosed = once(firstSocket, 'close')
    firstSocket.send(JSON.stringify({ type: 'close' }))
    await firstClosed
    await vi.waitFor(() => { expect(first.terminate).toHaveBeenCalledOnce() })
    expect(second.terminate).not.toHaveBeenCalled()
    expect(secondSocket.readyState).toBe(WebSocket.OPEN)

    secondSocket.send(JSON.stringify({ type: 'input', data: 'still running' }))
    await vi.waitFor(() => { expect(second.write.mock.calls).toEqual([['second input'], ['still running']]) })
    second.output.write('still running output')
    expect(await readSecond()).toEqual({ type: 'output', data: 'still running output' })

    const secondClosed = once(secondSocket, 'close')
    secondSocket.send(JSON.stringify({ type: 'close' }))
    await secondClosed
    await vi.waitFor(() => { expect(second.terminate).toHaveBeenCalledOnce() })
  })

  it('terminates on explicit close and abrupt disconnect', async () => {
    const first = terminalFixture()
    const firstFixture = gatewayFixture(first)
    const firstHost = await serve(firstFixture.gateway)
    cleanup.push(() => firstHost.close())
    const explicit = new WebSocket(`${firstHost.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`)
    await nextFrame(explicit)
    const explicitClosed = once(explicit, 'close')
    explicit.send(JSON.stringify({ type: 'close' }))
    explicit.send(JSON.stringify({ type: 'input', data: 'ignored-after-close' }))
    await explicitClosed
    await vi.waitFor(() => { expect(first.terminate.mock.calls).toHaveLength(1) })

    const second = terminalFixture()
    const secondFixture = gatewayFixture(second)
    const secondHost = await serve(secondFixture.gateway)
    cleanup.push(() => secondHost.close())
    const disconnected = new WebSocket(`${secondHost.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`)
    await nextFrame(disconnected)
    disconnected.terminate()
    await vi.waitFor(() => { expect(second.terminate.mock.calls).toHaveLength(1) })

    const queued = terminalFixture()
    const writeGate = Promise.withResolvers<undefined>()
    queued.write.mockImplementationOnce(() => writeGate.promise)
    const queuedFixture = gatewayFixture(queued)
    const queuedHost = await serve(queuedFixture.gateway)
    cleanup.push(() => queuedHost.close())
    const queuedSocket = new WebSocket(`${queuedHost.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`)
    await nextFrame(queuedSocket)
    queuedSocket.send(JSON.stringify({ type: 'input', data: 'first' }))
    await vi.waitFor(() => { expect(queued.write).toHaveBeenCalledOnce() })
    queuedSocket.send(JSON.stringify({ type: 'input', data: 'ignored-after-disconnect' }))
    const queuedClosed = once(queuedSocket, 'close')
    queuedSocket.terminate()
    await queuedClosed
    await vi.waitFor(() => { expect(queued.terminate).toHaveBeenCalledOnce() })
    writeGate.resolve(undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(queued.write).toHaveBeenCalledTimes(1)
  })

  it('flushes an incomplete terminal UTF-8 sequence before the exit frame', async () => {
    const terminal = terminalFixture()
    const fixture = gatewayFixture(terminal)
    const host = await serve(fixture.gateway)
    cleanup.push(() => host.close())
    const socket = new WebSocket(`${host.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`)
    const read = frameReader(socket)
    await read()
    terminal.output.write(Buffer.from([0xe2]))
    terminal.resolve({ exitCode: 7, signal: null })
    expect(await read()).toEqual({ type: 'output', data: '�' })
    expect(await read()).toEqual({ type: 'exit', exitCode: 7, signal: null })
    await once(socket, 'close')
  })

  it('closes on bad frames, pre-ready control, control failure, spawn failure, and missing resize', async () => {
    const bad = terminalFixture()
    const badFixture = gatewayFixture(bad)
    const badHost = await serve(badFixture.gateway)
    cleanup.push(() => badHost.close())
    const badSocket = new WebSocket(`${badHost.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`)
    await nextFrame(badSocket)
    const badFrame = nextFrame(badSocket)
    const badClosed = once(badSocket, 'close')
    badSocket.send('{')
    expect(await badFrame).toMatchObject({ type: 'error', code: 'bad-frame' })
    await badClosed

    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const early = terminalFixture()
    const earlyFixture = gatewayFixture(early)
    earlyFixture.resolveExecutable.mockImplementation(async () => { await gate; return '/resolved/zsh' })
    const earlyHost = await serve(earlyFixture.gateway)
    cleanup.push(() => earlyHost.close())
    const earlySocket = new WebSocket(`${earlyHost.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`)
    await once(earlySocket, 'open')
    const earlyError = nextFrame(earlySocket)
    const earlyClosed = once(earlySocket, 'close')
    earlySocket.send(JSON.stringify({ type: 'input', data: 'x' }))
    expect(await earlyError).toMatchObject({ type: 'error', code: 'terminal-unavailable' })
    release()
    await earlyClosed

    const failedControl = terminalFixture()
    failedControl.write.mockRejectedValueOnce(new Error('write failed'))
    const controlFixture = gatewayFixture(failedControl)
    const controlHost = await serve(controlFixture.gateway)
    cleanup.push(() => controlHost.close())
    const controlSocket = new WebSocket(`${controlHost.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`)
    await nextFrame(controlSocket)
    const controlError = nextFrame(controlSocket)
    const controlClosed = once(controlSocket, 'close')
    controlSocket.send(JSON.stringify({ type: 'input', data: 'x' }))
    expect(await controlError).toMatchObject({ type: 'error', code: 'terminal-failed' })
    await controlClosed

    const spawn = terminalFixture()
    const spawnFixture = gatewayFixture(spawn, { spawn: async () => { throw new Error('spawn failed') } })
    const spawnHost = await serve(spawnFixture.gateway)
    cleanup.push(() => spawnHost.close())
    const spawnSocket = new WebSocket(`${spawnHost.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`)
    const spawnClosed = once(spawnSocket, 'close')
    expect(await nextFrame(spawnSocket)).toMatchObject({ type: 'error', code: 'terminal-failed' })
    await spawnClosed

    const nonError = terminalFixture()
    const nonErrorFixture = gatewayFixture(nonError, {
      spawn: async () => {
        // Provider boundaries may reject arbitrary values; diagnostics still stay closed.
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors
        return Promise.reject('spawn failed')
      },
    })
    const nonErrorHost = await serve(nonErrorFixture.gateway)
    cleanup.push(() => nonErrorHost.close())
    const nonErrorSocket = new WebSocket(
      `${nonErrorHost.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`,
    )
    const nonErrorClosed = once(nonErrorSocket, 'close')
    expect(await nextFrame(nonErrorSocket)).toMatchObject({ type: 'error', code: 'terminal-failed' })
    await nonErrorClosed
    expect(nonErrorFixture.warnings).toEqual([expect.objectContaining({ message: 'spawn failed' })])

    const noResize = terminalFixture()
    Reflect.deleteProperty(noResize.handle, 'resize')
    const resizeFixture = gatewayFixture(noResize)
    const resizeHost = await serve(resizeFixture.gateway)
    cleanup.push(() => resizeHost.close())
    const resizeSocket = new WebSocket(`${resizeHost.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`)
    const resizeClosed = once(resizeSocket, 'close')
    expect(await nextFrame(resizeSocket)).toMatchObject({ type: 'error', code: 'terminal-failed' })
    await resizeClosed
    await vi.waitFor(() => { expect(noResize.terminate.mock.calls).toHaveLength(1) })
  })

  it('contains output-send failures and raw server socket errors while still terminating the PTY', async () => {
    const sendFailed = terminalFixture()
    const sendFixture = gatewayFixture(sendFailed)
    const sendHost = await serve(sendFixture.gateway)
    cleanup.push(() => sendHost.close())
    const client = new WebSocket(`${sendHost.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`)
    await nextFrame(client)
    const server = (sendFixture.gateway as unknown as { server: { clients: Set<WebSocket> } }).server
    const accepted = server.clients.values().next().value as WebSocket
    vi.spyOn(accepted, 'send').mockImplementation(((_data: unknown, callback?: (error?: Error) => void) => {
      callback?.(new Error('send failed'))
    }) as WebSocket['send'])
    const clientClosed = once(client, 'close')
    sendFailed.output.write('late output')
    await clientClosed
    await vi.waitFor(() => {
      expect(sendFailed.terminate.mock.calls).toHaveLength(1)
      expect(sendFixture.warnings).toEqual([expect.objectContaining({ message: 'send failed' })])
    })

    const errored = terminalFixture()
    const errorFixture = gatewayFixture(errored)
    const errorHost = await serve(errorFixture.gateway)
    cleanup.push(() => errorHost.close())
    const errorClient = new WebSocket(
      `${errorHost.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`,
    )
    await nextFrame(errorClient)
    const errorServer = (errorFixture.gateway as unknown as { server: { clients: Set<WebSocket> } }).server
    const errorSocket = errorServer.clients.values().next().value as WebSocket
    const errorClosed = once(errorClient, 'close')
    errorSocket.emit('error', new Error('transport failure'))
    await errorClosed
    await vi.waitFor(() => { expect(errored.terminate.mock.calls).toHaveLength(1) })
  })

  it('reports cleanup rejection values and preserves single versus aggregate close failures', async () => {
    for (const failure of [new Error('cleanup error'), 'cleanup string']) {
      const terminal = terminalFixture()
      terminal.terminate.mockImplementation(async () => {
        terminal.resolve({ exitCode: null, signal: 'SIGTERM' })
        // Provider boundaries may reject arbitrary values; the gateway normalizes only logs.
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors
        return Promise.reject(failure)
      })
      const fixture = gatewayFixture(terminal)
      const host = await serve(fixture.gateway)
      cleanup.push(() => host.close())
      const socket = new WebSocket(`${host.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`)
      await nextFrame(socket)
      socket.terminate()
      await vi.waitFor(() => {
        expect(fixture.warnings).toHaveLength(1)
        expect(String(fixture.warnings[0])).toContain(failure instanceof Error ? 'cleanup error' : 'cleanup string')
      })
    }

    const one = gatewayFixture(terminalFixture()).gateway
    const oneServer = (one as unknown as {
      server: { close(callback: (error?: Error) => void): void }
    }).server
    vi.spyOn(oneServer, 'close').mockImplementation((callback) => { callback(new Error('server close')) })
    await expect(one.close()).rejects.toThrow('server close')

    const many = gatewayFixture(terminalFixture()).gateway
    const manyInternals = many as unknown as {
      server: { close(callback: (error?: Error) => void): void }
      sessions: Set<Promise<void>>
    }
    vi.spyOn(manyInternals.server, 'close').mockImplementation((callback) => { callback(new Error('server close')) })
    // allSettled attaches in close() before this turn can report the rejection.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    manyInternals.sessions.add(Promise.reject('session cleanup'))
    await expect(many.close()).rejects.toBeInstanceOf(AggregateError)
  })

  it('waits for cleanup on gateway close and rejects new upgrades while closing', async () => {
    let release!: () => void
    const cleanupGate = new Promise<void>((resolve) => { release = resolve })
    const terminal = terminalFixture()
    terminal.terminate.mockImplementation(async () => {
      terminal.resolve({ exitCode: null, signal: 'SIGTERM' })
      await cleanupGate
    })
    const fixture = gatewayFixture(terminal)
    const host = await serve(fixture.gateway)
    cleanup.push(() => host.close())
    const socket = new WebSocket(`${host.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`)
    await nextFrame(socket)
    let closed = false
    const closing = fixture.gateway.close().then(() => { closed = true })
    await vi.waitFor(() => { expect(terminal.terminate.mock.calls).toHaveLength(1) })
    expect(closed).toBe(false)
    expect(await unexpectedStatus(
      `${host.origin}/open-in-app/terminal?sessionId=session&cols=80&rows=24`,
    )).toBe(503)
    release()
    await closing
    await fixture.gateway.close()
  })
})
