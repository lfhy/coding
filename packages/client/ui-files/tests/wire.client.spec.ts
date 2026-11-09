import { afterEach, describe, expect, it, vi } from 'vitest'
import { listManagedFiles, parseManagedFilesPage } from '../src/client/wire.ts'

const record = {
  id: 'upload-1', kind: 'upload', name: 'notes.txt', relativePath: 'upload/notes.txt',
  mediaType: 'text/plain', bytes: 1024, createdAt: '2026-11-09T08:00:00.000Z',
} as const

afterEach(() => { vi.unstubAllGlobals() })

describe('managed files wire', () => {
  it('读取带分页游标的只读 Host 目录', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ items: [record], total: 2, nextOffset: 1 }) }))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await listManagedFiles(0, 50, signal)).toEqual({ items: [record], total: 2, nextOffset: 1 })
    expect(fetcher).toHaveBeenCalledWith('/api/files/list?offset=0&limit=50', { method: 'GET', signal })
  })

  it('拒绝非成功 HTTP 状态与格式错误的响应', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })))
    await expect(listManagedFiles(0, 50, new AbortController().signal)).rejects.toThrow('503')
    expect(() => parseManagedFilesPage({ items: [record], total: -1 })).toThrow('Invalid managed files page')
    expect(() => parseManagedFilesPage({ items: [{ ...record, bytes: -1 }], total: 1 })).toThrow('Invalid managed file record')
  })

  it.each(['/absolute/file', '\\absolute\\file', 'C:\\files\\file', 'folder/../secret'])('拒绝非相对路径 %s', (relativePath) => {
    expect(() => parseManagedFilesPage({ items: [{ ...record, relativePath }], total: 1 })).toThrow('Invalid managed file record')
  })
})
