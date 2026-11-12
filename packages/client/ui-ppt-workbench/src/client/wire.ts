/**
 * 面板侧的响应解析：HTTP 载荷是外部数据，只接受结构完整的工程快照。
 * 页面与元素内容复用宿主同一份 `parseDeck`，因此两端对「合法工程」的判定一致。
 * @module coding-ppt-workbench/client/wire
 */

import { isRecord, parseDeck, type PptDeck } from 'coding-ppt-model'

/** 面板看到的工程快照。 */
export interface PptSnapshotView {
  readonly dir: string
  readonly title: string
  readonly revision: number
  readonly deck: PptDeck
  readonly pages: number
  readonly canUndo: boolean
  readonly canRedo: boolean
}

/** 工程列表条目。 */
export interface PptProjectView {
  readonly dir: string
  readonly title: string
  readonly pages: number
  readonly revision: number
}

/** 模型要求面板打开某个工程。 */
export interface PptOpenRequestView {
  readonly dir: string
  readonly at: number
}

/** 一次 `state` 轮询的结果。 */
export interface PptStateView {
  readonly projects: readonly PptProjectView[]
  readonly active: PptSnapshotView | null
  readonly openRequest: PptOpenRequestView | null
  readonly root: string
}

/** 导出结果。 */
export interface PptExportView {
  readonly path: string
  readonly bytes: number
  readonly revision: number
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * 解析一个工程快照。
 * @param value - HTTP 返回的 `project` 字段。
 * @returns 结构完整时返回快照，否则 null。
 */
export function parseSnapshot(value: unknown): PptSnapshotView | null {
  if (!isRecord(value)) return null
  const dir = text(value.dir)
  const title = text(value.title)
  const revision = integer(value.revision)
  const pages = integer(value.pages)
  const canUndo = boolean(value.canUndo)
  const canRedo = boolean(value.canRedo)
  if (dir === null || title === null || revision === null || pages === null
    || canUndo === null || canRedo === null) return null
  try {
    return { dir, title, revision, deck: parseDeck(value.deck), pages, canUndo, canRedo }
  } catch {
    return null
  }
}

function parseProjects(value: unknown): PptProjectView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const dir = text(entry.dir)
    const title = text(entry.title)
    const pages = integer(entry.pages)
    const revision = integer(entry.revision)
    if (dir === null || title === null || pages === null || revision === null) return []
    return [{ dir, title, pages, revision }]
  })
}

function parseOpenRequest(value: unknown): PptOpenRequestView | null {
  if (!isRecord(value)) return null
  const dir = text(value.dir)
  const at = integer(value.at)
  return dir === null || at === null ? null : { dir, at }
}

/**
 * 解析 `GET /api/ppt/state` 的响应体。
 * @param value - 响应 JSON。
 * @returns 状态视图；结构不完整时 null。
 */
export function parseState(value: unknown): PptStateView | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.state)) return null
  const state = value.state
  const root = text(state.root)
  if (root === null) return null
  return {
    projects: parseProjects(state.projects),
    active: state.active === null ? null : parseSnapshot(state.active),
    openRequest: parseOpenRequest(state.openRequest),
    root,
  }
}

/**
 * 解析 `POST /api/ppt/export` 的响应体。
 * @param value - 响应 JSON。
 * @returns 导出结果；结构不完整时 null。
 */
export function parseExport(value: unknown): PptExportView | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.export)) return null
  const path = text(value.export.path)
  const bytes = integer(value.export.bytes)
  const revision = integer(value.export.revision)
  return path === null || bytes === null || revision === null ? null : { path, bytes, revision }
}

/**
 * 解析本机字体目录：`fonts` 必须是字符串数组，空串与重复项被丢弃。
 * 宿主可能返回很长的列表，这里按最多 500 个截断，避免下拉与快照无界增长。
 * @param value - HTTP 返回的 `/api/ppt/fonts` 载荷。
 * @returns 可用族名；结构不合法时 null。
 */
export function parseFonts(value: unknown): readonly string[] | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.fonts)) return null
  const families: string[] = []
  for (const entry of value.fonts) {
    if (typeof entry !== 'string') return null
    const family = entry.trim()
    if (family !== '' && !families.includes(family)) families.push(family)
    if (families.length === 500) break
  }
  return families
}

/**
 * 读取失败响应里的诊断文本。
 * @param value - 响应 JSON。
 * @param fallback - 没有可用文本时的兜底文案。
 * @returns 可展示的错误原因。
 */
export function errorOf(value: unknown, fallback: string): string {
  if (!isRecord(value) || !isRecord(value.error)) return fallback
  return text(value.error.message) ?? fallback
}
