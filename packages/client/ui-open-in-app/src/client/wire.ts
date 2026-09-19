/** 浏览器工作台对 Host shared 约定的展示投影。 */

import {
  OPEN_IN_APP_FILES_ROUTE,
  OPEN_IN_APP_READ_ROUTE,
  OPEN_IN_APP_TERMINAL_ROUTE,
} from '@deepseek-ai/dsh-host-open-in-app/shared'
import type {
  OpenInAppTerminalClientFrame,
  OpenInAppTerminalServerFrame,
} from '@deepseek-ai/dsh-host-open-in-app/shared'

/** 本包所有 Host 请求使用的集中路由表。 */
export interface OpenInAppRoutes {
  readonly files: string
  readonly readFile: string
  readonly terminal: string
}

/** 默认值直接来自 Host shared；本包不复制协议路径。 */
export const OPEN_IN_APP_ROUTES: OpenInAppRoutes = {
  files: OPEN_IN_APP_FILES_ROUTE,
  readFile: OPEN_IN_APP_READ_ROUTE,
  terminal: OPEN_IN_APP_TERMINAL_ROUTE,
}

/** 文件树条目携带 provider 返回的完整 segment 地址。 */
export interface WorkspaceFileEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly segments: readonly string[]
  readonly size?: number
}

/** 一层目录响应；`path` 仅用于显示，后续请求只回传 segments。 */
export interface WorkspaceFilesPayload {
  readonly path: string
  readonly entries: readonly WorkspaceFileEntry[]
  readonly truncated: boolean
}

/** Host 已分类的可预览内容。 */
export type WorkspaceFileContent =
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string; readonly language?: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly mimeType: string; readonly data: string }
  | { readonly kind: 'unsupported'; readonly mimeType?: string }

/** 单文件读取响应。 */
export interface WorkspaceFilePayload {
  readonly path: string
  readonly content: WorkspaceFileContent
}

/** 浏览器发往 Host 的终端帧。 */
export type TerminalClientFrame = OpenInAppTerminalClientFrame

/** Host 发往浏览器的终端帧。 */
export type TerminalServerFrame = OpenInAppTerminalServerFrame
