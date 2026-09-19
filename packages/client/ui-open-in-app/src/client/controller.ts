/** 浏览器侧的目标探测、本地应用启动与 provider-neutral 工作台请求。 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  OPEN_IN_APP_OPEN_ROUTE,
  OPEN_IN_APP_TARGET_ROUTE,
  type OpenInAppOpenPayload,
  type OpenInAppOpenResult,
  type OpenInAppTargetPayload,
  type OpenInAppTargetRequest,
} from '@deepseek-ai/dsh-host-open-in-app/shared'
import {
  OPEN_IN_APP_ROUTES,
  type OpenInAppRoutes,
  type WorkspaceFileContent,
  type WorkspaceFileEntry,
  type WorkspaceFilePayload,
  type WorkspaceFilesPayload,
} from './wire.ts'

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/** 一个工作区在浏览器中的打开方式。 */
export type WorkspaceOpenTarget =
  | { readonly kind: 'loading' }
  | OpenInAppTargetPayload
  | { readonly kind: 'unavailable' }

/** 按 Host 路径缓存的目标探测结果。 */
export type WorkspaceOpenTargets = Readonly<Record<string, WorkspaceOpenTarget | undefined>>

/** 解析浏览器对应 Host 的 base，并兼容测试与 `file:` 的 null origin。 */
function hostBase(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

/** 安全读取 JSON object；非 object 响应视为协议错误。 */
async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json() as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('open-in-app host returned an invalid response')
  }
  return value as Record<string, unknown>
}

function record(value: unknown, diagnostic: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(diagnostic)
  return value as Record<string, unknown>
}

/** 校验目标探测响应。 */
function targetPayload(value: Record<string, unknown>): OpenInAppTargetPayload {
  if (value.kind === 'files' && Array.isArray(value.apps) && value.apps.length === 0) {
    return { kind: 'files', apps: [] }
  }
  if (value.kind === 'local' && Array.isArray(value.apps)
    && value.apps.every(app => typeof app === 'string')) {
    return { kind: 'local', apps: value.apps }
  }
  throw new Error('open-in-app host returned an invalid target')
}

/** 校验应用启动响应。 */
function openResult(value: Record<string, unknown>): OpenInAppOpenResult {
  if (value.ok === true && (value.action === 'launched' || value.action === 'files')) {
    return { ok: true, action: value.action }
  }
  throw new Error('open-in-app host returned an invalid launch result')
}

function fileEntry(value: unknown, parentSegments: readonly string[]): WorkspaceFileEntry {
  const entry = record(value, 'open-in-app host returned an invalid directory entry')
  if (typeof entry.name !== 'string'
    || (entry.type !== 'file' && entry.type !== 'directory' && entry.type !== 'other')
    || (entry.size !== undefined
      && (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0))) {
    throw new Error('open-in-app host returned an invalid directory entry')
  }
  return {
    name: entry.name,
    type: entry.type,
    segments: [...parentSegments, entry.name],
    ...entry.size === undefined ? {} : { size: entry.size },
  }
}

/** 校验文件树的一层目录响应。 */
function filesPayload(value: Record<string, unknown>, parentSegments: readonly string[]): WorkspaceFilesPayload {
  if (typeof value.displayPath !== 'string' || typeof value.truncated !== 'boolean' || !Array.isArray(value.entries)) {
    throw new Error('open-in-app host returned an invalid directory listing')
  }
  return {
    path: value.displayPath,
    entries: value.entries.map(entry => fileEntry(entry, parentSegments)),
    truncated: value.truncated,
  }
}

/** 校验单文件读取响应。 */
function readPayload(value: Record<string, unknown>): WorkspaceFilePayload {
  if (typeof value.displayPath !== 'string' || typeof value.name !== 'string'
    || typeof value.truncated !== 'boolean') {
    throw new Error('open-in-app host returned an invalid file response')
  }
  let content: WorkspaceFileContent
  if (value.kind === 'text' && typeof value.text === 'string') {
    if (value.format === 'markdown') content = { kind: 'markdown', text: value.text }
    else if (value.format === 'code') content = { kind: 'code', text: value.text }
    else if (value.format === 'text') content = { kind: 'text', text: value.text }
    else throw new Error('open-in-app host returned invalid file content')
  } else if (value.kind === 'image' && typeof value.mime === 'string'
    && value.mime.startsWith('image/') && typeof value.dataBase64 === 'string') {
    content = { kind: 'image', mimeType: value.mime, data: value.dataBase64 }
  } else if (value.kind === 'unsupported'
    && (value.reason === 'binary' || value.reason === 'too-large')) {
    content = { kind: 'unsupported' }
  } else {
    throw new Error('open-in-app host returned invalid file content')
  }
  return { path: value.displayPath, content }
}

function requiredRoute(value: string, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`open-in-app host shared is missing ${name}`)
  return value
}

/**
 * 持有页面级目标缓存、持久化应用选择，以及 Host 请求载体。每个 cwd 只探测
 * 一次；组件只提交 Session id 与 Host 返回的 segments。
 */
