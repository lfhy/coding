/**
 * 托管 helper 的启动契约：helper 只接受“受管父进程传输”，因此提供方的启动方式
 * 必须真的满足它的校验。本仓库不提交编译产物，缺少本地构建的 helper 时整组跳过。
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { resolveConfig } from '../src/config.ts'
import type { ComputerPermissionState } from '../src/types.ts'
import { NativeHelperClient } from '../src/providers/native-helper.ts'

const helperPath = new URL('../native/macos/bin/dsh-computer-use-helper', import.meta.url)
const manifestPath = new URL('../native/macos/manifest.json', import.meta.url)
const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const PERMISSION_STATES: readonly ComputerPermissionState[] = ['granted', 'denied', 'not-determined', 'unavailable']
const available = process.platform === 'darwin' && existsSync(helperPath) && existsSync(manifestPath)

describe.skipIf(!available)('managed helper transport', () => {
  it('answers health through the provider spawn path and pins its own version', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const client = new NativeHelperClient(ctx, resolveConfig({}))
    const signal = new AbortController().signal

    const prepared = await client.prepare(signal)
    expect(prepared.version).toBe(packageVersion)
    expect(prepared.path.endsWith('bin/dsh-computer-use-helper')).toBe(true)

    const health = await client.invoke<{
      helperVersion: string
      accessibility: ComputerPermissionState
      screenRecording: ComputerPermissionState
    }>({ command: 'health' }, signal)
    // 版本不一致说明 helper 与 TS 侧协议漂移，这一条比权限状态更重要。
    expect(health.helperVersion).toBe(packageVersion)
    expect(PERMISSION_STATES).toContain(health.accessibility)
    expect(PERMISSION_STATES).toContain(health.screenRecording)
    await client.dispose()
    await ctx.fiber.dispose()
  })
})
