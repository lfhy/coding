/**
 * Host 库阶段构建：先由 tsc 发射 `lib/types`，再由 Host tsdown 生成 Typert 约定。
 *
 * 干净检出没有 Host-for-Client Remote 声明（例如 `coding-commands/remote`），
 * 而 Host aggregate 经 Web 测试会连带检查导入这些声明的 Client 代码，因此首遍
 * tsc 必然报缺模块。此时先生成约定再重跑一遍 tsc，最终结论以重跑结果为准：
 * 真实的类型错误仍会在重跑中暴露，不会因为引导失败而放过。
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { isDirectScriptEntry } from './build.ts'

const root = resolve(import.meta.dirname, '..')
const hostTsconfig = 'tsconfig.host.json'
const hostFace = ['--env.DSH_BUILD_FACE', 'host'] as const

/**
 * 以 pnpm 执行一个工作区命令并等待退出码；`pnpm exec` 由锁文件固定的依赖提供可执行文件。
 * @param args - 传给 `pnpm exec` 的参数，不含 `pnpm exec` 本身。
 * @returns 子命令的退出码；被信号终止时返回 1。
 */
function run(args: readonly string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('pnpm', ['exec', ...args], { cwd: root, env: process.env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      resolvePromise(code ?? 1)
    })
  })
}

/** 执行 Host tsc 阶段，返回退出码，由调用方判断是缺约定还是真实类型错误。 */
async function typecheckHost(): Promise<number> {
  return run(['tsc', '-b', hostTsconfig])
}

/** 执行一次 Host tsdown 阶段；失败即终止，后续 tsc 已无意义。 */
async function bundleHost(): Promise<void> {
  const code = await run(['tsdown', ...hostFace])
  if (code !== 0) {
    throw new Error(`build-lib-host: tsdown ${hostFace.join(' ')} exited ${String(code)}`)
  }
}

/** 阶段入口：允许首遍 tsc 缺约定失败，但重跑必须通过，最后统一打包一次。 */
async function main(): Promise<void> {
  const firstRun = await typecheckHost()
  if (firstRun !== 0) {
    console.log('build-lib-host: 首遍 tsc 未通过（干净检出通常缺少 Typert 约定），先生成约定后重跑 tsc')
    await bundleHost()
    const retry = await typecheckHost()
    if (retry !== 0) {
      throw new Error(`build-lib-host: tsc -b ${hostTsconfig} exited ${String(retry)}`)
    }
  }
  await bundleHost()
}

if (isDirectScriptEntry(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
