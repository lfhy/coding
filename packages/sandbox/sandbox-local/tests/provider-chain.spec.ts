/**
 * 通过真实 LocalSandboxProvider.confine() 检查 win32 链的参数、拒绝签名和 runner 失败规则。
 * 注入平台与 runner 前缀，使断言在所有平台运行；原生 runner 行为由 Windows 专属测试覆盖。
 */

import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

const RO: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws' }
const WW: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/ws' }

async function setup(internals: LocalSandboxProvider['internals']) {
  const ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = internals
  return sandbox
}

describe('windows-acl win32 chain (LocalSandboxProvider)', () => {
  it('agentless workspace-write: runner argv prefix, temp root, mode flag, partial enforcement, ACL denial dialect', async () => {
    const probeWindowsAcl = vi.fn(() => true)
    const sandbox = await setup({
      platform: 'win32',
      windowsAclRunnerArgs: ['node', 'windows-acl-runner.js'],
      probeWindowsAcl,
    })
    const confined = sandbox.confine(['pwsh', '/Command', 'x'], WW)
    expect(confined.argv).toEqual([
      'node', 'windows-acl-runner.js',
      '--workspace', '/ws',
      '--temp', tmpdir(),
      '--mode', 'workspace-write',
      '--',
      'pwsh', '/Command', 'x',
    ])
    expect(confined.enforcement).toBe('partial')
    expect(confined.denialSignatures).toEqual(['access is denied', 'access to the path', 'permission denied'])
    expect(confined.runnerFailureRules).toEqual([{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }])
    // 单一候选 runner 无需探测即可选中。
    expect(probeWindowsAcl).not.toHaveBeenCalled()
  })

  it('read-only: same runner and contract, read-only mode flag', async () => {
    const sandbox = await setup({ platform: 'win32', windowsAclRunnerArgs: ['node', 'windows-acl-runner.js'] })
    const confined = sandbox.confine(['true'], RO)
    expect(confined.argv.slice(-4)).toEqual(['--mode', 'read-only', '--', 'true'])
    expect(confined.enforcement).toBe('partial')
    expect(confined.runnerFailureRules).toEqual([{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }])
  })
})
