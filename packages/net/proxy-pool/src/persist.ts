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

/**
 * 把节点的注册表镜像到设置分节，并在启动时重放已保存的链接。
 *
 * 重放发生在设置提供方可用时（可能晚于池启动）；重放只追加当前池里没有的
 * 地址，不清理池内已有节点——运行期导入尚未落盘的节点不会因重放被丢弃。
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
    },
  })
}

/** 把节点描述符还原成池可再导入的 socks5/http 链接行。 */
function nodeLink(node: ProxyNode): string {
  const auth = node.username !== undefined
    ? `${encodeURIComponent(node.username)}:${encodeURIComponent(node.secret ?? '')}@`
    : node.secret !== undefined ? `${encodeURIComponent(node.secret)}@` : ''
  return `${node.protocol}://${auth}${node.address}:${node.port}#${encodeURIComponent(node.name)}`
}

/** 把当前注册表序列化为分节值（导入/删除后调用写入）。 */
export function serializeNodes(nodes: readonly ProxyNode[]): ProxyPoolNodesSettings {
  return { links: nodes.map(node => nodeLink(node)) }
}
