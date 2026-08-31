import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Lsp, { type LspProvider, type LspQueryRequest } from '@deepseek-ai/dsh-lsp'
import * as LspLocal from '@deepseek-ai/dsh-lsp-stdio'
import type { Config, LspLocalServerConfig } from '@deepseek-ai/dsh-lsp-stdio'
import type { RemoteWorkspaceTarget } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

let root: string
let ws: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'lsp-prov-')))
  ws = join(root, 'ws')
  await mkdir(ws)
  await writeFile(join(ws, 'a.ts'), 'const x = 1\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function query(): LspQueryRequest {
  return { operation: 'goToDefinition', filePath: 'a.ts', position: { line: 0, character: 0 }, workspaceRoot: ws }
}

/** Wrap one server entry in the plugin's named server table. */
function config(providerId: string, server: LspLocalServerConfig): Config {
  return { servers: { [providerId]: server } }
}

describe('lsp-stdio provider resolution', () => {
  it('defers bare command resolution until a workspace query', async () => {
    // 将微型可执行脚本放入自定义 PATH；注册阶段只校验配置，选择该 Workspace 的查询才调用解析器。
    const bin = join(root, 'bin')
    await mkdir(bin)
    const exe = join(bin, process.platform === 'win32' ? 'fake-lsp.cmd' : 'fake-lsp')
    await writeFile(exe, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n')
    if (process.platform !== 'win32') await chmod(exe, 0o755)

    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    const resolveExecutable = vi.spyOn(ctx.subprocess, 'resolveExecutable')
    await expect(ctx.plugin(LspLocal, config('onpath', {
      command: 'fake-lsp',
      args: [],
      env: { PATH: bin, ...process.platform === 'win32' ? { PATHEXT: '.CMD' } : {} },
      extensionToLanguage: { '.ts': 'typescript' },
    }))).resolves.toBeDefined()
    expect(resolveExecutable).not.toHaveBeenCalled()
    resolveExecutable.mockRestore()
    await ctx.fiber.dispose()
  })

  it('skips empty PATH segments and reports a missing command on query', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await expect(ctx.plugin(LspLocal, config('nope', {
      command: 'fake-lsp',
      args: [],
      env: { PATH: `${delimiter}${delimiter}${join(root, 'empty')}` },
      extensionToLanguage: { '.ts': 'typescript' },
    }))).resolves.toBeDefined()
    await expect(ctx.lsp.query(query())).rejects.toThrow(/was not found on PATH/)
    await ctx.fiber.dispose()
  })

  it('rejects a query after the provider is disposed', async () => {
    // Use a server that never emits results and dispose the plugin, then confirm queries are refused.
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    // Grab the provider instance by registering, then dispose the whole plugin fiber.
    const lsp = ctx.lsp
    const fiber = await ctx.plugin(LspLocal, config('disp', {
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      extensionToLanguage: { '.ts': 'typescript' },
    }))
    await fiber.dispose()
    // After disposal the provider unregistered from the seam, so selection fails as unavailable.
    await expect(lsp.query(query())).rejects.toThrow(expect.objectContaining({ code: 'LSP_UNAVAILABLE' }))
    await ctx.fiber.dispose()
  })

  it('rejects a nonpositive teardown budget at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await expect(ctx.plugin(LspLocal, config('bad-budget', {
      command: process.execPath,
      args: ['-e', ''],
      extensionToLanguage: { '.ts': 'typescript' },
      killGraceMs: 0,
    }))).rejects.toThrow(/servers\.bad-budget\.killGraceMs must be a positive integer/)
    await ctx.fiber.dispose()
  })

  it('rejects a nonpositive byte cap at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await expect(ctx.plugin(LspLocal, config('bad-cap', {
      command: process.execPath,
      args: ['-e', ''],
      extensionToLanguage: { '.ts': 'typescript' },
      maxDocumentBytes: 0,
    }))).rejects.toThrow(/servers\.bad-cap\.maxDocumentBytes must be a positive integer/)
    await ctx.fiber.dispose()
  })

  it.each(['shutdownTimeoutMs', 'killGraceMs'] as const)('rejects %s above Node timer range at load', async (name) => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await expect(ctx.plugin(LspLocal, config('bad-timer', {
      command: process.execPath,
      args: ['-e', ''],
      extensionToLanguage: { '.ts': 'typescript' },
      [name]: MAX_TIMER_DELAY_MS + 1,
    }))).rejects.toThrow(new RegExp(`servers\\.bad-timer\\.${name}`))
    await ctx.fiber.dispose()
  })

  // Node's X_OK probe is an existence check on Windows, which has no executable mode bit.
  it.skipIf(process.platform === 'win32')('rejects an absolute command that is not executable on query', async () => {
    const notExe = join(root, 'not-exe.txt')
    await writeFile(notExe, 'plain text, not executable')
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await expect(ctx.plugin(LspLocal, config('abs-bad', {
      command: notExe,
      args: [],
      extensionToLanguage: { '.ts': 'typescript' },
    }))).resolves.toBeDefined()
    await expect(ctx.lsp.query(query())).rejects.toThrow(/is not an executable file/)
    await ctx.fiber.dispose()
  })

  it('rejects an executable directory as a command on query', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await expect(ctx.plugin(LspLocal, config('abs-directory', {
      command: ws,
      args: [],
      extensionToLanguage: { '.ts': 'typescript' },
    }))).resolves.toBeDefined()
    await expect(ctx.lsp.query(query())).rejects.toThrow(/is not an executable file/)
    await ctx.fiber.dispose()
  })

  it('rejects an empty server table at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await expect(ctx.plugin(LspLocal, { servers: {} })).rejects.toThrow(/servers must contain at least one server/)
    await ctx.fiber.dispose()
  })

  it('rejects an empty server id at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await expect(ctx.plugin(LspLocal, config('', {
      command: process.execPath,
      extensionToLanguage: { '.ts': 'typescript' },
    }))).rejects.toThrow(/server ids must be non-empty strings/)
    await ctx.fiber.dispose()
  })

  it('publishes all providers before resolving their workspace executables', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    const fiber = await ctx.plugin(LspLocal, {
      servers: {
        valid: { command: process.execPath, extensionToLanguage: { '.ts': 'typescript' } },
        missing: { command: 'definitely-not-a-real-lsp-binary-xyz', extensionToLanguage: { '.py': 'python' } },
      },
    })
    await writeFile(join(ws, 'a.py'), 'x = 1\n')
    await expect(ctx.lsp.query({ ...query(), filePath: 'a.py' })).rejects.toThrow(/was not found on PATH/)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('resolves a remote workspace command with its marker identity', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    let provider: LspProvider | undefined
    const register = ctx.lsp.registerProvider.bind(ctx.lsp)
    const registration = vi.spyOn(ctx.lsp, 'registerProvider').mockImplementation((candidate) => {
      provider = candidate
      return register(candidate)
    })
    const fiber = await ctx.plugin(LspLocal, config('remote', {
      command: process.execPath,
      extensionToLanguage: { '.ts': 'typescript' },
    }))
    registration.mockRestore()
    if (provider === undefined) throw new Error('expected a registered provider')

    const remoteTarget: RemoteWorkspaceTarget = {
      markerRoot: root,
      remoteRoot: '/srv/project',
      remotePath: '/srv/project',
      connectionId: 'connection-1',
      markerGeneration: 1,
    }
    const remoteLookup = new Error('remote executable lookup')
    const resolveExecutable = vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementation(async (_command, _env, _signal, target) => {
      expect(target).toEqual(remoteTarget)
      throw remoteLookup
    })
    const createInstance = (provider as unknown as {
      createInstance(workspace: {
        target: { targetKey: ReturnType<typeof FsTargetKey>; displayPath: string }
        canonicalPath: string
        fileUrl: string
        remoteTarget: RemoteWorkspaceTarget
      }): Promise<unknown>
    }).createInstance.bind(provider)

    await expect(createInstance({
      target: { targetKey: FsTargetKey('remote-workspace'), displayPath: '/srv/project' },
      canonicalPath: '/srv/project',
      fileUrl: 'file:///srv/project',
      remoteTarget,
    })).rejects.toBe(remoteLookup)
    resolveExecutable.mockRestore()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('disposes an instance created while provider teardown wins the ownership race', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    let provider: LspProvider | undefined
    const register = ctx.lsp.registerProvider.bind(ctx.lsp)
    const registration = vi.spyOn(ctx.lsp, 'registerProvider').mockImplementation((candidate) => {
      provider = candidate
      return register(candidate)
    })
    const fiber = await ctx.plugin(LspLocal, config('ownership-race', {
      command: process.execPath,
      extensionToLanguage: { '.ts': 'typescript' },
    }))
    registration.mockRestore()
    if (provider === undefined) throw new Error('expected a registered provider')

    const createStarted = Promise.withResolvers<undefined>()
    const created = Promise.withResolvers<{ dispose(): Promise<void> }>()
    const disposed = vi.fn(async () => {})
    const internals = provider as unknown as {
      createInstance: () => Promise<{ dispose(): Promise<void> }>
      instanceFor: (workspaceKey: ReturnType<typeof FsTargetKey>, workspace: unknown) => Promise<unknown>
    }
    internals.createInstance = () => {
      createStarted.resolve(undefined)
      return created.promise
    }
    const workspace = {
      target: { targetKey: FsTargetKey('ownership-race'), displayPath: ws },
      canonicalPath: ws,
      fileUrl: 'file:///ownership-race',
    }
    const pending = internals.instanceFor(FsTargetKey('ownership-race'), workspace)
    await createStarted.promise
    const disposing = (provider as unknown as { disposeAll(): Promise<void> }).disposeAll()
    created.resolve({ dispose: disposed })

    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'LSP_DISPOSED' }))
    await expect(disposing).resolves.toBeUndefined()
    expect(disposed).toHaveBeenCalledOnce()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('cancels executable resolution after a workspace query starts', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    const started = Promise.withResolvers<AbortSignal>()
    const resolveExecutable = vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementation(async (_command, _env, signal) => {
      if (signal === undefined) throw new Error('missing query signal')
      started.resolve(signal)
      return await new Promise<string>((_resolve, reject) => {
        const onAbort = (): void => {
          reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
    })

    const fiber = await ctx.plugin(LspLocal, config('pending', {
      command: 'slow-lsp',
      extensionToLanguage: { '.ts': 'typescript' },
    }))
    const controller = new AbortController()
    const pending = ctx.lsp.query(query(), controller.signal)
    const signal = await started.promise
    controller.abort(new Error('query cancelled'))
    await expect(pending).rejects.toThrow('query cancelled')
    expect(signal.aborted).toBe(true)
    resolveExecutable.mockRestore()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('aborts executable resolution when the provider is disposed during a query', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    const subprocess = ctx.subprocess
    const lookupStarted = Promise.withResolvers<AbortSignal>()
    vi.spyOn(subprocess, 'resolveExecutable').mockImplementation(async (_command, _env, signal) => {
      if (signal === undefined) throw new Error('missing query signal')
      lookupStarted.resolve(signal)
      return await new Promise<string>((_resolve, reject) => {
        const onAbort = (): void => {
          reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
    })

    const fiber = await ctx.plugin(LspLocal, config('pending', {
      command: 'pending-lsp',
      extensionToLanguage: { '.ts': 'typescript' },
    }))
    const pending = ctx.lsp.query(query())
    const signal = await lookupStarted.promise
    const disposing = fiber.dispose()

    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'LSP_DISPOSED' }))
    await expect(disposing).resolves.toBeUndefined()
    expect(signal.aborted).toBe(true)
    await ctx.fiber.dispose()
  })

  it('rolls back earlier registrations when a later server conflicts', async () => {
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await expect(ctx.plugin(LspLocal, {
      servers: {
        first: { command: process.execPath, extensionToLanguage: { '.ts': 'typescript' } },
        second: { command: process.execPath, extensionToLanguage: { '.ts': 'typescript' } },
      },
    })).rejects.toThrow(expect.objectContaining({ code: 'LSP_CONFLICT' }))
    await expect(ctx.lsp.query(query())).rejects.toThrow(expect.objectContaining({ code: 'LSP_UNAVAILABLE' }))
    await ctx.fiber.dispose()
  })
})
