/**
 * 代理池服务：节点/组注册表、健康检查循环、fallback/url-test 组选择与本地
 * HTTP 代理入站（伴随宿主生命周期启动与停止）。
 *
 * 消费方（Free 渠道、DeepSeek 渠道等）只依赖 `ctx.proxyPool`：
 * - `proxyURL({ kind: 'pool' })` 按**池自己的出站控制**返回地址：直连规则返回
 *   `undefined`（消费方回落直连），自定义代理规则返回池配置的代理地址，本地池
 *   规则返回本地入站地址；
 * - `outbound` 报告池出站规则（`direct` / `pool` / `custom`）；
 * - 渠道级出站（直连／内置代理池／自定义代理）由消费方自己保存，经 `./outbound.ts`
 *   的 `resolveOutboundURL` 解析成本请求的地址，语义与 `proxyURL` 一致；
 * - 节点/组变更经 `ctx.on('proxy-pool/node', ...)` 发布。
 *
 * 后台循环（健康探测与订阅刷新）只在池出站规则为 `pool` 时运行。
 *
 * @module coding-proxy-pool
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { dialThrough } from './dialer.ts'
import { mirrorPoolNodes } from './persist.ts'
import { refreshPoolNodes } from './refresh.ts'
import type { RefreshResult } from './refresh.ts'
import { installPoolOutbound } from './settings.ts'
import type { ProxyPoolSettings } from './settings.ts'
import type { ProxyGroup, ProxyHealth, ProxyNode, ProxyPoolNodeEvent } from './types.ts'
import { ProxyPoolError } from './types.ts'

/** 出站模式：直连、代理池或用户提供的自定义代理地址。 */
export type ProxyMode =
  | { kind: 'direct' }
  | { kind: 'pool'; groupId?: string }
  | { kind: 'custom'; url: string }

export {
  ProxyPoolError,
} from './types.ts'
export type {
  ProxyGroup,
  ProxyGroupStrategy,
  ProxyHealth,
  ProxyNode,
  ProxyPoolNodeEvent,
  ProxyProtocol,
  ProxyTls,
  ProxyTransport,
  ProxyWsTransport,
} from './types.ts'
export {
  parseProxyLink,
  parseProxyLinks,
} from './links.ts'
export {
  mirrorPoolNodes,
  serializeNodes,
  PROXY_POOL_NODES_SETTINGS_NAMESPACE,
} from './persist.ts'
export type { ProxyPoolNodesSettings } from './persist.ts'
export {
  refreshPoolNodes,
  fetchFeed,
  DEFAULT_FEEDS,
} from './refresh.ts'
export type { ProxyFeed, RefreshOptions, RefreshResult } from './refresh.ts'
export {
  installPoolOutbound,
  PROXY_POOL_SETTINGS_NAMESPACE,
  resolvePoolOutbound,
} from './settings.ts'
export type { ProxyPoolMode, ProxyPoolSettings } from './settings.ts'
export {
  assertUsableOutbound,
  OutboundConfigSchema,
  resolveOutboundURL,
  toProxyMode,
} from './outbound.ts'
export type { OutboundConfig, OutboundMode } from './outbound.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 代理池：节点注册表 + 本地 HTTP 代理入站 + 组选择。 */
    proxyPool: ProxyPoolService
  }

  interface Events {
    /**
     * 节点级事件：新增/更新/移除/健康变化。监听方（代理池管理页）据此刷新
     * 展示；事件在状态已提交后同步派发。
     * @mode broadcast
     */
    'proxy-pool/node'(event: ProxyPoolNodeEvent): void
  }
}

/** 健康检查配置。 */
export interface HealthCheckOptions {
  /** 探测间隔毫秒；缺省 60_000。 */
  intervalMs?: number
  /** 探测超时毫秒；缺省 8_000。 */
  timeoutMs?: number
}

/** 订阅刷新配置。 */
export interface RefreshConfig {
  /** 池启用时是否自动刷新订阅；缺省 true（免费节点分钟级寿命，静态池没有意义）。 */
  enabled?: boolean
  /** 刷新间隔毫秒；缺省 300_000（5 分钟，与免费目录的更新节奏匹配）。 */
  intervalMs?: number
  /** 每次刷新维持的订阅节点数；缺省 5。 */
  targetCount?: number
}

