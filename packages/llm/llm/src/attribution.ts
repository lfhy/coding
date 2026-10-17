/**
 * 模型提供方请求共用的非秘密应用标识和 User-Agent。
 * @module coding-llm/attribution
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { arch, platform, release } from 'node:os'
import { resolve } from 'node:path'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/** 没有打包器内联时，源码环境根据仓库根目录确定短提交；发布产物不依赖 Git。 */
function sourceBuildCommit(): string {
  const root = resolve(import.meta.dirname, '../../../..')
  const value = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error('LLM source identity requires a Git commit hash')
  return value.slice(0, 6).toLowerCase()
}

/**
 * 产品身份保留给诊断和遥测；模型请求默认值由构建标识提供。
 * 自定义身份仍可通过 {@link userAgent} 和 {@link attributionHeaders} 使用。
 */
export interface AppIdentity {
  /** HTTP 产品名。 */
  product: string
  /** 产品版本。 */
  version: string
  /** 仓库地址。 */
  url: string
}

/** 本包的公开产品身份。 */
export const APP_IDENTITY: AppIdentity = {
  product: 'deepseek-harness',
  version,
  url: 'https://github.com/deepseek-ai/deepseek-harness',
}

/**
 * 将 Host 系统映射为 UA 中的操作系统版本；macOS 读取产品版本而非 Darwin 内核版本。
 * @param hostPlatform Node 平台标识。
 * @param hostRelease Node 内核版本。
 * @param macVersion macOS 产品版本；仅在 darwin 上读取。
 * @returns User-Agent 中的操作系统名和主版本。
 */
export function userAgentOS(hostPlatform: NodeJS.Platform, hostRelease: string, macVersion?: string): string {
  if (hostPlatform === 'darwin') {
    if (macVersion === undefined) throw new Error('macOS product version is required for the model User-Agent')
    return `MacOS ${macVersion.split('.')[0]}`
  }
  if (hostPlatform === 'win32') return `Windows ${hostRelease}`
  if (hostPlatform === 'linux') return `Linux ${hostRelease}`
  return `${hostPlatform} ${hostRelease}`
}

/**
 * 生成默认或显式指定的模型请求 User-Agent。
 * @param identity 可选的自定义身份；提供时保留既有 product/version 格式。
 * @returns ASCII HTTP User-Agent，默认包含构建时间、提交及本机系统信息。
 */
export function userAgent(identity?: AppIdentity): string {
  if (identity !== undefined) return `${identity.product}/${identity.version} (+${identity.url})`
  const date = process.env.DSH_LLM_BUILD_DATE ?? new Date().toISOString().slice(0, 10)
    .replace(/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/, '$1.$2$3')
  const commit = process.env.DSH_LLM_BUILD_COMMIT ?? sourceBuildCommit()
  const hostPlatform = platform()
  const hostVersion = hostPlatform === 'darwin'
    ? execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
    : undefined
  return `Coding/${date}.${commit} (${userAgentOS(hostPlatform, release(), hostVersion)};${arch()})`
}

/**
 * 生成提供方请求标头。
 * @param identity 可选的自定义应用身份。
 * @returns 只包含 User-Agent 的标头对象。
 */
export function attributionHeaders(identity?: AppIdentity): Record<string, string> {
  return { 'user-agent': userAgent(identity) }
}
