/**
 * 代理池的类型词汇：出站节点、连接组、健康状态与事件载荷。
 *
 * 节点事实（协议、地址、凭据）与其运行时状态（延迟、是否可用）分开存放：
 * 节点描述符是不可变数据，状态由池的运行时拥有并经事件发布。协议名用小写
 * 字符串判别联合；封闭联合以 `assertNever` 收尾的约定在 `protocol.ts` 落地。
 *
 * @module coding-proxy-pool/types
 */

/** 支持的出站协议。HTTP 与 SOCKS5 走既有 TCP 栈；其余三者参考对应官方协议规范实现。 */
export type ProxyProtocol = 'http' | 'socks5' | 'vless' | 'vmess' | 'hysteria2'

/** 传输层加密设置；VLESS/VMess 常见裸 TCP 或 WebSocket，Hysteria2 恒为 TLS over QUIC。 */
export interface ProxyTls {
  /** SNI 主机名；缺省用节点地址。 */
  serverName?: string
  /** 跳过证书校验（自签服务器）。 */
  allowInsecure?: boolean
}

/** WebSocket 传输设置（VLESS/VMess 的 `ws` 传输）。 */
export interface ProxyWsTransport {
  /** WebSocket 路径，以 `/` 开头。 */
  path: string
  /** 附加的 Host/Origin 等头。 */
  headers?: Readonly<Record<string, string>>
}

/** VLESS/VMess 的传输层选择。 */
export type ProxyTransport =
  | { type: 'tcp' }
  | { type: 'ws'; ws: ProxyWsTransport }

/** 一个出站节点的不可变描述符。 */
export interface ProxyNode {
  /** 池内唯一 id；由导入方或管理界面铸造。 */
  id: string
  /** 显示名。 */
  name: string
  /** 出站协议。 */
  protocol: ProxyProtocol
  /** 服务器地址（IP 或域名）。 */
  address: string
  /** 服务器端口。 */
  port: number
  /** HTTP/SOCKS5 的用户名。 */
  username?: string
  /** HTTP/SOCKS5 的密码或 VLESS 的 UUID、VMess 的用户 id。 */
  secret?: string
  /** VMess 的 alterId；0 表示 AEAD。 */
  alterId?: number
  /** TLS 设置；协议不需要 TLS 时省略。 */
  tls?: ProxyTls
  /** 传输层设置；省略表示裸 TCP。 */
  transport?: ProxyTransport
}

/** 组的选择策略。 */
export type ProxyGroupStrategy =
  /** 按节点顺序取第一个健康节点；全部不健康时回落到首个节点直试。 */
  | 'fallback'
  /** 周期测速选延迟最低的健康节点。 */
  | 'url-test'

/** 一个连接组：一组候选节点加选择策略。 */
export interface ProxyGroup {
  /** 池内唯一 id。 */
  id: string
  /** 显示名。 */
  name: string
  /** 候选节点 id，按优先级排序。 */
  members: readonly string[]
  /** 选择策略。 */
  strategy: ProxyGroupStrategy
}

/** 一次健康探测的结果。 */
export interface ProxyHealth {
  /** 节点 id。 */
  nodeId: string
  /** 最近一次探测是否成功。 */
  alive: boolean
  /** 最近一次探测的往返延迟（毫秒）；失败时为上一轮成功值。 */
  latencyMs?: number
  /** 最近一次失败的原因摘要；健康时为空。 */
  failure?: string
  /** 最近一次探测完成的纪元毫秒。 */
  checkedAt: number
}

/** 池对外发布的节点级事件载荷。 */
export interface ProxyPoolNodeEvent {
  /** 事件种类：新增/更新/移除/健康变化。 */
  kind: 'node-added' | 'node-updated' | 'node-removed' | 'node-health'
  /** 事件涉及的节点 id。 */
  nodeId: string
  /** 健康变化与更新事件携带最新状态。 */
  health?: ProxyHealth
}

/** 代理池抛出的稳定错误类型。 */
export class ProxyPoolError extends Error {
  /** 稳定机器码，供调用方分支。 */
  readonly code: string

  /**
   * @param message - 人类可读的失败摘要。
   * @param code - 稳定机器码（如 `PROXY_NODE_NOT_FOUND`）。
   */
  constructor(message: string, code: string) {
    super(message)
    this.name = 'ProxyPoolError'
    this.code = code
  }
}