/** 服务配置：入站监听与健康检查节奏。 */
export interface Config {
  /** 本地 HTTP 代理监听端口；0（缺省）表示选一个空闲端口。 */
  listenPort?: number
  /** 仅接受回环连接；缺省 true。 */
  loopbackOnly?: boolean
  /** 健康检查节奏。 */
  health?: HealthCheckOptions
  /** 订阅刷新节奏。 */
  refresh?: RefreshConfig
}

/**
 * 代理池服务。一个实例伴随宿主存活：构造后启动本地 HTTP 入站，fiber 释放时
 * 停止监听与后台循环，不留下端口或悬挂定时器。
 *
 * 池规则（`proxy-pool` 设置分节的 `mode`）决定后台是否工作：`direct` 时既
 * 不探测节点也不拉订阅，`proxyURL({ kind: 'pool' })` 返回 undefined，消费方
 * 据此回落直连；`pool` 时才启动健康检查与周期刷新。
 */
export class ProxyPoolService extends Service {

  private nodes = new Map<string, ProxyNode>()
  private groups = new Map<string, ProxyGroup>()
  private health = new Map<string, ProxyHealth>()
  private server: Server | undefined
  private readonly healthOptions: Required<HealthCheckOptions>
  private readonly refreshOptions: Required<RefreshConfig>
  /** 进行中的订阅刷新（手动触发与周期触发共享，避免并发放大探测流量）。 */
  private refreshing: Promise<RefreshResult> | undefined
  /** 当前池出站控制；设置到达前保持直连。 */
  private poolOutbound: ProxyPoolSettings = { mode: 'direct' }
  /** 后台循环是否在运行；与 {@link poolOutbound} 一起构成停启的幂等判据。 */
  private backgroundActive = false
  private healthTimer: ReturnType<typeof setInterval> | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'proxyPool')
    this.healthOptions = {
      intervalMs: config.health?.intervalMs ?? 60_000,
      timeoutMs: config.health?.timeoutMs ?? 8_000,
    }
    this.refreshOptions = {
      enabled: config.refresh?.enabled ?? true,
      intervalMs: config.refresh?.intervalMs ?? 300_000,
      targetCount: config.refresh?.targetCount ?? 5,
    }
    ctx.effect(() => this.start(config), 'proxyPool.start')
    // 池出站随设置变化停启后台循环；没有设置提供方时保持直连，不发任何后台请求。
    installPoolOutbound(ctx, (outbound) => { this.applyOutbound(outbound) })
    // 节点持久化随服务生命周期安装：设置提供方可用时镜像注册表（重放 +
    // 写回），缺席时为 no-op。挂在构造里而不是单独的 apply 入口，因为
    // Loader 取 .default 类导出构造服务，命名导出的 apply 不会运行。
    mirrorPoolNodes(ctx, this, node => this.registerNode(node))
  }

  /** 启动入站服务器；返回 disposer 一并停止后台循环与监听。 */
  private start(config: Config): () => void {
    const loopback = config.loopbackOnly !== false
    const server = createServer()
    server.on('connect', (req, clientSocket: Socket, head) => { this.handleConnect(req, clientSocket, head) })
    // 明文 http:// 目标：undici 的 ProxyAgent 不走 CONNECT，而是把绝对 URI
    // 作为路径发给代理（正向代理语义）；这里把它翻译成一次经出站节点的转发。
    server.on('request', (req, res) => { this.handleForward(req, res) })
    server.listen(config.listenPort ?? 0, loopback ? '127.0.0.1' : undefined)
    this.server = server
    this.listening = new Promise<void>((resolve) => {
      server.once('listening', () => { resolve() })
    })
    return () => {
      this.stopBackground()
      for (const socket of this.tracked) socket.destroy()
      this.tracked.clear()
      server.close()
      this.server = undefined
    }
  }

  /** 池当前出站控制：`direct` / `pool` / `custom`。 */
  get outbound(): ProxyPoolSettings {
    return { ...this.poolOutbound }
  }

  /**
   * 应用池出站控制：只有 `pool` 启动健康检查与订阅刷新，其余规则停止后台循环。
   *
   * 首轮刷新延迟一个周期，手工导入或持久化重放先就位；重复通知同一规则是
   * 幂等的，不会重置正在进行的刷新或定时器。
   * @param outbound - 设置分节解析出的池出站规则。
   */
  private applyOutbound(outbound: ProxyPoolSettings): void {
    const active = outbound.mode === 'pool'
    if (outbound.mode === this.poolOutbound.mode
      && outbound.customUrl === this.poolOutbound.customUrl
      && this.backgroundActive === active) return
    this.poolOutbound = outbound
    if (active) {
      this.backgroundActive = true
      this.healthTimer = setInterval(() => void this.checkAll(), this.healthOptions.intervalMs)
      this.scheduleRefresh()
      return
    }
    this.stopBackground()
  }

  /** 停止全部后台循环；进行中的一轮刷新自然结束，其收尾不再排期。 */
  private stopBackground(): void {
    this.backgroundActive = false
    if (this.healthTimer !== undefined) {
      clearInterval(this.healthTimer)
      this.healthTimer = undefined
    }
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
    }
  }

  /** 排下一轮订阅刷新；池停用或关闭周期刷新时不再排期。 */
  private scheduleRefresh(): void {
    if (!this.backgroundActive || !this.refreshOptions.enabled) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      void this.refresh().finally(() => { this.scheduleRefresh() })
    }, this.refreshOptions.intervalMs)
  }

  /** 入站监听就绪的 Promise；消费方在发请求前 await 它。 */
  private listening: Promise<void> = Promise.resolve()

  /** 等待本地入站完成监听；服务已停止时立即返回。 */
  async ready(): Promise<void> {
    await this.listening
  }

  /** 入站服务器实际监听的端口；未就绪时为 0。 */
  get port(): number {
    const address = this.server?.address()
    return address !== null && typeof address === 'object' && 'port' in address ? address.port : 0
  }

  /**
   * 注册一个节点；重复 id 抛 `PROXY_NODE_DUPLICATE`。
   * @param node - 节点描述符。
   * @returns 注销该节点的 disposer。
   */
  registerNode(node: ProxyNode): () => void {
    if (this.nodes.has(node.id)) {
      throw new ProxyPoolError(`proxy node "${node.id}" already exists`, 'PROXY_NODE_DUPLICATE')
    }
    this.nodes.set(node.id, node)
    this.ctx.emit('proxy-pool/node', { kind: 'node-added', nodeId: node.id } satisfies ProxyPoolNodeEvent)
    return () => {
      this.nodes.delete(node.id)
      this.health.delete(node.id)
      this.ctx.emit('proxy-pool/node', { kind: 'node-removed', nodeId: node.id } satisfies ProxyPoolNodeEvent)
    }
  }

  /**
   * 原地改节点显示名：订阅刷新把探测通过的候选改成 `feed:` 前缀时使用，
   * id 与健康记录保持不变（重注册会两者皆失）。
   * @param nodeId - 节点 id。
   * @param name - 新显示名。
   */
  renameNode(nodeId: string, name: string): void {
    const node = this.nodes.get(nodeId)
    if (node === undefined) return
    this.nodes.set(nodeId, { ...node, name })
    this.ctx.emit('proxy-pool/node', { kind: 'node-updated', nodeId } satisfies ProxyPoolNodeEvent)
  }

  /**
   * 按注销一个节点；未知 id 返回 false。管理面（RPC `proxyPool.removeNode`）
   * 与设置持久化的重放都用它，不需要先取出描述符再注册取 disposer。
   * @param nodeId - 节点 id。
   * @returns 节点存在并被移除时为 true。
   */
  unregisterNode(nodeId: string): boolean {
    const node = this.nodes.get(nodeId)
    if (node === undefined) return false
    this.nodes.delete(nodeId)
    this.health.delete(nodeId)
    this.ctx.emit('proxy-pool/node', { kind: 'node-removed', nodeId } satisfies ProxyPoolNodeEvent)
    return true
  }

  /**
   * 注册一个连接组；成员必须已注册或随后注册。
   * @param group - 组描述符。
   * @returns 注销该组的 disposer。
   */
  registerGroup(group: ProxyGroup): () => void {
    if (this.groups.has(group.id)) {
      throw new ProxyPoolError(`proxy group "${group.id}" already exists`, 'PROXY_GROUP_DUPLICATE')
    }
    this.groups.set(group.id, group)
    return () => {
      this.groups.delete(group.id)
    }
  }

  /** 当前全部节点的快照。 */
  listNodes(): ProxyNode[] {
    return [...this.nodes.values()]
  }

  /** 当前全部组的快照。 */
  listGroups(): ProxyGroup[] {
    return [...this.groups.values()]
  }

  /** 节点健康快照。 */
  snapshotHealth(): ProxyHealth[] {
    return [...this.health.values()]
  }

  /**
   * 按出站模式解析出 undici 可用的代理 URL。
   *
   * 渠道选择「内置代理池」时使用池自己的出站控制：直连规则返回 undefined
   * （消费方回落直连），自定义代理规则返回池配置的地址，本地池规则返回入站地址。
   * 渠道自己的自定义代理不受池规则影响。
   * @param mode - 消费方声明的出站模式。
   * @returns 可注入 ProxyAgent 的地址，或直连时的 undefined。
   */
  proxyURL(mode: ProxyMode): string | undefined {
    if (mode.kind === 'direct') return undefined
    if (mode.kind === 'custom') return mode.url
    if (this.poolOutbound.mode === 'direct') return undefined
    if (this.poolOutbound.mode === 'custom') return this.poolOutbound.customUrl
    if (this.server === undefined) {
      throw new ProxyPoolError('proxy pool frontend is not running', 'PROXY_POOL_NOT_READY')
    }
    return `http://127.0.0.1:${this.port}`
  }

  /** 入站连接按组选择节点；组缺省取第一个健康节点。 */
  private selectNode(groupId?: string): ProxyNode | undefined {
    const group = groupId !== undefined ? this.groups.get(groupId) : undefined
    const members = group !== undefined ? group.members : undefined
    const candidates = members === undefined
      ? [...this.nodes.values()]
      : members.flatMap((id) => {
        const node = this.nodes.get(id)
        return node !== undefined ? [node] : []
      })
    if (candidates.length === 0) return undefined
    if (group?.strategy === 'url-test') {
      const ranked = candidates
        .map(node => ({ node, health: this.health.get(node.id) }))
        .filter(entry => entry.health?.alive === true)
        .sort((a, b) => (a.health?.latencyMs ?? Infinity) - (b.health?.latencyMs ?? Infinity))
      return ranked[0]?.node ?? candidates[0]
    }
    const healthy = candidates.find(node => this.health.get(node.id)?.alive === true)
    return healthy ?? candidates[0]
  }

  /** 入站活跃的客户端与上游流；dispose 时统一销毁。 */
  private tracked = new Set<Duplex>()

  /** 处理一条 CONNECT：按当前选择把隧道桥接到上游节点。 */
  private handleConnect(req: InstanceType<typeof import('node:http').IncomingMessage>, clientSocket: Socket, head: Buffer): void {
    const target = parseAuthority(req.url ?? '')
    if (target === undefined) {
      clientSocket.destroy()
      return
    }
    const node = this.selectNode(this.activeGroupId)
    if (node === undefined) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      clientSocket.destroy()
      return
    }
    this.tracked.add(clientSocket)
    void (async () => {
      try {
        const upstream = await dialThrough(node, { host: target.host, port: target.port })
        this.tracked.add(upstream)
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
        const done = () => {
          this.tracked.delete(clientSocket)
          this.tracked.delete(upstream)
          clientSocket.destroy()
          upstream.destroy()
        }
        clientSocket.once('close', done)
        upstream.once('close', done)
      } catch {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        clientSocket.destroy()
      }
    })()
  }

  /** 消费方（如 Free 渠道）设置的组选择；null 走默认选择。 */
  private activeGroupId: string | undefined

  /**
   * 处理一条正向代理请求（明文 http:// 目标）：向出站节点发 CONNECT 建立到
   * 目标的隧道，再把请求按起源形式（相对路径 + Host 头）写进隧道。节点返回
   * 的响应经最小解析后原样写回；内容长度语义由头携带，不做改写。
   */
  private handleForward(req: InstanceType<typeof import('node:http').IncomingMessage>, res: InstanceType<typeof import('node:http').ServerResponse>): void {
    const url = req.url ?? ''
    // 相对路径说明这不是正向代理形态（例如健康探针打到了入站口），直接拒绝。
    if (!/^https?:\/\//.test(url)) {
      res.writeHead(400)
      res.end()
      return
    }
    const node = this.selectNode(this.activeGroupId)
    if (node === undefined) {
      res.writeHead(502)
      res.end()
      return
    }
    void (async () => {
      try {
        const target = new URL(url)
        const port = target.port === '' ? 80 : Number(target.port)
        // HTTP 出站节点本身是前向代理：直接把绝对 URI 请求转发给节点更自然，
        // 但为统一所有协议的出站形状（隧道语义），仍走 CONNECT + 起源请求。
        const upstream = await dialThrough(node, { host: target.hostname, port })
        const headers = { ...req.headers }
        delete headers.connection
        delete headers['proxy-connection']
        delete headers.host
        upstream.write(`${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n`)
        upstream.write(`Host: ${target.hostname}${target.port === '' ? '' : `:${target.port}`}\r\n`)
        for (const [key, value] of Object.entries(headers)) {
          if (value === undefined) continue
          upstream.write(Array.isArray(value) ? value.map(item => `${key}: ${item}`).join('\r\n') : `${key}: ${value}\r\n`)
        }
        upstream.write('\r\n')
        req.pipe(upstream)
        // 裸 TCP 上的响应没有 Node 解析器；这里用最小解析把状态行与头写回，
        // 剩余字节原样透传。
        let header = Buffer.alloc(0)
        const onData = (chunk: Buffer) => {
          header = Buffer.concat([header, chunk])
          const split = header.indexOf('\r\n\r\n')
          if (split === -1) return
          upstream.off('data', onData)
          const headText = header.subarray(0, split).toString('latin1')
          const status = Number(headText.split(' ', 3)[1] ?? 502)
          const rawHeaders = headText.split('\r\n').slice(1)
          const outHeaders: Record<string, string> = {}
          for (const line of rawHeaders) {
            const colon = line.indexOf(':')
            if (colon > 0) outHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
          }
          delete outHeaders['transfer-encoding']
          res.writeHead(status, outHeaders)
          const rest = header.subarray(split + 4)
          if (rest.length > 0) res.write(rest)
          upstream.pipe(res)
        }
        upstream.on('data', onData)
        upstream.once('error', () => { res.destroy() })
        req.once('error', () => { upstream.destroy() })
        res.once('close', () => { upstream.destroy() })
      } catch {
        res.writeHead(502)
        res.end()
      }
    })()
  }

  /**
   * 设置入站使用的组；未设置或组不存在时按 fallback 全池选择。
   * @param groupId - 组 id 或 undefined。
   */
  useGroup(groupId: string | undefined): void {
    this.activeGroupId = groupId
  }

  /** 对全部节点执行一轮健康检查并发事件。 */
  async checkAll(): Promise<void> {
    await Promise.all([...this.nodes.keys()].map(id => this.checkNode(id)))
  }

  /**
   * 触发一次订阅刷新（手动与周期共用；进行中时复用同一个 Promise）。
   * 失败不抛出——摘要里的 `failures` 承载每个源的错误，管理面据此展示。
   * @returns 本次刷新的摘要。
   */
  async refresh(): Promise<RefreshResult> {
    this.refreshing ??= refreshPoolNodes(this, {
      targetCount: this.refreshOptions.targetCount,
    }).finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  /**
   * 探测单个节点：经该节点拨号到公网目标并立即关闭。
   * @param nodeId - 节点 id。
   * @param timeoutMs - 本次探测的超时；缺省用健康检查配置的值（订阅刷新
   *   用更紧的值轮询海量候选，避免单个死节点占满探测窗口）。
   */
  async checkNode(nodeId: string, timeoutMs?: number): Promise<ProxyHealth | undefined> {
    const node = this.nodes.get(nodeId)
    if (node === undefined) return undefined
    const started = Date.now()
    let alive = false
    let failure: string | undefined
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => { controller.abort() }, timeoutMs ?? this.healthOptions.timeoutMs)
      const stream = await dialThrough(node, { host: '1.1.1.1', port: 80, signal: controller.signal })
      clearTimeout(timeout)
      stream.destroy()
      alive = true
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    const previous = this.health.get(nodeId)
    const health: ProxyHealth = {
      nodeId,
      alive,
      ...(alive ? { latencyMs: Date.now() - started } : previous?.latencyMs !== undefined ? { latencyMs: previous.latencyMs } : {}),
      ...(failure !== undefined ? { failure } : {}),
      checkedAt: Date.now(),
    }
    this.health.set(nodeId, health)
    this.ctx.emit('proxy-pool/node', { kind: 'node-health', nodeId, health } satisfies ProxyPoolNodeEvent)
    return health
  }
}

/** `host:port` 权威串解析。 */
function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const match = authority.match(/^(.+):(\d+)$/)
  if (match === null) return undefined
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  const host = match[1]
  if (host === undefined) return undefined
  return { host, port }
}

export default ProxyPoolService

/** Cordis 插件名。 */
export const name = 'proxy-pool'

/** 插件需要的服务：无——池独立于 LLM 与设置运行。 */
export const inject: string[] = []

/**
 * Cordis 插件入口（`ctx.plugin(ProxyPoolService)` 与 Loader 装载共用）：
 * 类默认导出经构造挂载池服务并安装节点持久化；没有设置提供方时池照常
 * 工作，只是节点不落盘。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: Context): void {
  new ProxyPoolService(ctx, {})
}
