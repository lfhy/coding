/** Coding 受管理 Host 记录和空闲生命周期的行为验证。 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WebClientConnections } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODING_HOST_PROTOCOL,
  codingHostRecordPath,
  removeCodingHostRecord,
  startManagedHost,
  writeCodingHostRecord,
  type CodingHostRecord,
} from '../src/managed-host.ts'

const homes: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'coding-managed-host-'))
  homes.push(home)
  return home
}

function record(token: string): CodingHostRecord {
  return {
    type: 'coding-host-ready',
    port: 43123,
    pid: process.pid,
    version: 'test-version',
    protocol: CODING_HOST_PROTOCOL,
    token,
  }
}

function managedContext(connections: WebClientConnections, exits: number[]): Context {
  const ctx = new Context()
  ctx.provide('webClientConnections', connections)
  ctx.provide('appExit', (code: number) => { exits.push(code) })
  ctx.provide('agents', { list: () => [] } as never)
  return ctx
}

describe('Coding managed Host', () => {
  it('writes atomically and keeps a newer owner record during stale cleanup', async () => {
    const home = temporaryHome()
    const first = record('first')
    const second = record('second')

    await writeCodingHostRecord(home, first)
    expect(JSON.parse(readFileSync(codingHostRecordPath(home), 'utf8'))).toEqual(first)

    await writeCodingHostRecord(home, second)
    await removeCodingHostRecord(home, first.token)
    expect(JSON.parse(readFileSync(codingHostRecordPath(home), 'utf8'))).toEqual(second)

    await removeCodingHostRecord(home, second.token)
    expect(() => readFileSync(codingHostRecordPath(home), 'utf8')).toThrow(/ENOENT/)
  })

  it('publishes a ready record and exits only after the final downlink closes', async () => {
    vi.useFakeTimers()
    const home = temporaryHome()
    const exits: number[] = []
    const connections = new WebClientConnections()
    const detach = connections.attach()
    const ctx = managedContext(connections, exits)

    const ready = await startManagedHost(ctx, {
      home,
      port: 43123,
      version: 'test-version',
      idleTimeoutMs: 50,
    })

    expect(ready).toMatchObject({
      type: 'coding-host-ready',
      port: 43123,
      pid: process.pid,
      version: 'test-version',
      protocol: CODING_HOST_PROTOCOL,
    })
    expect(JSON.parse(readFileSync(codingHostRecordPath(home), 'utf8'))).toEqual(ready)

    await vi.advanceTimersByTimeAsync(60)
    expect(exits).toEqual([])

    detach()
    await vi.advanceTimersByTimeAsync(49)
    expect(exits).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(exits).toEqual([0])

    await ctx.fiber.dispose()
    expect(() => readFileSync(codingHostRecordPath(home), 'utf8')).toThrow(/ENOENT/)
  })

  it('keeps a replacement record when the original Host disposes', async () => {
    const home = temporaryHome()
    const exits: number[] = []
    const connections = new WebClientConnections()
    const detach = connections.attach()
    const ctx = managedContext(connections, exits)
    const ready = await startManagedHost(ctx, {
      home,
      port: 43123,
      version: 'test-version',
      idleTimeoutMs: 1_000,
    })
    const replacement = { ...ready, token: 'replacement', pid: process.pid + 1 }
    await writeCodingHostRecord(home, replacement)

    await ctx.fiber.dispose()
    detach()
    expect(JSON.parse(readFileSync(codingHostRecordPath(home), 'utf8'))).toEqual(replacement)
  })
})
