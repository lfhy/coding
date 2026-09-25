import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
import { launchHelper, type HelperClient } from '../src/helper-client.ts'

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: string | null = null
  kill = vi.fn((signal: string) => {
    this.signalCode = signal
    this.emit('exit', null, signal)
    return true
  })

  send(value: unknown): void { this.stdout.write(`${JSON.stringify(value)}\n`) }
  ready(): void { this.send({ type: 'ready', protocol: 1, origin: 'http://127.0.0.1:4242' }) }
  sent(): { id: string; type: string; protocol: number; method: string; payload: unknown } {
    const chunk: unknown = this.stdin.read()
    if (!Buffer.isBuffer(chunk)) throw new Error('Missing helper request')
    return JSON.parse(chunk.toString()) as ReturnType<FakeChild['sent']>
  }
}

const options = { executable: '/mock/helper', args: ['--stdio'], cwd: '/mock', env: { ONLY_TEST: 'yes' } }

describe('Electron Go helper stdio', () => {
  let child: FakeChild
  let client: HelperClient | undefined
  beforeEach(() => {
    child = new FakeChild()
    spawnMock.mockReset().mockReturnValue(child)
  })
  afterEach(async () => {
    await client?.close()
    client = undefined
  })

  async function launch(): Promise<HelperClient> {
    const waiting = launchHelper(options)
    child.ready()
    client = await waiting
    return client
  }

  it('accepts the first ready frame and correlates responses and progress', async () => {
    const helper = await launch()
    expect(helper.origin).toBe('http://127.0.0.1:4242')
    expect(spawnMock).toHaveBeenCalledWith('/mock/helper', ['--stdio'], expect.objectContaining({ cwd: '/mock', env: options.env, stdio: ['pipe', 'pipe', 'pipe'] }))
    const progress = vi.fn()
    const dispose = helper.onProgress(progress)
    const request = helper.request('RemoteSSHConnect', { attemptId: 'rattempt', mode: 'agent' })
    const sent = child.sent()
    expect(sent).toMatchObject({ type: 'request', protocol: 1, method: 'RemoteSSHConnect', payload: { attemptId: 'rattempt', mode: 'agent' } })
    expect(sent.id).toMatch(/^[a-f0-9-]{36}$/)
    child.send({ type: 'event', protocol: 1, name: 'coding:remote-ssh-progress', payload: { attemptId: 'rattempt', phase: 'connecting', message: '' } })
    child.send({ type: 'response', protocol: 1, id: sent.id, ok: true, value: { kind: 'ready', mode: 'basic', connectionId: 'connection-1' } })
    expect(await request).toEqual({ kind: 'ready', mode: 'basic', connectionId: 'connection-1' })
    expect(progress).toHaveBeenCalledOnce()
    dispose()
    child.send({ type: 'event', protocol: 1, name: 'coding:remote-ssh-progress', payload: { attemptId: 'rattempt', phase: 'done', message: '' } })
    expect(progress).toHaveBeenCalledOnce()
  })

  it('delivers only future activation events to their own listeners', async () => {
    const helper = await launch()
    const frame = { type: 'event', protocol: 1, name: 'coding:activate', payload: {} }
    child.send(frame)
    const activate = vi.fn()
    const progress = vi.fn()
    helper.onProgress(progress)
    const dispose = helper.onActivate(activate)
    expect(activate).not.toHaveBeenCalled()
    child.send(frame)
    expect(activate).toHaveBeenCalledOnce()
    expect(progress).not.toHaveBeenCalled()
    dispose()
    child.send(frame)
    expect(activate).toHaveBeenCalledOnce()
  })

  it.each([
    { type: 'event', protocol: 1, name: 'coding:activate', payload: { token: 'secret' } },
    { type: 'event', protocol: 1, name: 'coding:activate', payload: [] },
    { type: 'event', protocol: 1, name: 'coding:activate', payload: null },
    { type: 'event', protocol: 1, name: 'coding:unknown', payload: {} },
  ])('fails closed on malformed or unknown activation frame: %j', async (frame) => {
    const helper = await launch()
    const activate = vi.fn()
    const closed = vi.fn()
    helper.onActivate(activate)
    helper.onClosed(closed)
    child.send(frame)
    expect(activate).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledExactlyOnceWith('protocol')
    await expect(helper.request('shutdown', {})).rejects.toThrow('Helper exited')
  })

  it.each([
    { type: 'event', protocol: 1, name: 'coding:remote-ssh-progress', payload: { attemptId: 'a', phase: 'a', message: 'secret' } },
    { type: 'ready', protocol: 1, origin: 'http://localhost:4242' },
    { type: 'ready', protocol: 1, origin: 'http://127.0.0.1:04242' },
    { type: 'ready', protocol: 2, origin: 'http://127.0.0.1:4242' },
    { type: 'ready', protocol: 1, origin: 'http://127.0.0.1:4242', token: 'secret' },
  ])('rejects an invalid first frame: %j', async (frame) => {
    const waiting = launchHelper(options)
    child.send(frame)
    await expect(waiting).rejects.toThrow('Invalid helper stdout protocol')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('fails closed on unknown or duplicate responses', async () => {
    const helper = await launch()
    const pending = helper.request('RemoteSSHClose', { connectionId: 'r1' })
    const { id } = child.sent()
    child.send({ type: 'response', protocol: 1, id: 'unknown', ok: true, value: null })
    await expect(pending).rejects.toThrow('Invalid helper stdout protocol')
    await expect(helper.request('RemoteSSHClose', {})).rejects.toThrow('Helper exited')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(id).not.toBe('unknown')
  })

  it('rejects a duplicate completed response', async () => {
    const helper = await launch()
    const closed = vi.fn()
    helper.onClosed(closed)
    const result = helper.request('shutdown', {})
    const { id } = child.sent()
    const response = { type: 'response', protocol: 1, id, ok: true, value: null }
    child.send(response)
    await expect(result).resolves.toBeNull()
    child.send(response)
    await expect(helper.request('shutdown', {})).rejects.toThrow('Helper exited')
    expect(closed).toHaveBeenCalledExactlyOnceWith('protocol')
    child.emit('exit', 1, null)
    await helper.close()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('reports unexpected exit once and replays the reason to a late subscriber', async () => {
    const helper = await launch()
    const closed = vi.fn()
    const dispose = helper.onClosed(closed)
    const pending = helper.request('RemoteSSHConnect', {})
    child.sent()
    child.exitCode = 1
    child.stderr.write('SECRET=never-forward')
    child.emit('exit', 1, null)
    await expect(pending).rejects.toThrow('may have executed')
    expect(closed).toHaveBeenCalledExactlyOnceWith('exited')
    expect(closed.mock.calls.flat().join(' ')).not.toContain('SECRET')
    child.stdout.end()
    dispose()
    const late = vi.fn()
    helper.onClosed(late)
    expect(late).toHaveBeenCalledExactlyOnceWith('exited')
    await helper.close()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('reports intentional close once, independent of SIGTERM exit', async () => {
    const helper = await launch()
    const closed = vi.fn()
    helper.onClosed(closed)
    await helper.close()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(closed).toHaveBeenCalledExactlyOnceWith('closed')
    child.emit('exit', 0, null)
    await helper.close()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('accepts split frames but rejects malformed response fields', async () => {
    const helper = await launch()
    const result = helper.request('RemoteSSHClose', {})
    const { id } = child.sent()
    const response = JSON.stringify({ type: 'response', protocol: 1, id, ok: false, error: { code: 'request_failed', message: 'secret' } })
    child.stdout.write(response.slice(0, 17))
    child.stdout.write(`${response.slice(17)}\n`)
    await expect(result).rejects.toThrow('Helper request failed (request_failed)')
    const next = helper.request('shutdown', {})
    const nextID = child.sent().id
    child.send({ type: 'response', protocol: 1, id: nextID, ok: false, error: { code: 'invalid', message: '', secret: 'leak' } })
    await expect(next).rejects.toThrow('Invalid helper stdout protocol')
  })

  it('keeps cancelled ids occupied until their late response, without claiming non-execution', async () => {
    const helper = await launch()
    const abort = new AbortController()
    const pending = helper.request('RemoteSSHConnect', {}, abort.signal)
    const { id } = child.sent()
    abort.abort()
    await expect(pending).rejects.toThrow('may still execute')
    child.send({ type: 'response', protocol: 1, id, ok: true, value: null })
    const second = helper.request('shutdown', {})
    const secondID = child.sent().id
    child.send({ type: 'response', protocol: 1, id: secondID, ok: true, value: null })
    await expect(second).resolves.toBeNull()
    child.send({ type: 'response', protocol: 1, id, ok: true, value: null })
    await expect(helper.request('shutdown', {})).rejects.toThrow('Helper exited')
  })

  it.each(['RemoteSSHSelectUnclaimed', 'RemoteSSHRevokeUnclaimed', 'RemoteSSHClaimSelection'])(
    'allows only main to send internal helper method %s', async (method) => {
      const helper = await launch()
      const request = helper.request(method, { selectionId: 'selection-1' })
      const sent = child.sent()
      expect(sent).toMatchObject({ type: 'request', protocol: 1, method, payload: { selectionId: 'selection-1' } })
      child.send({ type: 'response', protocol: 1, id: sent.id, ok: true, value: null })
      await expect(request).resolves.toBeNull()
      await expect(helper.request(`${method}Extra`, {})).rejects.toThrow('Unsupported helper method')
      expect(child.stdin.read()).toBeNull()
    },
  )

  it('rejects unknown methods and oversized requests without writing them', async () => {
    const helper = await launch()
    await expect(helper.request('eval', {})).rejects.toThrow('Unsupported helper method')
    await expect(helper.request('RemoteSSHConnect', { secret: 'x'.repeat(2 << 20) })).rejects.toThrow('Invalid helper request payload')
    expect(child.stdin.read()).toBeNull()
  })

  it('bounds stdout framing and never reflects stderr credentials', async () => {
    const waiting = launchHelper(options)
    child.stderr.write('API_SECRET=do-not-reflect')
    child.stdout.write('x'.repeat((2 << 20) + 1))
    await expect(waiting).rejects.toThrow('Invalid helper stdout protocol')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('stops only its spawned child on launch cancellation', async () => {
    const controller = new AbortController()
    const waiting = launchHelper({ ...options, signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toThrow('Helper launch cancelled')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('rejects pending work without claiming non-execution when lifetime aborts', async () => {
    const controller = new AbortController()
    const waiting = launchHelper({ ...options, signal: controller.signal })
    child.ready()
    client = await waiting
    const pending = client.request('RemoteSSHConnect', {})
    child.sent()
    controller.abort()
    await expect(pending).rejects.toThrow('may have executed')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('escalates an unresponsive child to SIGKILL within bounded time', async () => {
    vi.useFakeTimers()
    try {
      child.kill.mockImplementation(() => true)
      const waiting = launchHelper(options)
      const rejected = expect(waiting).rejects.toThrow('Invalid helper stdout protocol')
      child.send({ type: 'ready', protocol: 2, origin: 'http://127.0.0.1:4242' })
      await vi.advanceTimersByTimeAsync(2_100)
      await rejected
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })
})
