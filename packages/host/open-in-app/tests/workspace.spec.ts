/** Session 工作区 wire 校验和 provider 路径遍历的聚焦测试。 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { FsDirEntry, FsInfo, FsTarget } from 'coding-fs'
import {
  listWorkspaceFiles,
  parseFilesRequest,
  parseReadRequest,
  parseSaveRequest,
  readWorkspaceFile,
  saveWorkspaceFile,
  WorkspaceProtocolError,
} from '../src/workspace.ts'

function target(key: string, displayPath = `/workspace/${key}`): FsTarget {
  return { targetKey: key as never, displayPath }
}

interface Harness {
  readonly ctx: Context
  readonly entries: Map<string, FsDirEntry[]>
  readonly info: Map<string, FsInfo | undefined>
  readonly contents: Map<string, Uint8Array>
  readonly root: FsTarget
  readonly resolve: ReturnType<typeof vi.fn<(path: string, opts?: { cwd?: string }) => Promise<FsTarget>>>
  readonly readBytes: ReturnType<
    typeof vi.fn<(value: FsTarget, signal: AbortSignal | undefined, maxBytes: number) => Promise<Uint8Array>>
  >
  readonly writeText: ReturnType<
    typeof vi.fn<(value: FsTarget, content: string, expected?: unknown, signal?: AbortSignal, policy?: unknown) => Promise<{
      operation: 'create' | 'update'
      version: string
      before: string | null
      after: string
    }>>
  >
}

function harness(cwd: string | null = '/workspace'): Harness {
  const root = target('root', String.raw`C:\repo`)
  const entries = new Map<string, FsDirEntry[]>()
  const info = new Map<string, FsInfo | undefined>()
  const contents = new Map<string, Uint8Array>()
  const session = { header: { ...cwd === null ? {} : { cwd } } }
  const resolve = vi.fn(async () => root)
  const readBytes = vi.fn(async (value: FsTarget, _signal: AbortSignal | undefined, maxBytes: number) => {
    const bytes = contents.get(String(value.targetKey)) ?? new Uint8Array()
    if (bytes.byteLength > maxBytes) throw Object.assign(new Error('large'), { code: 'FS_TOO_LARGE' })
    return bytes
  })
  const writeText = vi.fn(async (_value: FsTarget, content: string) => ({
    operation: 'update' as const,
    version: 'v2',
    before: '',
    after: content,
  }))
  const fs = {
    resolve,
    listDir: vi.fn(async (value: FsTarget) => entries.get(String(value.targetKey)) ?? []),
    contains: vi.fn((_parent: FsTarget, child: FsTarget) => !String(child.targetKey).startsWith('outside')),
    stat: vi.fn(async (value: FsTarget) => info.get(String(value.targetKey))),
    readBytes,
    writeText,
  }
  const ctx = {
    sessions: { get: (id: string) => id === 'session' ? session : undefined },
    fs,
    get: () => undefined,
  } as unknown as Context
  return { ctx, entries, info, contents, root, resolve, readBytes, writeText }
}

function file(name: string, key = name, size?: number): FsDirEntry {
  return {
    name,
    type: 'file',
    target: target(key),
    ...size === undefined ? {} : { size },
  }
}

describe('workspace request parsers', () => {
  it('accepts only a bounded Session identity and provider-name segments', () => {
    expect(parseFilesRequest({ sessionId: 'session', segments: [] }))
      .toEqual({ sessionId: 'session', segments: [] })
    expect(parseReadRequest({ sessionId: 'session', segments: ['src', 'index.ts'] }))
      .toEqual({ sessionId: 'session', segments: ['src', 'index.ts'] })

    const invalid = [
      null,
      [],
      { sessionId: 'session', segments: [], root: '/arbitrary' },
      { sessionId: 1, segments: [] },
      { sessionId: '', segments: [] },
      { sessionId: 'bad\0id', segments: [] },
      { sessionId: 'x'.repeat(1025), segments: [] },
      { sessionId: 'session', segments: 'src' },
      { sessionId: 'session', segments: Array.from({ length: 65 }, () => 'x') },
      { sessionId: 'session', segments: [1] },
      { sessionId: 'session', segments: [''] },
      { sessionId: 'session', segments: ['bad\0name'] },
      { sessionId: 'session', segments: ['x'.repeat(8193)] },
    ]
    for (const value of invalid) expect(parseFilesRequest(value)).toBeUndefined()
    expect(parseReadRequest({ sessionId: 'session', segments: [] })).toBeUndefined()
  })

  it('accepts only bounded versioned saves with complete text content', () => {
    expect(parseSaveRequest({
      sessionId: 'session', segments: ['a.txt'], baseVersion: 'v1', content: 'hello',
    }, 100)).toEqual({
      sessionId: 'session', segments: ['a.txt'], baseVersion: 'v1', content: 'hello',
    })
    for (const value of [
      { sessionId: 'session', segments: [], baseVersion: 'v1', content: 'x' },
      { sessionId: 'session', segments: ['a.txt'], baseVersion: '', content: 'x' },
      { sessionId: 'session', segments: ['a.txt'], baseVersion: 'v1', content: 1 },
      { sessionId: 'session', segments: ['a.txt'], baseVersion: 'v1', content: 'x\0y' },
      { sessionId: 'session', segments: ['a.txt'], baseVersion: 'v1', content: 'x', path: '/outside' },
    ]) expect(parseSaveRequest(value, 100)).toBeUndefined()
    expect(() => parseSaveRequest({
      sessionId: 'session', segments: ['a.txt'], baseVersion: 'v1', content: 'x'.repeat(101),
    }, 100)).toThrow(expect.objectContaining({ status: 413, code: 'file-too-large' }))
    expect(parseSaveRequest({
      sessionId: 'session', segments: ['a.txt'], baseVersion: 'v1', content: 'x'.repeat(100),
    }, 100)?.content).toHaveLength(100)
    expect(() => parseSaveRequest({
      sessionId: 'session', segments: ['a.txt'], baseVersion: 'v1', content: 'é'.repeat(51),
    }, 100)).toThrow(expect.objectContaining({ status: 413, code: 'file-too-large' }))
  })
})

describe('Session-bound directory listing', () => {
  it('uses only the live Session cwd and returns bounded provider metadata', async () => {
    const state = harness()
    const nested = target('nested', String.raw`C:\repo\src`)
    state.entries.set('root', [
      { name: 'src', type: 'directory', target: nested },
      file('README.md', 'readme'),
    ])
    state.entries.set('nested', [
      file('index.ts', 'index', 6),
      ...Array.from({ length: 2_000 }, (_, index) => file(`f-${String(index)}`, `f-${String(index)}`)),
    ])

    await expect(listWorkspaceFiles(state.ctx, { sessionId: 'session', segments: [] }))
      .resolves.toEqual({
        displayPath: String.raw`C:\repo`,
        entries: [
          { name: 'src', type: 'directory' },
          { name: 'README.md', type: 'file' },
        ],
        truncated: false,
      })
    const nestedListing = await listWorkspaceFiles(state.ctx, { sessionId: 'session', segments: ['src'] })
    expect(nestedListing.displayPath).toBe(String.raw`C:\repo\src`)
    expect(nestedListing.entries).toHaveLength(2_000)
    expect(nestedListing.entries[0]).toEqual({ name: 'index.ts', type: 'file', size: 6 })
    expect(nestedListing.truncated).toBe(true)
    expect(state.resolve.mock.calls).toContainEqual(['/workspace', { cwd: '/workspace' }])
  })

  it('fails closed for missing Sessions, absent cwd, traversal, files, and outside targets', async () => {
    const state = harness()
    const outside = target('outside-dir', '/outside')
    state.entries.set('root', [
      { name: 'outside', type: 'directory', target: outside },
      file('plain.txt'),
    ])
    await expect(listWorkspaceFiles(state.ctx, { sessionId: 'missing', segments: [] }))
      .rejects.toMatchObject({ status: 404, code: 'session-not-found' })
    await expect(listWorkspaceFiles(harness(null).ctx, { sessionId: 'session', segments: [] }))
      .rejects.toMatchObject({ status: 409, code: 'workspace-unavailable' })
    for (const segments of [['..'], ['missing'], ['plain.txt'], ['outside']]) {
      await expect(listWorkspaceFiles(state.ctx, { sessionId: 'session', segments }))
        .rejects.toMatchObject({ status: 404, code: 'not-found' })
    }
  })
})

describe('bounded file previews', () => {
  it('returns markdown, code, general text, and complete images', async () => {
    const state = harness()
    const files = [
      file('README.md', 'markdown'),
      file('index.ts', 'code'),
      file('Makefile', 'makefile'),
      file('NOTICE', 'text'),
      file('logo.png', 'image'),
      file('index.html', 'html'),
      file('icon.svg', 'svg'),
    ]
    state.entries.set('root', files)
    for (const entry of files) state.info.set(String(entry.target.targetKey), {
      version: 'v1' as never,
      type: 'file',
      ...entry.name === 'logo.png' ? { size: 3 } : {},
    })
    state.contents.set('markdown', Buffer.from('# title'))
    state.contents.set('code', Buffer.from('const x = 1'))
    state.contents.set('makefile', Buffer.from('all:'))
    state.contents.set('text', Buffer.from('notice'))
    state.contents.set('image', Uint8Array.from([1, 2, 3]))
    state.contents.set('html', Buffer.from('<!doctype html><h1>hello</h1>'))
    state.contents.set('svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))

    await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: ['README.md'] }, 100))
      .resolves.toMatchObject({ kind: 'text', format: 'markdown', text: '# title', truncated: false })
    await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: ['index.ts'] }, 100))
      .resolves.toMatchObject({ kind: 'text', format: 'code' })
    await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: ['Makefile'] }, 100))
      .resolves.toMatchObject({ kind: 'text', format: 'code' })
    await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: ['NOTICE'] }, 100))
      .resolves.toMatchObject({ kind: 'text', format: 'text' })
    await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: ['logo.png'] }, 100))
      .resolves.toEqual({
        kind: 'image',
        mime: 'image/png',
        dataBase64: 'AQID',
        displayPath: '/workspace/image',
        name: 'logo.png',
        truncated: false,
        version: 'v1',
      })
    await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: ['index.html'] }, 100))
      .resolves.toMatchObject({ kind: 'text', format: 'html', text: '<!doctype html><h1>hello</h1>' })
    await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: ['icon.svg'] }, 100))
      .resolves.toMatchObject({ kind: 'text', format: 'svg', text: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
  })

  it('classifies invalid UTF-8, NUL content, and every oversize path without returning bytes', async () => {
    const state = harness()
    const files = [
      file('invalid.dat', 'invalid'),
      file('nul.txt', 'nul'),
      file('known-large.txt', 'known-large', 101),
      file('provider-large.txt', 'provider-large'),
      file('broken-provider.txt', 'broken-provider'),
    ]
    state.entries.set('root', files)
    for (const entry of files) state.info.set(String(entry.target.targetKey), {
      version: 'v1' as never,
      type: 'file',
      ...entry.size === undefined ? {} : { size: entry.size },
    })
    state.contents.set('invalid', Uint8Array.from([0xff]))
    state.contents.set('nul', Buffer.from('a\0b'))
    state.contents.set('provider-large', Buffer.alloc(101))
    state.readBytes.mockImplementation(async (value, _signal, maxBytes) => {
      if (String(value.targetKey) === 'broken-provider') return Buffer.alloc(maxBytes + 1)
      const bytes = state.contents.get(String(value.targetKey)) ?? new Uint8Array()
      if (bytes.byteLength > maxBytes) throw Object.assign(new Error('large'), { code: 'FS_TOO_LARGE' })
      return bytes
    })

    for (const name of ['invalid.dat', 'nul.txt']) {
      await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: [name] }, 100))
        .resolves.toMatchObject({ kind: 'unsupported', reason: 'binary', truncated: false })
    }
    for (const name of ['known-large.txt', 'provider-large.txt', 'broken-provider.txt']) {
      await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: [name] }, 100))
        .resolves.toMatchObject({ kind: 'unsupported', reason: 'too-large', truncated: true })
    }
  })

  it('rejects missing, escaping, non-file, changed, and provider-failed targets', async () => {
    const state = harness()
    const outside = file('outside.txt', 'outside-file')
    const directory = { name: 'dir', type: 'directory', target: target('dir') } as const
    const vanished = file('vanished.txt', 'vanished')
    const changed = file('changed.txt', 'changed')
    const failed = file('failed.txt', 'failed')
    state.entries.set('root', [outside, directory, vanished, changed, failed])
    state.info.set('vanished', undefined)
    state.info.set('changed', { version: 'v1' as never, type: 'directory' })
    state.info.set('failed', { version: 'v1' as never, type: 'file' })
    state.readBytes.mockRejectedValueOnce(new Error('provider offline'))

    await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: ['missing'] }, 100))
      .rejects.toMatchObject({ status: 404 })
    await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: ['outside.txt'] }, 100))
      .rejects.toMatchObject({ status: 404 })
    await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: ['dir'] }, 100))
      .rejects.toMatchObject({ status: 400 })
    await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: ['vanished.txt'] }, 100))
      .rejects.toMatchObject({ status: 404 })
    await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: ['changed.txt'] }, 100))
      .rejects.toMatchObject({ status: 400 })
    await expect(readWorkspaceFile(state.ctx, { sessionId: 'session', segments: ['failed.txt'] }, 100))
      .rejects.toThrow('provider offline')
    expect(new WorkspaceProtocolError(400, 'bad-request', 'bad').name).toBe('WorkspaceProtocolError')
  })
})

describe('versioned workspace saves', () => {
  it('writes the complete text with the observed version and returns the new version', async () => {
    const state = harness()
    const entry = file('a.txt', 'a', 3)
    state.entries.set('root', [entry])
    state.info.set('a', { version: 'v1' as never, type: 'file', size: 3 })

    await expect(saveWorkspaceFile(state.ctx, {
      sessionId: 'session', segments: ['a.txt'], baseVersion: 'v1', content: 'next',
    })).resolves.toEqual({
      displayPath: '/workspace/a', name: 'a.txt', version: 'v2', operation: 'update',
    })
    expect(state.writeText).toHaveBeenCalledWith(
      entry.target,
      'next',
      { kind: 'replaceIfVersion', version: 'v1' },
      undefined,
      undefined,
    )
  })

  it('maps stale, missing, oversize, and readonly provider failures to stable HTTP errors', async () => {
    const state = harness()
    state.entries.set('root', [file('a.txt', 'a')])
    state.info.set('a', { version: 'v1' as never, type: 'file' })
    const request = { sessionId: 'session', segments: ['a.txt'], baseVersion: 'v1', content: 'next' }
    for (const [code, status, wire] of [
      ['FS_STALE_VERSION', 409, 'file-conflict'],
      ['FS_NOT_FOUND', 404, 'not-found'],
      ['FS_TOO_LARGE', 413, 'file-too-large'],
      ['FS_SANDBOX_DENIED', 403, 'file-readonly'],
    ] as const) {
      state.writeText.mockRejectedValueOnce(Object.assign(new Error(code), { code }))
      await expect(saveWorkspaceFile(state.ctx, request)).rejects.toMatchObject({ status, code: wire })
    }
  })
})
