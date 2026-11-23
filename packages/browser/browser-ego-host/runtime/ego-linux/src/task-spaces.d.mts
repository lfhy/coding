/**
 * `task-spaces.mjs` 的伴随声明：TypeScript 不解析未检查的运行时 JS，测试通过它获得
 * `createTaskSpacesApi` 中所用操作的最小签名，运行时文件本身仍由 ego CLI 直接执行。
 */
import type { TabsApi } from './tabs.d.mts'

export interface TaskSpacesCdpClient {
  call(method: string, params?: unknown): Promise<any>
}

export interface TaskSpacesApi {
  listTabsForSpace(name: string, tabs: TabsApi): Promise<{ tabs: unknown[] }>
  useTaskSpace(id: number): Promise<{ done: boolean }>
}

export function createTaskSpacesApi(cdp: TaskSpacesCdpClient): TaskSpacesApi
