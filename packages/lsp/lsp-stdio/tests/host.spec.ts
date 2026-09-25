import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { REMOTE_WORKSPACE_MARKER } from '@deepseek-ai/dsh-subprocess'
import { canonicalizeWorkspace, readHostSource } from '@deepseek-ai/dsh-lsp-stdio'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

const execFileAsync = promisify(execFile)

let root: string
let ws: string
let ctx: Context
let fs: LocalFileSystem

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'lsp-host-')))
  ws = join(root, 'ws')
  await mkdir(ws)
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  fs = ctx.fs as LocalFileSystem
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

const BIG = 1_000_000

async function workspace() {
  return await canonicalizeWorkspace(fs, ws)
}

async function readSource(filePath: string, maxBytes = BIG, signal?: AbortSignal) {
  return await readHostSource(fs, filePath, await workspace(), maxBytes, signal)
}

describe('canonicalizeWorkspace', () => {
  it('returns the realpath of a directory', async () => {
    expect((await workspace()).canonicalPath).toBe(ws)
  })

  it('resolves a symlinked workspace to its target so aliases share identity', async () => {
    const link = join(root, 'ws-link')
    await symlink(ws, link)
    expect((await canonicalizeWorkspace(fs, link)).canonicalPath).toBe(ws)
  })

  it('rejects a missing workspace', async () => {
    await expect(canonicalizeWorkspace(fs, join(root, 'nope'))).rejects.toThrow(/not a directory/)
  })

  it('wraps a provider failure while resolving the workspace', async () => {
    fs.resolve = async () => { throw 'raw workspace resolve failure' }
    await expect(canonicalizeWorkspace(fs, ws))
      .rejects.toThrow(`workspace root "${ws}" cannot be resolved: raw workspace resolve failure`)
  })

  it('rejects a non-directory workspace', async () => {
    const file = join(root, 'file.txt')
    await writeFile(file, 'x')
    await expect(canonicalizeWorkspace(fs, file)).rejects.toThrow(/not a directory/)
  })

  it('normalizes workspace metadata cancellation and preserves other provider failures', async () => {
    const providerFailure = new Error('workspace metadata failed')
    fs.stat = async () => { throw providerFailure }
    await expect(canonicalizeWorkspace(fs, ws)).rejects.toBe(providerFailure)

    const controller = new AbortController()
    fs.stat = async () => {
      controller.abort(new Error('workspace metadata cancelled'))
      throw providerFailure
    }
    await expect(canonicalizeWorkspace(fs, ws, controller.signal))
      .rejects.toThrow('workspace metadata cancelled')
  })
})

