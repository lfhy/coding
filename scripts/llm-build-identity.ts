/** 为 Host 构建产物固定模型请求的日期和源码修订号。 */

import { execFileSync } from 'node:child_process'

/**
 * 生成一次 Host 构建使用的公开版本字段；时间采用 UTC，同一次构建的所有包共享。
 * @param root Git 仓库根目录。
 * @param now 本次构建的时间。
 * @returns 可供打包器内联的日期和六位提交哈希。
 */
export function llmBuildIdentity(root: string, now: Date = new Date()): { date: string; commit: string } {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('llm build identity requires a Git commit hash')
  if (Number.isNaN(now.getTime())) throw new Error('llm build identity requires a valid build time')
  const isoDate = now.toISOString().slice(0, 10)
  return {
    date: `${isoDate.slice(0, 4)}.${isoDate.slice(5, 7)}${isoDate.slice(8, 10)}`,
    commit: commit.slice(0, 6).toLowerCase(),
  }
}
