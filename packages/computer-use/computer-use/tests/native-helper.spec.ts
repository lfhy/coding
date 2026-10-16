/** 托管 helper 的完整性门禁：缺文件、哈希不符与可执行位都必须按失败处理。 */

import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from '../src/config.ts'
import { ComputerUseError } from '../src/errors.ts'
import { NativeHelperClient } from '../src/providers/native-helper.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function managedRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-computer-use-helper-'))
  await mkdir(join(root, 'bin'), { recursive: true })
  return root
}

async function writeHelper(directory: string, content: string): Promise<string> {
  const path = join(directory, 'bin', 'dsh-computer-use-helper')
  await writeFile(path, content)
  await chmod(path, 0o644)
  return path
}

async function writeManifest(directory: string, sha256: string, version = '0.1.0-rc.8'): Promise<void> {
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    helperVersion: version,
    sourceSha256: 'unused-by-the-provider',
    binary: { path: 'bin/dsh-computer-use-helper', sha256, architectures: ['arm64'], minimumMacOS: '14.0' },
  }, null, 2)}\n`)
}

function client(directory: string, options: { allowSourceBuild?: boolean; path?: string } = {}): NativeHelperClient {
  const config = resolveConfig({
    helper: {
      ...options.path === undefined ? {} : { path: options.path },
      allowSourceBuild: options.allowSourceBuild ?? false,
    },
  })
  return new NativeHelperClient(new Context(), config, directory)
}

/** 错误码断言集中在拿到 ComputerUseError 之后，避免把别的失败当成预期。 */
function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ComputerUseError)
  expect((error as ComputerUseError).code).toBe(code)
}

describe('NativeHelperClient.prepare', () => {
  it('fails closed when the managed helper is missing and source builds are not allowed', async () => {
    const directory = await managedRoot()
    await expect(client(directory).prepare(new AbortController().signal))
      .rejects.toThrow('native helper is missing or unreadable')
  })

  it('rejects a helper whose bytes do not match the pinned manifest hash', async () => {
    const directory = await managedRoot()
    await writeHelper(directory, 'not the pinned helper')
    await writeManifest(directory, 'a'.repeat(64))
    const failure = await client(directory).prepare(new AbortController().signal).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ComputerUseError)
    expect((failure as Error).message).toContain('hash does not match')
  })

  it('accepts a matching manifest and restores the owner execute bit', async () => {
    const directory = await managedRoot()
    const path = await writeHelper(directory, 'helper payload')
    const digest = createHash('sha256').update('helper payload').digest('hex')
    await writeManifest(directory, digest, '9.9.9')
    const prepared = await client(directory).prepare(new AbortController().signal)
    expect(prepared).toMatchObject({ path: await realpath(path), version: '9.9.9', sha256: digest })
    expect((await stat(path)).mode & 0o100).toBe(0o100)
  })

  it('treats an explicit external helper as unversioned without consulting the manifest', async () => {
    const directory = await managedRoot()
    const path = await writeHelper(directory, 'external helper')
    await chmod(path, 0o755)
    const prepared = await client(directory, { path }).prepare(new AbortController().signal)
    expect(prepared).toMatchObject({ version: 'external' })
    expect(prepared.sha256).toBe(createHash('sha256').update('external helper').digest('hex'))
  })

  it('refuses a non-macOS host before touching the filesystem', async () => {
    const directory = await managedRoot()
    if (process.platform === 'darwin') return
    const failure = await client(directory).prepare(new AbortController().signal).catch((error: unknown) => error)
    expectCode(failure, 'COMPUTER_UNSUPPORTED_PLATFORM')
  })
})