export class OpenInAppController {
  /** cwd 到打开方式的映射；不存在表示尚未请求。 */
  readonly targets: SnapshotStore<WorkspaceOpenTargets> = createSnapshotStore<WorkspaceOpenTargets>({})
  /** 跨会话与浏览器重启保存的上次本地应用选择。 */
  readonly choice: SnapshotStore<string> = createSnapshotStore<string>('', {
    persist: { name: 'dsh.open-in-app.choice' },
  })

  private readonly loading = new Map<string, Promise<void>>()

  /**
   * @param fetcher - HTTP 请求载体。
   * @param routes - Host shared 路由；测试可注入同形表。
   */
  constructor(
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly routes: OpenInAppRoutes = OPEN_IN_APP_ROUTES,
  ) {}

  /**
   * 探测一个 cwd 的打开方式；同一路径的并发调用共享请求。
   * @param path - Session summary 提供的 Host cwd。
   * @returns 状态发布完成后的 Promise。
   */
  load(path: string): Promise<void> {
    const settled = this.targets.getSnapshot()[path]
    if (settled !== undefined && settled.kind !== 'loading') return Promise.resolve()
    const current = this.loading.get(path)
    if (current !== undefined) return current
    this.publish(path, { kind: 'loading' })
    const pending = this.loadTarget(path).finally(() => { this.loading.delete(path) })
    this.loading.set(path, pending)
    return pending
  }

  /**
   * 记住用户选择的本地应用，供其它 Session 的分体按钮复用。
   * @param appId - 当前 target catalog 中的应用 id。
   */
  choose(appId: string): void {
    this.choice.set(appId)
  }

  /**
   * 在本地应用中打开目录；目标若变成远端，Host 返回 files。
   * @param appId - catalog 应用 id。
   * @param path - Session 的绝对工作区目录。
   * @returns Host 实际执行的动作。
   */
  async launch(appId: string, path: string): Promise<OpenInAppOpenResult['action']> {
    const body: OpenInAppOpenPayload = { app: appId, path }
    const response = await this.fetcher(new URL(OPEN_IN_APP_OPEN_ROUTE, hostBase()), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`open failed: HTTP ${String(response.status)}`)
    return openResult(await responseRecord(response)).action
  }

  /**
   * 读取一层目录。
   * @param sessionId - 当前工作台 Session。
   * @param pathSegments - provider 返回的目录 segment 链。
   * @param signal - 取消当前读取。
   * @returns 当前层的展示路径和条目。
   */
  async listFiles(
    sessionId: SessionId,
    pathSegments: readonly string[],
    signal?: AbortSignal,
  ): Promise<WorkspaceFilesPayload> {
    const response = await this.fetcher(new URL(requiredRoute(this.routes.files, 'files route'), hostBase()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, segments: pathSegments }),
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) throw new Error(`workspace files failed: HTTP ${String(response.status)}`)
    return filesPayload(await responseRecord(response), pathSegments)
  }

  /**
   * 读取一个文件并由 Host 分类。
   * @param sessionId - 当前工作台 Session。
   * @param pathSegments - provider 返回的文件 segment 链。
   * @param signal - 取消当前读取。
   * @returns 文件展示路径与封闭内容类型。
   */
  async readFile(
    sessionId: SessionId,
    pathSegments: readonly string[],
    signal?: AbortSignal,
  ): Promise<WorkspaceFilePayload> {
    const response = await this.fetcher(new URL(requiredRoute(this.routes.readFile, 'file read route'), hostBase()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, segments: pathSegments }),
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) throw new Error(`workspace file failed: HTTP ${String(response.status)}`)
    return readPayload(await responseRecord(response))
  }

  /**
   * 生成当前 Session 的 Host 终端 WebSocket URL。
   * @param sessionId - 当前工作台 Session。
   * @param cols - PTY 初始列数，连接就绪后会由 xterm fit 更新。
   * @param rows - PTY 初始行数，连接就绪后会由 xterm fit 更新。
   * @returns 同源 ws/wss URL；Host 决定本地、Windows 或 Remote-SSH 后端。
   */
  terminalUrl(sessionId: SessionId, cols = 80, rows = 24): string {
    const url = new URL(requiredRoute(this.routes.terminal, 'terminal route'), hostBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('sessionId', sessionId)
    url.searchParams.set('cols', String(cols))
    url.searchParams.set('rows', String(rows))
    return url.toString()
  }

  private publish(path: string, target: WorkspaceOpenTarget): void {
    this.targets.set({ ...this.targets.getSnapshot(), [path]: target })
  }

  private async loadTarget(path: string): Promise<void> {
    const body: OpenInAppTargetRequest = { path }
    try {
      const response = await this.fetcher(new URL(OPEN_IN_APP_TARGET_ROUTE, hostBase()), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`target failed: HTTP ${String(response.status)}`)
      this.publish(path, targetPayload(await responseRecord(response)))
    } catch {
      this.publish(path, { kind: 'unavailable' })
    }
  }
}
