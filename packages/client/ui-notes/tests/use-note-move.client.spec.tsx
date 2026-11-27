// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useNoteMove } from '../src/client/useNoteMove.ts'

function options() {
  return {
    creatingRequest: { current: null } as { current: AbortController | null },
    setCreating: vi.fn(),
    setExpanded: vi.fn(),
    flush: vi.fn(async () => true),
    renamePath: vi.fn(),
    actions: { moveTabs: vi.fn() },
    refreshTree: vi.fn(async () => []),
    treeRevision: { current: 0 },
    seenNotes: { current: new Map<string, number>() },
    notify: vi.fn(),
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('useNoteMove', () => {
  it('移动成功后同步标签、草稿、展开目录和写入检测路径', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ path: 'd/a.md' })))
    const input = options()
    input.seenNotes.current.set('a.md', 10)
    input.seenNotes.current.set('keep.md', 20)
    const { result } = renderHook(() => useNoteMove(input as unknown as Parameters<typeof useNoteMove>[0]))

    await act(async () => { await result.current('a.md', 'd', null) })

    expect(fetch).toHaveBeenCalledWith('/api/notes/move', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ path: 'a.md', directory: 'd', before: null }),
    }))
    expect(input.renamePath).toHaveBeenCalledWith('a.md', 'd/a.md')
    expect(input.actions.moveTabs).toHaveBeenCalledWith('a.md', 'd/a.md')
    expect(input.treeRevision.current).toBe(1)
    expect([...input.seenNotes.current]).toEqual([['d/a.md', 10], ['keep.md', 20]])
    const update = input.setExpanded.mock.calls[0]?.[0] as (previous: ReadonlySet<string>) => ReadonlySet<string>
    expect([...update(new Set(['d']))]).toEqual(['d'])
    expect(input.refreshTree).toHaveBeenCalledOnce()
    expect(input.notify).not.toHaveBeenCalled()
    expect(input.creatingRequest.current).toBeNull()
  })

  it('Host 失败后刷新真实目录并提示，不保留旧路径', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('conflict', { status: 409 })))
    const input = options()
    const { result } = renderHook(() => useNoteMove(input as unknown as Parameters<typeof useNoteMove>[0]))

    await act(async () => { await result.current('a.md', 'd', null) })

    expect(input.refreshTree).toHaveBeenCalledOnce()
    expect(input.notify).toHaveBeenCalledWith('moveError')
    expect(input.renamePath).not.toHaveBeenCalled()
    expect(input.creatingRequest.current).toBeNull()
  })

  it('活动草稿保存失败时不会发起移动', async () => {
    const input = options()
    input.flush.mockResolvedValue(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useNoteMove(input as unknown as Parameters<typeof useNoteMove>[0]))

    await act(async () => { await result.current('a.md', 'd', null) })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(input.notify).toHaveBeenCalledWith('saveError')
  })
})
