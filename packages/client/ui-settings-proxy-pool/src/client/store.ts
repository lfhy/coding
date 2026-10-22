/** 代理池分区的数据层：describe 拉取与导入/删除/测试/池出站写入动作。 */

import type { IApiClient, OutboundModeView } from 'coding-api-remotes/client'
import { createSnapshotStore } from 'coding-client-runtime/client'
import type { SnapshotStore } from 'coding-client-runtime/client'

/** describe 的页面快照。 */
export interface PoolSnapshot {
  /** 加载状态机。 */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 节点线视图。 */
  nodes: { id: string; name: string; protocol: string; address: string; port: number }[]
  /** 按节点 id 索引的健康记录。 */
  health: Map<string, { alive: boolean; latencyMs?: number; failure?: string }>
  /** 池自己的出站控制：直连、经本地池或经自定义代理。 */
  outbound: OutboundModeView
  /** 本地入站地址；前端未运行时为空串。 */
  frontendURL: string
  /** 最近一次动作/加载的失败文案。 */
  error: string | null
}

/** 一次导入的摘要。 */
export interface ImportSummary {
  imported: number
  skipped: number
}

/** 快照的初始值。 */
const INITIAL: PoolSnapshot = {
  status: 'idle',
  nodes: [],
  health: new Map(),
  outbound: { mode: 'direct' },
  frontendURL: '',
  error: null,
}

/**
 * 代理池分区的 store 工厂：每个分区实例一份，不落模块级单例。
 * 动作完成后自动刷新快照；失败写进 `error` 由界面展示，动作本身不抛出。
 */
/** 载波客户端的 proxyPool 域（payload 形态，rpcId 由载波铸造）。 */
type PoolWire = IApiClient['proxyPool']

/** 一次手动订阅刷新的摘要。 */
export interface RefreshSummary {
  admitted: number
  evicted: number
  failures: string[]
}

export function createProxyPoolStore(api: PoolWire) {
  const store: SnapshotStore<PoolSnapshot> = createSnapshotStore<PoolSnapshot>(structuredClone(INITIAL))
  /** 只保留最新一次加载；旧响应不覆盖新状态。 */
  let generation = 0

  /** 把失败写进快照的错误槽。 */
  const fail = (message: string): void => {
    store.update((draft) => { draft.error = message })
  }

  /** 拉一次 describe。 */
  const load = async (): Promise<void> => {
    const current = ++generation
    store.update((draft) => { draft.status = 'loading'; draft.error = null })
    const response = await api.describe({})
    if (current !== generation) return
    if (!response.result.ok) {
      fail(response.result.error.message)
      store.update((draft) => { draft.status = 'error' })
      return
    }
    const value = response.result.value
    store.update((draft) => {
      draft.status = 'ready'
      draft.nodes = value.nodes
      draft.health = new Map(value.health.map(entry => [entry.nodeId, entry]))
      draft.outbound = value.outbound
      draft.frontendURL = value.frontendURL
    })
  }

  /** 导入一段分享链接文本并刷新。 */
  const importLinks = async (text: string): Promise<ImportSummary> => {
    const response = await api.importLinks({ text })
    if (!response.result.ok) {
      fail(response.result.error.message)
      return { imported: 0, skipped: 0 }
    }
    await load()
    return { imported: response.result.value.imported.length, skipped: response.result.value.skipped }
  }

  /** 删除一个节点并刷新。 */
  const removeNode = async (id: string): Promise<void> => {
    const response = await api.removeNode({ id })
    if (!response.result.ok) fail(response.result.error.message)
    else await load()
  }

  /** 立即探测一个节点并刷新。 */
  const testNode = async (id: string): Promise<void> => {
    const response = await api.testNode({ id })
    if (!response.result.ok) fail(response.result.error.message)
    else await load()
  }

  /** 手动触发一次订阅刷新并重载快照。 */
  const refresh = async (): Promise<RefreshSummary> => {
    const response = await api.refresh({})
    if (!response.result.ok) {
      fail(response.result.error.message)
      return { admitted: 0, evicted: 0, failures: [] }
    }
    await load()
    return response.result.value
  }

  /** 写入池自己的出站控制并刷新。 */
  const setOutbound = async (mode: OutboundModeView): Promise<void> => {
    const response = await api.setOutbound({ mode })
    if (!response.result.ok) fail(response.result.error.message)
    else await load()
  }

  return { store, load, importLinks, removeNode, testNode, refresh, setOutbound }
}

/** store 工厂的实例类型（组件只以类型引用它）。 */
export type ProxyPoolStoreHandle = ReturnType<typeof createProxyPoolStore>