describe('readHostSource', () => {
  it('maps a remote absolute source back through its verified local marker', async () => {
    await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
      version: 3,
      remoteRoot: '/srv/project',
      connectionId: 'connection-1',
      generation: 1,
      mode: 'agent',
    }))
    const workspaceTarget = { targetKey: FsTargetKey('remote-workspace'), displayPath: '/srv/project' }
    const sourceTarget = { targetKey: FsTargetKey('remote-source'), displayPath: '/srv/project/src/a.ts' }
    const calls: Array<{ path: string; cwd: string | undefined }> = []
    const remoteFs = {
      resolve: async (path: string, options?: { cwd?: string }) => {
        calls.push({ path, cwd: options?.cwd })
        return sourceTarget
      },
      contains: () => true,
      streamText: async () => (async function*() { yield 'const remote = true\n' })(),
      fileUrl: () => 'file:///srv/project/src/a.ts',
    } as unknown as FileSystem
    const remoteWorkspace = {
      target: workspaceTarget,
      canonicalPath: '/srv/project',
      fileUrl: 'file:///srv/project',
      fsCwd: join(root, 'stale-marker-path'),
      remoteTarget: {
        markerRoot: root,
        remoteRoot: '/srv/project',
        remotePath: '/srv/project',
        connectionId: 'connection-1',
        markerGeneration: 1,
        mode: 'agent' as const,
      },
    }

    await expect(readHostSource(remoteFs, '/srv/project/src/a.ts', remoteWorkspace, BIG)).resolves.toEqual({
      fileUrl: 'file:///srv/project/src/a.ts',
      text: 'const remote = true\n',
    })
    expect(calls).toEqual([{ path: join(root, 'src', 'a.ts'), cwd: root }])
  })

  it('reads a relative path against the workspace', async () => {
    await writeFile(join(ws, 'a.ts'), 'const x = 1\n')
    const source = await readSource('a.ts')
    expect(source.fileUrl).toBe(pathToFileURL(join(ws, 'a.ts')).href)
    expect(source.text).toBe('const x = 1\n')
  })

  it('reads an absolute path inside the workspace', async () => {
    const abs = join(ws, 'b.ts')
    await writeFile(abs, 'b')
    const source = await readSource(abs)
    expect(source.fileUrl).toBe(pathToFileURL(abs).href)
  })

  it('accepts a source reached through a symlink that stays inside the workspace', async () => {
    await mkdir(join(ws, 'real'))
    await writeFile(join(ws, 'real', 'c.ts'), 'c')
    await symlink(join(ws, 'real'), join(ws, 'linked'))
    const source = await readSource('linked/c.ts')
    expect(source.fileUrl).toBe(pathToFileURL(join(ws, 'real', 'c.ts')).href)
  })

  it('rejects a source whose canonical path escapes the workspace via symlink', async () => {
    const outside = join(root, 'outside.ts')
    await writeFile(outside, 'secret')
    await symlink(outside, join(ws, 'escape.ts'))
    await expect(readSource('escape.ts')).rejects.toThrow(/outside the workspace/)
  })

  it('rejects an absolute source outside the workspace', async () => {
    const outside = join(root, 'out.ts')
    await writeFile(outside, 'x')
    await expect(readSource(outside)).rejects.toThrow(/outside the workspace/)
  })

  it('rejects a missing source', async () => {
    await expect(readSource('nope.ts')).rejects.toThrow(/not found/)
  })

  it('wraps a provider failure while resolving the source', async () => {
    const canonical = await workspace()
    fs.resolve = async () => { throw 'raw resolve failure' }
    await expect(readHostSource(fs, 'broken.ts', canonical, BIG))
      .rejects.toThrow('source "broken.ts" cannot be resolved: raw resolve failure')
  })

  it('rejects a non-regular source (directory)', async () => {
    await mkdir(join(ws, 'dir'))
    await expect(readSource('dir')).rejects.toThrow(/not a regular file/)
  })

  // Windows has no filesystem FIFO; the directory case above pins non-regular rejection there.
  it.skipIf(process.platform === 'win32')('rejects a FIFO with no writer without blocking in open', async () => {
    const fifo = join(ws, 'pipe.ts')
    await execFileAsync('mkfifo', [fifo])
    using d = deadline(undefined, 1000, 'FIFO_READ_TIMEOUT')
    await expect(readSource('pipe.ts', BIG, d.signal)).rejects.toThrow(/not a regular file/)
  })

  it('honors a pre-aborted source read before filesystem work', async () => {
    const controller = new AbortController()
    controller.abort(new Error('source read cancelled'))
    await expect(readSource('missing.ts', BIG, controller.signal)).rejects.toThrow(/source read cancelled/)
  })

  it('treats the workspace root itself as inside, then rejects it as non-regular', async () => {
    // The filesystem containment primitive accepts the workspace itself; the
    // bounded read then rejects the directory as non-regular.
    await expect(readSource('.')).rejects.toThrow(/not a regular file/)
  })

  it('rejects an oversized source and reports the observed lower bound', async () => {
    await writeFile(join(ws, 'big.ts'), 'x'.repeat(100))
    await expect(readSource('big.ts', 10)).rejects.toMatchObject({
      message: 'source "big.ts" exceeds the 10-byte limit; reading stopped after 100 bytes',
    })
  })

  it('counts the complete UTF-8 byte length at the configured boundary', async () => {
    await writeFile(join(ws, 'multibyte.ts'), '€abc')
    await expect(readSource('multibyte.ts', 6)).resolves.toMatchObject({ text: '€abc' })
    await expect(readSource('multibyte.ts', 5)).rejects.toThrow(/5-byte limit/)
  })

  it('rejects a non-UTF-8 source', async () => {
    await writeFile(join(ws, 'bin.ts'), Buffer.from([0xff, 0xfe, 0x00]))
    await expect(readSource('bin.ts')).rejects.toThrow(/invalid UTF-8|binary file/)
  })

  it('keeps a valid U+FFFD replacement character in otherwise-valid UTF-8', async () => {
    // The literal replacement char is valid UTF-8; a fatal decoder must accept it (only malformed
    // byte sequences are rejected).
    await writeFile(join(ws, 'repl.ts'), 'const s = "�"\n')
    const source = await readSource('repl.ts')
    expect(source.text).toBe('const s = "�"\n')
  })
})
