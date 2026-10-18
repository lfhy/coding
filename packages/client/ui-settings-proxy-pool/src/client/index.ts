/**
 * 代理池设置分区（浏览器半）：向 ui-settings 的 `settings.section` 注册一页，
 * 管理代理池节点（导入/测试/删除）与 Free 渠道出站选择。
 *
 * 分区依赖 connection 拿 wire 客户端、locale 拿文案；设置壳的 slot 声明由
 * ui-settings 持有，本包只经 `slots.inject` 注册贡献，激活顺序不受约束。
 *
 * @module coding-client-ui-settings-proxy-pool/client
 */

import type { ClientContext } from 'coding-client-runtime/client'
import type {} from 'coding-client-locale/client'
import type {} from 'coding-client-ui-settings/client'
import type {} from 'coding-client-connection/client'
// remotes 的 Selection 合并（proxy-pool/node 转发键的面）。
import type {} from 'coding-api-remotes/client'
import type {} from 'coding-api-remotes/types'
// 池的 Events 声明（proxy-pool/node 的载荷形状）进入本编译面。
import type {} from 'coding-proxy-pool'
import { createProxyPoolStore } from './store.ts'
import { ProxyPoolSection } from './ProxyPoolSection.tsx'
import type { ProxyPoolSectionText } from './ProxyPoolSection.tsx'

/** 本包文案的字符串键（函数键不进 locale 词典，由注入闭包直出）。 */
type StringKeysOf<T> = {
  [K in keyof T]: T[K] extends string ? K : never
}[keyof T]

type ProxyPoolCopyKey = StringKeysOf<typeof zh>

declare module 'coding-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 代理池分区的界面文案（字符串键视图）。 */
    'settings.proxy-pool': ProxyPoolCopyKey
  }
}

/** locale 命名空间。 */
const NS = 'settings.proxy-pool'

/** 中文文案。 */
const zh: ProxyPoolSectionText = {
  title: '代理池',
  intro: '免费代理节点寿命只有分钟级，代理池每 5 分钟自动从公开订阅拉取新节点并探测入池；手工导入的节点不会被自动移除。Free 渠道的出站方式在这里选择。',
  outbound: '出站方式',
  outboundDirect: '直连',
  outboundPool: '代理池',
  outboundCustom: '自定义代理',
  customUrlLabel: '自定义代理地址',
  applyCustomUrl: '应用地址',
  importLabel: '导入代理链接',
  importPlaceholder: '每行一条：vless://…、vmess://…、hy2://…、socks5://…、http://…',
  importButton: '导入',
  imported: count => `已导入 ${count} 个`,
  skipped: count => `跳过 ${count} 行`,
  nodes: '节点',
  nodeName: '名称',
  nodeAddress: '地址',
  nodeStatus: '状态',
  nodeActions: '操作',
  test: '测试',
  remove: '删除',
  unknown: '未探测',
  emptyNodes: '池内还没有节点：点「刷新订阅」从公开目录拉取，或在上方粘贴分享链接导入。',
  refreshFeed: '刷新订阅',
  refreshed: summary => `新入 ${summary.admitted} 个，移除 ${summary.evicted} 个`,
  alive: '可用',
  dead: '不可用',
  latency: ms => `${ms} ms`,
  frontend: '本地代理地址',
  loadFailed: '加载失败',
  retry: '重试',
}

/** 英文文案。 */
const en: ProxyPoolSectionText = {
  title: 'Proxy Pool',
  intro: 'Free proxy nodes live for minutes; the pool refreshes from public feeds every 5 minutes and probes candidates before admitting them. Manually imported nodes are never auto-removed. Pick the Free channel outbound here.',
  outbound: 'Outbound',
  outboundDirect: 'Direct',
  outboundPool: 'Proxy pool',
  outboundCustom: 'Custom proxy',
  customUrlLabel: 'Custom proxy URL',
  applyCustomUrl: 'Apply URL',
  importLabel: 'Import proxy links',
  importPlaceholder: 'One per line: vless://…, vmess://…, hy2://…, socks5://…, http://…',
  importButton: 'Import',
  imported: count => `imported ${count}`,
  skipped: count => `skipped ${count}`,
  nodes: 'Nodes',
  nodeName: 'Name',
  nodeAddress: 'Address',
  nodeStatus: 'Status',
  nodeActions: 'Actions',
  test: 'Test',
  remove: 'Remove',
  unknown: 'unprobed',
  emptyNodes: 'The pool is empty: hit “Refresh feeds” to pull from public directories, or paste share links above.',
  refreshFeed: 'Refresh feeds',
  refreshed: summary => `admitted ${summary.admitted}, evicted ${summary.evicted}`,
  alive: 'alive',
  dead: 'unreachable',
  latency: ms => `${ms} ms`,
  frontend: 'Local proxy URL',
  loadFailed: 'Load failed',
  retry: 'Retry',
}

/** Cordis 插件名。 */
export const name = 'ui-settings-proxy-pool'

/** 必需服务：slot 体系、文案与连接。 */
export const inject = ['slots', 'locale', 'connection', 'remote']

/**
 * 注册代理池分区：store 由 connection 的 wire 客户端构造，分区经
 * `settings.section` 贡献；locale 变化时以新文案重注册。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const dictionaries: Record<string, ProxyPoolSectionText> = { zh, en }
  const stringCopy = Object.fromEntries(
    Object.entries(zh).filter(([, value]) => typeof value === 'string'),
  ) as Record<ProxyPoolCopyKey, string>
  ctx.effect(() => ctx.locale.register(NS, { zh: stringCopy, en: stringCopy }), 'ui-settings-proxy-pool: copy dictionaries')

  const connection = ctx.get('connection') as import('coding-client-connection/client').ConnectionHandle
  const store = createProxyPoolStore(connection.api.proxyPool)
  const { store: _store, ...actions } = store

  // Host 把 proxy-pool/node 转发到远端事件；分区据此自动重拉快照——
  // 订阅刷新换血、健康翻转都会实时反映在列表上，无需手动刷新。
  ctx.effect(
    () => ctx.remote.$on('proxy-pool/node', () => { void store.load() }),
    'ui-settings-proxy-pool: pool node invalidations',
  )

  ctx.slots.inject('settings.section', () => {
    const t = dictionaries[ctx.locale.getLocale().active] ?? zh
    return ctx.slots.register({
      name: 'settings.section',
      id: 'proxy-pool',
      order: 16,
      label: () => t.title,
      inject: (): { actions: typeof actions; hooks: { snapshot: typeof _store }; t: ProxyPoolSectionText } => ({
        actions,
        hooks: { snapshot: _store },
        t,
      }),
    }, ProxyPoolSection)
  })
}
