/**
 * Coding 管理的本地 Host 发现、就绪和空闲退出。该模块属于 Web bundle，
 * 因为 Web profile 拥有回环服务器和两条客户端下行 socket。
 * @module @deepseek-ai/dsh-web-app/managed-host
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { WebClientConnections } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-jobs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** 所有 Coding 原生客户端都能识别的本地发现协议。 */
export const CODING_HOST_PROTOCOL = 1

/** 受管理 Host 存活时保存在共享 Harness home 中的文件名。 */
export const CODING_HOST_RECORD_FILENAME = 'host.json'

/** 一条供机器读取的受管理 Host 就绪/发现记录。 */
export interface CodingHostRecord {
  /** 供启动器扫描 Host stdout 的稳定判别字段。 */
  type: 'coding-host-ready'
  /** 回环 HTTP 监听端口。 */
  port: number
  /** 拥有这条精确记录的进程。 */
  pid: number
  /** 用于兼容性检查的产品运行时版本。 */
  version: string
  /** 带版本的原生客户端/Host 发现协议。 */
  protocol: number
  /** 随机记录所有权 token；原生客户端不会解释其语义。 */
  token: string
}

/** Web 运行时在完整 Loader 树结算后解析出的选项。 */
export interface ManagedHostOptions {
  /** 从 `ctx.webServer` 读取的已绑定回环端口。 */
  port: number
  /** 最后一个客户端和活跃工作消失后的空闲延迟。 */
  idleTimeoutMs: number
  /** 用于隔离测试的可选 home 覆盖。 */
  home?: string
  /** 用于隔离测试的可选运行时版本覆盖。 */
  version?: string
}

/** 解析一个共享 Harness home 的记录路径。 */
export function codingHostRecordPath(home: string = resolveDshHome()): string {
  return join(home, CODING_HOST_RECORD_FILENAME)
}

/** 通过同目录临时文件和原子 rename 写入一条记录。 */
export async function writeCodingHostRecord(home: string, record: CodingHostRecord): Promise<void> {
  await mkdir(home, { recursive: true })
  const path = codingHostRecordPath(home)
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** 仅当当前 Host 仍拥有 token 时删除记录。 */
export async function removeCodingHostRecord(home: string, token: string): Promise<void> {
  const path = codingHostRecordPath(home)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as { token?: unknown }).token !== token) return
  await rm(path, { force: true })
}

/** 当 Agent 或后台任务仍拥有活跃工作时返回 true。 */
function hasActiveWork(ctx: Context): boolean {
  const agents = ctx.agents.list()
  if (agents.some(agent => agent.status === 'running')) return true
  const jobs = ctx.get('jobs')
  if (jobs === undefined) return false
  try {
    const snapshots = [
      ...jobs.list(),
      ...agents.flatMap(agent => jobs.list(agent)),
    ]
    return snapshots.some(job => job.status === 'running' || job.status === 'stopping')
  } catch (error) {
    // 注册表的销毁若与这次读取竞争，不能证明工作已经消失。保持 Host 存活，
    // 等待后续生命周期信号。
    ctx.logger.warn(`coding managed host: unable to inspect active jobs: ${String(error)}`)
    return true
  }
}

/** 安装就绪后的空闲计时器和记录清理 effect。 */
function installManagedHostLifecycle(
  ctx: Context,
  connections: WebClientConnections,
  home: string,
  record: CodingHostRecord,
  idleTimeoutMs: number,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let exitRequested = false
  const clearTimer = (): void => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }
  const evaluateIdle = (): void => {
    if (exitRequested || connections.count !== 0 || hasActiveWork(ctx)) {
      clearTimer()
      return
    }
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (connections.count !== 0 || hasActiveWork(ctx) || exitRequested) return
      exitRequested = true
      const exit = ctx.get('appExit')
      if (exit === undefined) {
        ctx.logger.error('coding managed host: appExit disappeared before idle shutdown')
        return
      }
      exit(0)
    }, idleTimeoutMs)
  }
  const unsubscribeConnections = connections.subscribe(evaluateIdle)
  const unsubscribeAgentStatus = ctx.on('agent/status', evaluateIdle)
  const jobs = ctx.get('jobs')
  const unsubscribeJobs = jobs?.onJobsChanged(evaluateIdle)
  ctx.effect(() => async () => {
    clearTimer()
    unsubscribeConnections()
    unsubscribeAgentStatus()
    unsubscribeJobs?.()
    await removeCodingHostRecord(home, record.token)
  }, 'coding managed host lifecycle')
  evaluateIdle()
}

/**
 * 发布已就绪的受管理 Host 并安装其生命周期。只能在完整 Loader 树结算后调用，
 * 使观察到记录的客户端可以立刻打开两条 API 下行连接。
 */
export async function startManagedHost(ctx: Context, options: ManagedHostOptions): Promise<CodingHostRecord> {
  const connections = ctx.get('webClientConnections')
  if (connections === undefined) {
    throw new Error('coding managed host: client-connection WebSocket tracking is unavailable')
  }
  if (ctx.get('appExit') === undefined) {
    throw new Error('coding managed host: launcher appExit is unavailable')
  }
  const home = options.home ?? resolveDshHome()
  const record: CodingHostRecord = {
    type: 'coding-host-ready',
    port: options.port,
    pid: process.pid,
    version: options.version ?? process.env.DSH_APP_VERSION ?? '0.0.0',
    protocol: CODING_HOST_PROTOCOL,
    token: randomUUID(),
  }
  await writeCodingHostRecord(home, record)
  installManagedHostLifecycle(ctx, connections, home, record, options.idleTimeoutMs)
  return record
}
