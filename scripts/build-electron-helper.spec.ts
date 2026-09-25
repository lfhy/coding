import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildElectronHelper } from './build-electron-helper.ts'

let root: string

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'coding-electron-helper-test-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('buildElectronHelper', () => {
  it('拒绝非本机 macOS arm64 构建，且不会启动 Go', async () => {
    let called = false
    const run = async (): Promise<void> => { called = true }
    await expect(buildElectronHelper({ root, platform: 'linux', arch: 'arm64', run }))
      .rejects.toThrow('only native macOS arm64')
    await expect(buildElectronHelper({ root, platform: 'darwin', arch: 'x64', run }))
      .rejects.toThrow('only native macOS arm64')
    expect(called).toBe(false)
  })

  it('从 desktop 模块构建固定产物，不从链接器注入版本或签名', async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = []
    await buildElectronHelper({
      root, platform: 'darwin', arch: 'arm64',
      run: async (command, args, options) => { calls.push({ command, args, ...options }) },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      command: 'go',
      args: ['build', '-trimpath', '-buildvcs=false', '-o', join(root, 'dist', 'coding-electron-helper-darwin-arm64'), './cmd/electron-helper'],
      cwd: join(root, 'apps', 'desktop'),
      env: { CGO_ENABLED: '1', GOOS: 'darwin', GOARCH: 'arm64' },
    })
  })

  it('开发模式缺少任一 remote-agent 文件时提示构建，且不会启动 Go', async () => {
    let called = false
    await expect(buildElectronHelper({
      root, platform: 'darwin', arch: 'arm64', requireRemoteAgent: true,
      isRegularFile: async path => !path.endsWith('coding-remote-agent-linux-arm64'),
      run: async () => { called = true },
    })).rejects.toThrow('coding-remote-agent-linux-arm64); run pnpm run build:remote-agent first')
    expect(called).toBe(false)
  })

  it('开发模式具备 remote-agent 闭包时继续构建', async () => {
    const inspected: string[] = []
    let called = false
    await buildElectronHelper({
      root, platform: 'darwin', arch: 'arm64', requireRemoteAgent: true,
      isRegularFile: async (path) => { inspected.push(path); return true },
      run: async () => { called = true },
    })
    expect(inspected).toHaveLength(7)
    expect(inspected).toContain(join(root, 'dist', 'remote-agent', 'manifest.json'))
    expect(called).toBe(true)
  })
})
