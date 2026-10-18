/**
 * 免费节点订阅刷新：从公开代理列表拉取新节点、替换订阅来源的池内节点，
 * 并把镜像前缀回退链用于 raw.githubusercontent.com 的可达性。
 *
 * 订阅源给出的是「分钟级寿命」的免费节点目录，静态导入几分钟就过期——
 * 因此刷新是周期动作：每次先探测候选再入池（入池即健康，避免把整轮死节点
 * 灌给转发路径），替换只针对本次拉到的地址集合；用户手工导入的节点
 * （不在订阅地址集里的）不动。
 *
 * @module coding-proxy-pool/refresh
 */

import { parseProxyLink } from './links.ts'
import type { ProxyNode } from './types.ts'

/** 一次刷新的输入配置。 */
export interface RefreshOptions {
  /** 每次入池的目标节点数（按源顺序取探测成功的最先 N 个）。 */
  targetCount?: number
  /** 单个候选探测的并发上限。 */
  concurrency?: number
  /** 探测超时毫秒。 */
  probeTimeoutMs?: number
  /** 拉取订阅的信号。 */
  signal?: AbortSignal
}

/** 一次刷新的结果摘要。 */
export interface RefreshResult {
  /** 探测通过并进入池的新节点。 */
  admitted: ProxyNode[]
  /** 池内因本次刷新被替换/移除的订阅节点 id。 */
  evicted: string[]
  /** 拉取与探测过程中的失败摘要（不中止整轮）。 */
  failures: string[]
}

/** raw.githubusercontent.com 的镜像回退链：直连在最前，失败逐个降级。 */
const RAW_MIRRORS = [
  '',
  'https://gh-proxy.com/',
] as const

/** 订阅源定义：文本行或 JSON 数组，产出标准分享链接。 */
export interface ProxyFeed {
  /** 源标识（诊断用）。 */
  id: string
  /** 订阅 URL（raw.githubusercontent.com 形态，走镜像链）。 */
  url: string
  /** 响应形态。 */
  kind: 'links' | 'proxifly-json'
}

/** 内置订阅源：两个互补的公开免费代理目录（HTTP 代理对 LLM API 足够）。 */
export const DEFAULT_FEEDS: readonly ProxyFeed[] = [
  {
    id: 'proxifly-http',
    url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.json',
    kind: 'proxifly-json',
  },
  {
    id: 'monosans-http',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    kind: 'links',
  },
]

/**
 * 拉取一个订阅源：直连失败时按镜像链降级重试。
 * @param feed - 订阅源定义。
 * @param signal - 取消信号。
 * @returns 响应正文文本。
 * @throws Error 全部形态（直连与镜像）都失败时抛出最后一个错误。
 */
