/**
 * 桌面端的下载列表入口。
 *
 * preload 只提供一个订阅方法与几个动作，页面拿不到文件系统或进程能力；所有字段都是
 * IPC 数据，按外部输入校验后再进入 UI。没有桌面壳时返回 null，面板不显示下载入口。
 */
import type { EgoNativeSurface } from './native.ts'

export interface EgoDownloadItem {
  id: string
  filename: string
  state: 'progressing' | 'completed' | 'canceled'
  receivedBytes: number
  totalBytes: number
  path: string
}

/** 一次下载的最小可用信息；无效字段整条丢弃，不显示半截数据。 */
export function parseDownload(value: unknown): EgoDownloadItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const { id, filename, state, receivedBytes, totalBytes, path } = record
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 512) return null
  if (state !== 'progressing' && state !== 'completed' && state !== 'canceled') return null
  if (typeof path !== 'string' || path.length > 4096) return null
  if (!Number.isSafeInteger(receivedBytes) || (receivedBytes as number) < 0) return null
  if (!Number.isSafeInteger(totalBytes) || (totalBytes as number) < 0) return null
  return { id, filename, state, receivedBytes: receivedBytes as number, totalBytes: totalBytes as number, path }
}

/** 桌面壳提供的下载能力；Web 与 CLI 没有。 */
export interface EgoDownloadsBridge {
  list(): Promise<readonly EgoDownloadItem[]>
  cancel(id: string): Promise<boolean>
  /** 用户在系统对话框里确认后复制文件；`canceled` 表示用户放弃。 */
  save(id: string): Promise<{ ok: boolean; canceled: boolean }>
  reveal(id: string): Promise<void>
  open(id: string): Promise<boolean>
  subscribe(listener: (item: EgoDownloadItem) => void): () => void
}

interface RawBridge {
  list?: unknown
  cancel?: unknown
  save?: unknown
  reveal?: unknown
  open?: unknown
  subscribe?: unknown
}

function callable(value: unknown): value is (...args: unknown[]) => Promise<unknown> {
  return typeof value === 'function'
}

/**
 * 读取桌面端的下载入口。
 * @returns 桌面壳提供了完整能力时为桥对象，否则为 null。
 */
export function nativeEgoDownloads(): EgoDownloadsBridge | null {
  const desktop = (globalThis as { codingDesktop?: { egoBrowser?: unknown } }).codingDesktop
  const browser = desktop?.egoBrowser
  if (typeof browser !== 'object' || browser === null) return null
  const raw = (browser as { downloads?: unknown }).downloads
  if (typeof raw !== 'object' || raw === null) return null
  const bridge = raw as RawBridge
  if (!callable(bridge.list) || !callable(bridge.cancel) || !callable(bridge.save)
    || !callable(bridge.reveal) || !callable(bridge.open) || !callable(bridge.subscribe)) return null
  const invoke = (fn: (...args: unknown[]) => Promise<unknown>, ...args: unknown[]): Promise<unknown> =>
    fn.call(raw, ...args)
  return {
    async list() {
      const payload: unknown = await invoke(bridge.list as (...args: unknown[]) => Promise<unknown>)
      const items = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as { downloads?: unknown }).downloads : undefined
      if (!Array.isArray(items)) return []
      return items.map(parseDownload).filter((item): item is EgoDownloadItem => item !== null)
    },
    async cancel(id) {
      const payload = await invoke(bridge.cancel as (...args: unknown[]) => Promise<unknown>, id)
      return typeof payload === 'object' && payload !== null && (payload as { ok?: unknown }).ok === true
    },
    async save(id) {
      const payload = await invoke(bridge.save as (...args: unknown[]) => Promise<unknown>, id)
      const value = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
      return { ok: value.ok === true, canceled: value.canceled === true }
    },
    async reveal(id) {
      await invoke(bridge.reveal as (...args: unknown[]) => Promise<unknown>, id)
    },
    async open(id) {
      const payload = await invoke(bridge.open as (...args: unknown[]) => Promise<unknown>, id)
      return typeof payload === 'object' && payload !== null && (payload as { ok?: unknown }).ok === true
    },
    subscribe(listener) {
      const stop = (bridge.subscribe as (cb: (payload: unknown) => void) => unknown).call(raw, (payload: unknown) => {
        const record = typeof payload === 'object' && payload !== null
          ? (payload as { record?: unknown }).record : undefined
        const item = parseDownload(record)
        if (item !== null) listener(item)
      })
      return typeof stop === 'function' ? stop as () => void : () => {}
    },
  }
}

/**
 * 合并一条下载更新：同 id 覆盖，新条目排在最前。
 * @param items 当前列表。
 * @param next 新到的一条下载。
 * @returns 最多 50 条的新到旧列表。
 */
export function mergeDownload(items: readonly EgoDownloadItem[], next: EgoDownloadItem): readonly EgoDownloadItem[] {
  return [next, ...items.filter(item => item.id !== next.id)].slice(0, 50)
}

/** 面板与原生视图共存时，下载入口只依赖桌面壳；这里同时要求原生呈现可用。 */
export function downloadsForSurface(surface: EgoNativeSurface | null): EgoDownloadsBridge | null {
  return surface === null ? null : nativeEgoDownloads()
}
