/** 浏览器工作台对 Host shared 约定的展示投影。 */

import {
  OPEN_IN_APP_FILES_ROUTE,
  OPEN_IN_APP_LOCATE_ROUTE,
  OPEN_IN_APP_READ_ROUTE,
  OPEN_IN_APP_SAVE_ROUTE,
  OPEN_IN_APP_TERMINAL_ROUTE,
} from 'coding-host-open-in-app/shared'
import type {
  OpenInAppTerminalClientFrame,
  OpenInAppTerminalServerFrame,
} from 'coding-host-open-in-app/shared'

/** 本包所有 Host 请求使用的集中路由表。 */
export interface OpenInAppRoutes {
  readonly files: string
  readonly locate: string
  readonly readFile: string
  readonly saveFile: string
  readonly terminal: string
}

/** 默认值直接来自 Host shared；本包不复制协议路径。 */
export const OPEN_IN_APP_ROUTES: OpenInAppRoutes = {
  files: OPEN_IN_APP_FILES_ROUTE,
  locate: OPEN_IN_APP_LOCATE_ROUTE,
  readFile: OPEN_IN_APP_READ_ROUTE,
  saveFile: OPEN_IN_APP_SAVE_ROUTE,
  terminal: OPEN_IN_APP_TERMINAL_ROUTE,
}

/** 路径定位结果：Host 在自己的执行世界里解析出的 provider 段链。 */
export interface WorkspaceLocatedPath {
  readonly segments: readonly string[]
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
  | { readonly kind: 'html'; readonly text: string }
  | { readonly kind: 'svg'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly mimeType: string; readonly data: string }
  | { readonly kind: 'unsupported'; readonly mimeType?: string; readonly reason?: 'binary' | 'too-large' }

/** 单文件读取响应。 */
export interface WorkspaceFilePayload {
  readonly path: string
  readonly version: string
  readonly content: WorkspaceFileContent
}

/** 版本化保存的封闭结果；冲突与权限拒绝保留为可恢复的结构化失败。 */
export type WorkspaceFileSaveResult =
  | { readonly ok: true; readonly value: WorkspaceFileSavePayload }
  | { readonly ok: false; readonly error: WorkspaceFileFailure }

/** 保存失败；status 与 code 来自 Host 的稳定工作区协议。 */
export interface WorkspaceFileFailure {
  readonly status: number
  readonly code: string
}

/** 一次成功保存的投影。 */
export interface WorkspaceFileSavePayload {
  readonly path: string
  readonly version: string
  readonly operation: 'create' | 'update'
}

/** 浏览器发往 Host 的终端帧。 */
export type TerminalClientFrame = OpenInAppTerminalClientFrame

/** Host 发往浏览器的终端帧。 */
export type TerminalServerFrame = OpenInAppTerminalServerFrame
