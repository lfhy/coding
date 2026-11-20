/**
 * `tabs.mjs` 的伴随声明：TypeScript 不解析未检查的运行时 JS，测试通过它获得
 * `createTabsApi` 的精确签名，同时保持运行时文件仍由 ego CLI 直接执行。
 */
export interface TabListEntry {
  targetId: string
  title: string
  url: string
  active: boolean
  index: number
}

export interface TabScope {
  browserContextId: string | null
  targetIds: Set<string>
}

export interface TabsCdpClient {
  activeHint?: () => string | undefined
  call(method: string, params?: unknown): Promise<any>
}

export interface TabsApi {
  listTabs(scopeOverride?: TabScope | null): Promise<{ tabs: TabListEntry[] }>
  createTab(url?: string, browserContextId?: string): Promise<{ targetId: string }>
}

export function createTabsApi(
  cdp: TabsCdpClient,
  options?: {
    port?: number
    getScope?: () => Promise<TabScope | null> | TabScope | null
  },
): TabsApi
