import { describe, expect, it } from 'vitest'
import { deployProductionClosure } from './build-coding-runtime.ts'

interface Call {
  args: string[]
  command: string
}

describe('deployProductionClosure', () => {
  it('restores full workspace dependencies after the legacy production deploy', async () => {
    const calls: Call[] = []

    await deployProductionClosure('/tmp/runtime', async (command, args) => {
      calls.push({ args, command })
    })

    expect(calls).toEqual([
      {
        command: 'pnpm',
        args: [
          '--filter', 'coding-host-runtime', 'deploy', '--legacy', '--prod',
          '--config.node-linker=hoisted', '--config.auto-install-peers=false',
          '--config.link-workspace-packages=true', '/tmp/runtime',
        ],
      },
      {
        command: 'pnpm',
        args: ['install', '--frozen-lockfile', '--config.confirm-modules-purge=false'],
      },
    ])
  })

  it('still restores the workspace after deployment fails', async () => {
    const deploymentError = new Error('deploy failed')
    const calls: string[][] = []

    await expect(deployProductionClosure('/tmp/runtime', async (_command, args) => {
      calls.push(args)
      if (calls.length === 1) throw deploymentError
    })).rejects.toBe(deploymentError)

    expect(calls).toHaveLength(2)
    expect(calls[1]?.[0]).toBe('install')
  })

  it('fails the build when dependency restoration fails', async () => {
    const restorationError = new Error('restore failed')
    let invocation = 0

    await expect(deployProductionClosure('/tmp/runtime', async () => {
      invocation += 1
      if (invocation === 2) throw restorationError
    })).rejects.toBe(restorationError)
  })

  it('retains deployment and restoration errors when both fail', async () => {
    const deploymentError = new Error('deploy failed')
    const restorationError = new Error('restore failed')
    let invocation = 0

    await expect(deployProductionClosure('/tmp/runtime', async () => {
      invocation += 1
      throw invocation === 1 ? deploymentError : restorationError
    })).rejects.toEqual(expect.objectContaining({
      errors: [deploymentError, restorationError],
      message: 'build:runtime: production deploy failed and workspace dependencies could not be restored',
    }))
  })
})
