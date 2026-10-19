/**
 * 代理池的节点持久化：把注册表镜像到一个可选的 settings 分节，重启后重放。
 *
 * 池服务本身不依赖设置——没有设置提供方时它照常工作，只是节点随进程结束。
 * 分节形状是「链接行」数组：每行一条分享链接，导入/删除时全量重写。以链接
 * 而非描述符持久化，让未来 links.ts 支持的新字段自动兼容旧记录。
 *
 * @module coding-proxy-pool/persist
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import { parseProxyLink } from './links.ts'
import type { ProxyNode } from './types.ts'

/** 节点持久化使用的设置命名空间。 */
export const PROXY_POOL_NODES_SETTINGS_NAMESPACE = settingsNamespace('proxy-pool-nodes')

/** 分节形状：链接行数组（顺序即优先级）。 */
export interface ProxyPoolNodesSettings {
  /** 每行一条分享链接，与导入文本同语法。 */
  links: string[]
}

/** 分节 schema。 */
const NODES_SCHEMA: z<ProxyPoolNodesSettings> = z.object({
  links: z.array(z.string()),
})

/** 订阅节点显示名前缀：手工导入持久化时按它排除刷新来源的临时节点。 */
const FEED_NAME_PREFIX = 'feed:'

/**
 * 把节点的注册表镜像到设置分节，并在启动时重放已保存的链接。
 *
 * 重放发生在设置提供方可用时（可能晚于池启动）；重放只追加当前池里没有的
 * 地址，不清理池内已有节点——运行期导入尚未落盘的节点不会因重放被丢弃。
 * 分节同时是回写目标：`onChange` 每次都把当前手工节点集（非 `feed:` 前缀）
 * 全量写回设置，导入与删除因此都落盘。写回经序列化写队列排队，晚于本回调
 * 完成；排队的写到达时读到的是已提交的注册表，不会回退。
 * @param ctx - 池服务所在的上下文。
 * @param pool - 要镜像的池服务。
 * @param register - 节点注册函数（传入以避免与池内部状态竞态）。
 * @returns 安装结果；设置提供方缺席时是 no-op。
 */
export function mirrorPoolNodes(
  ctx: Context,
  pool: { listNodes(): readonly ProxyNode[]; registerNode(node: ProxyNode): () => void },
  register: (node: ProxyNode) => void,
): void {
  let current: () => ProxyPoolNodesSettings = () => ({ links: [] })
  /** 把当前手工节点集（排除订阅刷新的 `feed:` 临时节点）全量写回设置。 */
  const writeBack = (): void => {
    const settings = ctx.get('settings')
    if (settings === undefined) return
    const manual = pool.listNodes().filter(node => !node.name.startsWith(FEED_NAME_PREFIX))
    void settings.replace(PROXY_POOL_NODES_SETTINGS_NAMESPACE, serializeNodes(manual)).catch(() => {
      // 写回失败只损失持久化，不影响池内节点；下次变更再试。
    })
  }
  ctx.effect(() => ctx.on('proxy-pool/node', (event) => {
    // 只有注册表增减改变持久化集；健康与改名事件不落盘。
    if (event.kind === 'node-added' || event.kind === 'node-removed') writeBack()
  }), 'proxy-pool-nodes: write back on registry changes')
  installSettingsSection(ctx, PROXY_POOL_NODES_SETTINGS_NAMESPACE, NODES_SCHEMA, { links: [] }, {
    setSource: (source) => { current = source },
    onChange: () => {
      const saved = current()
      const known = new Set(pool.listNodes().map(node => nodeLink(node)))
      for (const link of saved.links) {
        if (known.has(link)) continue
        try {
          register(parseProxyLink(link))
        } catch {
          // 单条坏行不阻塞重放：设置里的其他节点仍然可用。
        }
      }
      // 重放补齐后写回一次，让「设置里已不合法/已清空的行」与注册表对齐；
      // 写回提交再次触发本回调，此时解析结果与池内一致，循环收敛为空转。
      writeBack()
    },
  })
}

/**
 * 把节点描述符还原成可再导入的分享链接行。socks5/http 带 TLS 与附加字段时
 * 降级为基线形态（协议本身不承载这些字段）；vless/vmess/hysteria2 的链接
 * 语法完整承载各自字段，往返无损。
 */
export function nodeLink(node: ProxyNode): string {
  const fragment = `#${encodeURIComponent(node.name)}`
  if (node.protocol === 'vless') return vlessLink(node, fragment)
  if (node.protocol === 'vmess') return vmessLink(node)
  if (node.protocol === 'hysteria2') return hysteria2Link(node, fragment)
  return classicLink(node, fragment)
}

/** `vless://uuid@host:port?security=tls&type=ws&path=/p&sni=h#name` */
function vlessLink(node: ProxyNode, fragment: string): string {
  const params = new URLSearchParams()
  const tls = node.tls
  if (tls !== undefined) {
    params.set('security', 'tls')
    if (tls.serverName !== undefined && tls.serverName !== node.address) params.set('sni', tls.serverName)
    if (tls.allowInsecure === true) params.set('allowInsecure', '1')
  }
  if (node.transport?.type === 'ws') {
    params.set('type', 'ws')
    params.set('path', node.transport.ws.path)
    for (const [key, value] of Object.entries(node.transport.ws.headers ?? {})) params.set(key, value)
  } else {
    params.set('type', 'tcp')
  }
  return `vless://${encodeURIComponent(node.secret ?? '')}@${node.address}:${node.port}?${params.toString()}${fragment}`
}

/**
 * `vmess://` base64 JSON 行。字段名对齐 v2rayN 导出（v/ps/add/port/id/aid/
 * net/path/tls/sni），重放走同一解析器。
 */
function vmessLink(node: ProxyNode): string {
  const payload = {
    v: '2',
    ps: node.name,
    add: node.address,
    port: String(node.port),
    id: node.secret ?? '',
    aid: String(node.alterId ?? 0),
    net: node.transport?.type === 'ws' ? 'ws' : 'tcp',
    ...(node.transport?.type === 'ws' ? { path: node.transport.ws.path } : {}),
    ...(node.tls !== undefined ? { tls: 'tls', sni: node.tls.serverName ?? node.address } : {}),
  }
  return `vmess://${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`
}

/** `hy2://[auth@]host:port?sni=h&insecure=1#name` */
function hysteria2Link(node: ProxyNode, fragment: string): string {
  const params = new URLSearchParams()
  const tls = node.tls ?? { serverName: node.address }
  if (tls.serverName !== undefined && tls.serverName !== node.address) params.set('sni', tls.serverName)
  if (tls.allowInsecure === true) params.set('insecure', '1')
  const query = params.toString()
  const auth = node.secret !== undefined ? `${encodeURIComponent(node.secret)}@` : ''
  return `hy2://${auth}${node.address}:${node.port}${query.length > 0 ? `?${query}` : ''}${fragment}`
}

/** `socks5://user:pass@host:port#name`；http/https 同形。 */
function classicLink(node: ProxyNode, fragment: string): string {
  const auth = node.username !== undefined
    ? `${encodeURIComponent(node.username)}:${encodeURIComponent(node.secret ?? '')}@`
    : node.secret !== undefined ? `${encodeURIComponent(node.secret)}@` : ''
  return `${node.protocol}://${auth}${node.address}:${node.port}${fragment}`
}

/** 把当前注册表序列化为分节值（导入/删除后调用写入）。 */
export function serializeNodes(nodes: readonly ProxyNode[]): ProxyPoolNodesSettings {
  return { links: nodes.map(node => nodeLink(node)) }
}