export async function fetchFeed(feed: ProxyFeed, signal?: AbortSignal): Promise<string> {
  let lastError: unknown
  for (const prefix of RAW_MIRRORS) {
    try {
      const response = await fetch(`${prefix}${feed.url}`, {
        ...signal === undefined ? {} : { signal },
        headers: { accept: 'application/json, text/plain, */*' },
      })
      if (!response.ok) throw new Error(`feed ${feed.id} via ${prefix || 'direct'} answered ${response.status}`)
      return await response.text()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 把订阅正文解析成候选节点（解析失败的行直接丢弃）。 */
function parseFeed(feed: ProxyFeed, body: string): ProxyNode[] {
  if (feed.kind === 'links') {
    return body.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(line))
      .map(line => parseProxyLink(`http://${line}`))
  }
  const entries = JSON.parse(body) as { ip?: unknown; port?: unknown; protocol?: unknown }[]
  return entries
    .filter((entry): entry is { ip: string; port: number; protocol: string } =>
      typeof entry.ip === 'string' && typeof entry.port === 'number' && typeof entry.protocol === 'string')
    .filter(entry => entry.protocol === 'http')
    .map(entry => parseProxyLink(`http://${entry.ip}:${entry.port}`))
}

/** 候选节点按地址去重（保留首个）。 */
function dedupeByAddress(nodes: readonly ProxyNode[]): ProxyNode[] {
  const seen = new Set<string>()
  const out: ProxyNode[] = []
  for (const node of nodes) {
    const key = `${node.address}:${node.port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(node)
  }
  return out
}

/** 一次刷新的池控制面：探测带独立超时（比周期健康检查更紧）。 */
export interface RefreshablePool {
  listNodes(): readonly ProxyNode[]
  registerNode(node: ProxyNode): () => void
  unregisterNode(nodeId: string): boolean
  checkNode(nodeId: string, timeoutMs?: number): Promise<{ alive: boolean } | undefined>
  /** 可选：原地改显示名（探测通过的候选改 feed: 前缀用；缺席则重注册）。 */
  renameNode?(nodeId: string, name: string): void
}

/** 候选探测的独立超时上限（免费节点普遍慢，但探测窗口必须比健检更紧）。 */
const PROBE_TIMEOUT_MS = 5_000

/** 候选探测并发：8 个死节点各占 5s 也只是一轮 5s 的时间成本。 */
const PROBE_CONCURRENCY = 8

/**
 * 对候选节点做一轮探测，返回最先通过的 N 个。
 * 探测即「经该节点拨号到公网 TCP 目标」——与池的健康检查同一条路径。
 */
async function probeFirstAlive(
  candidates: readonly ProxyNode[],
  count: number,
  probe: (node: ProxyNode) => Promise<boolean>,
): Promise<ProxyNode[]> {
  const admitted: ProxyNode[] = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (admitted.length < count && cursor < candidates.length) {
      const node = candidates[cursor]
      cursor += 1
      if (node === undefined || !(await probe(node))) continue
      admitted.push(node)
    }
  }
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker))
  return admitted.slice(0, count)
}

/**
 * 刷新一个池的订阅节点集合。
 *
 * 语义：`pool` 的现有节点里，凡地址出现在本次候选集且未通过探测的，视为过期
 * 移除；通过探测的新地址入池。地址不在候选集、也不在 `protectedIds` 里的
 * 旧订阅节点同样移除（源已经不再列出它们）。手工节点以 `isManaged` 区分，
 * 刷新绝不触碰。
 * @param pool - 池的控制面（注册/注销/探测）。
 * @param options - 刷新参数。
 * @returns 本次刷新摘要。
 */
export async function refreshPoolNodes(
  pool: RefreshablePool,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const resolved = {
    targetCount: options.targetCount ?? 5,
    ...options.signal === undefined ? {} : { signal: options.signal },
  }
  const failures: string[] = []
  const candidates: ProxyNode[] = []
  for (const feed of DEFAULT_FEEDS) {
    try {
      candidates.push(...parseFeed(feed, await fetchFeed(feed, resolved.signal)))
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (candidates.length === 0) {
    return { admitted: [], evicted: [], failures: [...failures, 'no feed produced candidates'] }
  }
  const unique = dedupeByAddress(candidates)

  // 候选探测：新地址直接探测；已在池里的地址按现有健康记录免探。
  const existingByKey = new Map(pool.listNodes().map(node => [`${node.address}:${node.port}`, node]))
  const fresh = unique.filter(node => !existingByKey.has(`${node.address}:${node.port}`))
  const probe = async (node: ProxyNode): Promise<boolean> => {
    // 注册即用 feed: 名：探测通过的候选无需改名（id 与健康记录原样保留），
    // 失败者撤销注册。没有 renameNode 的池实现也不需要兜底路径。
    const registered = pool.registerNode({ ...node, name: `feed:${node.address}` })
    const health = await pool.checkNode(node.id, PROBE_TIMEOUT_MS)
    if (health?.alive === true) return true
    registered()
    return false
  }
  const admittedFresh = await probeFirstAlive(fresh, resolved.targetCount, probe)

  // 替换：旧的订阅地址不在「本次通过集合 ∪ 候选集」里的，移除。
  const keepAddresses = new Set([
    ...admittedFresh.map(node => `${node.address}:${node.port}`),
    ...unique.map(node => `${node.address}:${node.port}`),
  ])
  const evicted: string[] = []
  for (const node of pool.listNodes()) {
    const key = `${node.address}:${node.port}`
    if (node.name.startsWith('feed:')) {
      if (!keepAddresses.has(key)) {
        pool.unregisterNode(node.id)
        evicted.push(node.id)
      }
    }
  }
  return { admitted: admittedFresh, evicted, failures }
}
