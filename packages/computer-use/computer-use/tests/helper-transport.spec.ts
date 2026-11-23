/**
 * 托管 helper 的启动契约：helper 只接受“受管父进程传输”，因此提供方的启动方式
 * 必须真的满足它的校验。真实调用只在显式启用且本机组件齐备时运行；启用后
 * 平台或构建产物缺失都应失败，不能把完整性与协议问题误报为跳过。
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from 'coding-subprocess-local'
import { resolveConfig } from '../src/config.ts'
import type { ComputerPermissionState } from '../src/types.ts'
import { NativeHelperClient } from '../src/providers/native-helper.ts'

const helperPath = new URL(
  '../native/macos/bin/Coding Computer Use.app/Contents/MacOS/dsh-computer-use-helper',
  import.meta.url,
)
const manifestPath = new URL('../native/macos/manifest.json', import.meta.url)
const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const PERMISSION_STATES: readonly ComputerPermissionState[] = ['granted', 'denied', 'not-determined', 'unavailable']

function skipNativeHelperTransport(options: {
  optIn: string | undefined
  platform: string
  helperExists: boolean
  manifestExists: boolean
}): boolean {
  if (options.optIn !== '1') return true
  if (options.platform !== 'darwin') {
    throw new Error(`DSH_COMPUTER_USE_NATIVE_TEST=1 requires macOS (current platform: ${options.platform})`)
  }
  if (!options.helperExists) {
    throw new Error('DSH_COMPUTER_USE_NATIVE_TEST=1 requires the managed helper executable; run build:native first')
  }
  if (!options.manifestExists) {
    throw new Error('DSH_COMPUTER_USE_NATIVE_TEST=1 requires native/macos/manifest.json; run build:native first')
  }
  return false
}

describe('managed helper transport opt-in', () => {
  it.each([undefined, '0', 'yes'])('skips without the exact opt-in value %s even with local artifacts', (optIn) => {
    expect(skipNativeHelperTransport({ optIn, platform: 'darwin', helperExists: true, manifestExists: true })).toBe(true)
  })

  it('skips without opt-in even when the platform and artifacts are unavailable', () => {
    expect(skipNativeHelperTransport({ optIn: undefined, platform: 'linux', helperExists: false, manifestExists: false })).toBe(true)
  })

  it('runs when explicitly enabled on macOS with both artifacts', () => {
    expect(skipNativeHelperTransport({ optIn: '1', platform: 'darwin', helperExists: true, manifestExists: true })).toBe(false)
  })

  it('fails clearly for an enabled non-macOS run', () => {
    expect(() => skipNativeHelperTransport({ optIn: '1', platform: 'linux', helperExists: true, manifestExists: true }))
      .toThrow('DSH_COMPUTER_USE_NATIVE_TEST=1 requires macOS')
  })

  it('fails clearly for an enabled run without the helper', () => {
    expect(() => skipNativeHelperTransport({ optIn: '1', platform: 'darwin', helperExists: false, manifestExists: true }))
      .toThrow('requires the managed helper executable')
  })

  it('fails clearly for an enabled run without the manifest', () => {
    expect(() => skipNativeHelperTransport({ optIn: '1', platform: 'darwin', helperExists: true, manifestExists: false }))
      .toThrow('requires native/macos/manifest.json')
  })
})

describe.skipIf(skipNativeHelperTransport({
  optIn: process.env.DSH_COMPUTER_USE_NATIVE_TEST,
  platform: process.platform,
  helperExists: existsSync(helperPath),
  manifestExists: existsSync(manifestPath),
}))('managed helper transport', () => {
  it('answers health through the provider spawn path and pins its own version', async () => {
    const ctx = new Context()
    const client = new NativeHelperClient(ctx, resolveConfig({}))
    const signal = new AbortController().signal

    try {
      await ctx.plugin(LocalSubprocessRuntime)
      const prepared = await client.prepare(signal)
      expect(prepared.version).toBe(packageVersion)
      expect(prepared.path.endsWith('Coding Computer Use.app/Contents/MacOS/dsh-computer-use-helper')).toBe(true)

      const health = await client.invoke<{
        helperVersion: string
        accessibility: ComputerPermissionState
        screenRecording: ComputerPermissionState
      }>({ command: 'health' }, signal)
      // 版本不一致说明 helper 与 TS 侧协议漂移，这一条比权限状态更重要。
      expect(health.helperVersion).toBe(packageVersion)
      expect(PERMISSION_STATES).toContain(health.accessibility)
      expect(PERMISSION_STATES).toContain(health.screenRecording)
    } finally {
      await client.dispose()
      await ctx.fiber.dispose()
    }
  })
})
