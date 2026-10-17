/**
 * proxyPool domain contract: host-scoped proxy pool management for the
 * settings surface. `proxyPool.describe` returns the node/group registry with
 * live health snapshots; `proxyPool.importLinks` parses share-link text into
 * candidate nodes; `proxyPool.removeNode` drops one; `proxyPool.testNode`
 * triggers one health probe; `proxyPool.outbound` reads and writes the
 * outbound-mode settings section shared with the Free channel. Clients
 * invalidate from the forwarded `proxy-pool/node` owner events.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { OutboundModeView } from './settings.ts'

/** Wire view of one proxy node (secrets redacted to presence flags). */
export interface ProxyNodeView {
  /** Pool-unique node id. */
  id: string
  /** Display name. */
  name: string
  /** Outbound protocol. */
  protocol: 'http' | 'socks5' | 'vless' | 'vmess' | 'hysteria2'
  /** Server address. */
  address: string
  /** Server port. */
  port: number
  /** Whether a username is configured (value never leaves the host). */
  hasUsername: boolean
  /** Whether a secret is configured (value never leaves the host). */
  hasSecret: boolean
}

/** Wire view of one health record. */
export interface ProxyHealthView {
  /** Node id. */
  nodeId: string
  /** Whether the last probe succeeded. */
  alive: boolean
  /** Last successful round-trip latency in ms, when known. */
  latencyMs?: number
  /** Failure summary of the last probe, when it failed. */
  failure?: string
  /** Epoch ms of the last completed probe. */
  checkedAt: number
}

/** proxyPool.describe response row: one group with resolved member nodes. */
export interface ProxyGroupView {
  /** Pool-unique group id. */
  id: string
  /** Display name. */
  name: string
  /** Selection strategy. */
  strategy: 'fallback' | 'url-test'
  /** Member node ids in priority order. */
  members: string[]
}

/** ProxyPool-domain unary methods (the map keys proxyPool.* of RpcMethodMap). */
export interface ProxyPoolApi {
  /**
   * List registered nodes, groups, health snapshots, and the active outbound
   * mode. The local frontend URL, or an empty string when the frontend is
   * not running, so surfaces can show the address consumers should point at.
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    nodes: ProxyNodeView[]
    groups: ProxyGroupView[]
    health: ProxyHealthView[]
    outbound: OutboundModeView
    frontendURL: string
  }>>

  /**
   * Parse share-link text into candidate nodes and register every well-formed
   * entry. Malformed lines are skipped and counted, mirroring
   * `parseProxyLinks`; a report of accepted/skipped comes back so the surface
   * can surface partial imports.
   */
  importLinks(request: RpcRequest<{ text: string }>): Promise<RpcResponse<{ imported: ProxyNodeView[]; skipped: number }>>

  /** Remove one node by id; unknown ids resolve ok with removed: false. */
  removeNode(request: RpcRequest<{ id: string }>): Promise<RpcResponse<{ removed: boolean }>>

  /** Trigger one health probe now; resolves with that probe's record. */
  testNode(request: RpcRequest<{ id: string }>): Promise<RpcResponse<ProxyHealthView | undefined>>

  /** Replace the outbound mode selection (persisted via the settings section). */
  setOutbound(request: RpcRequest<{ mode: OutboundModeView }>): Promise<RpcResponse<{ outbound: OutboundModeView }>>
}
