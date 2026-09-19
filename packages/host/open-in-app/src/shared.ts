/**
 * Host 路由与浏览器包共享的路径和 wire 载荷，通过 `./shared` 子路径发布。
 * 本模块只包含常量和类型，可安全内联到浏览器 bundle。
 */

/** 返回当前 Host 已探测应用 id 的 GET 路由。 */
export const OPEN_IN_APP_APPS_ROUTE = '/open-in-app/apps'

/** 返回工作区应使用本地应用还是内置文件页的 POST 路由。 */
export const OPEN_IN_APP_TARGET_ROUTE = '/open-in-app/target'

/** 为每个应用返回 PNG 图标的 GET 前缀。 */
export const OPEN_IN_APP_ICON_PREFIX = '/open-in-app/icon'

/** 在一个工作区目录上启动应用的 POST 路由。 */
export const OPEN_IN_APP_OPEN_ROUTE = '/open-in-app/open'

/** 按 Session 工作区逐层列出目录的 POST 路由。 */
export const OPEN_IN_APP_FILES_ROUTE = '/open-in-app/files'

/** 读取一个 Session 工作区文件预览的 POST 路由。 */
export const OPEN_IN_APP_READ_ROUTE = '/open-in-app/read'

/** 启动一个与 WebSocket 生命周期绑定的用户终端。 */
export const OPEN_IN_APP_TERMINAL_ROUTE = '/open-in-app/terminal'

/** 应用目录响应，按菜单顺序排列已探测到的 catalog id。 */
export interface OpenInAppAppsPayload {
  readonly apps: readonly string[]
}

/** 工作区目标探测请求。 */
export interface OpenInAppTargetRequest {
  readonly path: string
}

/** 工作区目标探测响应；`files` 会使用内置文件管理页。 */
export type OpenInAppTargetPayload =
  | { readonly kind: 'local'; readonly apps: readonly string[] }
  | { readonly kind: 'files'; readonly apps: readonly [] }

/** 本地应用启动请求。 */
export interface OpenInAppOpenPayload {
  readonly app: string
  readonly path: string
}

/** 启动请求结果；目标在请求间切成远端时会要求客户端打开文件页。 */
export interface OpenInAppOpenResult {
  readonly ok: true
  readonly action: 'launched' | 'files'
}

/** 内置工作台的一次 Session 绑定路径请求。 */
export interface OpenInAppFilesRequest {
  readonly sessionId: string
  readonly segments: readonly string[]
}

/** 文件管理页中的一项；不向浏览器暴露 provider target key。 */
export interface OpenInAppFileEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

/** 一层目录响应；`displayPath` 来自文件系统 provider。 */
export interface OpenInAppFilesPayload {
  readonly displayPath: string
  readonly entries: readonly OpenInAppFileEntry[]
  readonly truncated: boolean
}

/** 一个工作区文件预览请求；最后一段必须匹配普通文件。 */
export interface OpenInAppReadRequest {
  readonly sessionId: string
  readonly segments: readonly string[]
}

/** 所有文件预览响应共有的展示信息。 */
export interface OpenInAppReadBase {
  readonly displayPath: string
  readonly name: string
  readonly truncated: boolean
}

/** 文件预览响应；过大或非 UTF-8 的文件不会把内容带到浏览器。 */
export type OpenInAppReadPayload = OpenInAppReadBase & (
  | {
    readonly kind: 'text'
    readonly format: 'markdown' | 'code' | 'text'
    readonly text: string
  }
  | {
    readonly kind: 'image'
    readonly mime: string
    readonly dataBase64: string
  }
  | {
    readonly kind: 'unsupported'
    readonly reason: 'binary' | 'too-large'
  }
)

/** 浏览器发给用户终端的封闭控制帧。 */
export type OpenInAppTerminalClientFrame =
  | { readonly type: 'input'; readonly data: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly type: 'close' }

/** Host 发给浏览器的封闭终端帧。 */
export type OpenInAppTerminalServerFrame =
  | {
    readonly type: 'ready'
    readonly pid: number
    readonly shell: { readonly name: string; readonly path: string }
    readonly cwd: string
    readonly cols: number
    readonly rows: number
  }
  | { readonly type: 'output'; readonly data: string }
  | { readonly type: 'exit'; readonly exitCode: number | null; readonly signal: string | null }
  | {
    readonly type: 'error'
    readonly code: 'bad-frame' | 'terminal-unavailable' | 'terminal-failed'
    readonly message: string
  }
