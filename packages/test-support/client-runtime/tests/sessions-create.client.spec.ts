// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { ISessions, SessionId, WorkspaceId } from 'coding-client-runtime/client'
import { SlotTestRuntime } from '../src/index.ts'

afterEach(cleanup)

describe('TestSessions.create', () => {
  it('rejects an unstubbed creation without inventing a session', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      await runtime.sessions.add({ id: 'existing' })
      const sessions: ISessions = runtime.sessions

      await expect(sessions.create()).rejects.toThrow('create is not stubbed')
      expect(runtime.sessions.calls).toContainEqual({ method: 'create', args: [{}] })
      expect(sessions.list.getSnapshot().ids).toEqual(['existing'])
      expect(sessions.list.getSnapshot().current).toBe('existing')
    } finally {
      await runtime.dispose()
    }
  })

  it('forwards options to the injected stub and returns its id', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      const options = {
        workspaceId: 'workspace' as WorkspaceId,
        cwd: '/work',
        sessionId: 'preallocated' as SessionId,
      }
      const stub = vi.fn(async () => options.sessionId)
      runtime.sessions.stubCreate(stub)

      await expect(runtime.sessions.create(options)).resolves.toBe(options.sessionId)
      expect(stub).toHaveBeenCalledExactlyOnceWith(options)
      expect(runtime.sessions.calls).toEqual([{ method: 'create', args: [options] }])
    } finally {
      await runtime.dispose()
    }
  })

  it('propagates a stub rejection without publishing a session', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      const failure = new Error('host rejected creation')
      runtime.sessions.stubCreate(async () => { throw failure })

      await expect(runtime.sessions.create({ cwd: '/work' })).rejects.toBe(failure)
      expect(runtime.sessions.list.getSnapshot().ids).toEqual([])
      expect(runtime.sessions.calls).toEqual([{ method: 'create', args: [{ cwd: '/work' }] }])
    } finally {
      await runtime.dispose()
    }
  })

  it('lets the stub publish a fresh blank session before resolution without opening it', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      const oldId = await runtime.sessions.add({ id: 'existing' })
      const freshId = 'fresh' as SessionId
      runtime.sessions.stubCreate(async () => {
        const id = await runtime.sessions.add({ id: freshId, summary: { blank: true } }, { current: false })
        return id
      })
      const sessions: ISessions = runtime.sessions

      await expect(sessions.create({ sessionId: freshId })).resolves.toBe(freshId)
      expect(sessions.list.getSnapshot().byId[freshId]).toMatchObject({ id: freshId, blank: true })
      expect(sessions.binding(freshId)?.sessionId).toBe(freshId)
      expect(sessions.list.getSnapshot().current).toBe(oldId)
    } finally {
      await runtime.dispose()
    }
  })
})
