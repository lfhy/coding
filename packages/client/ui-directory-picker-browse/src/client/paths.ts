/**
 * 目录浏览器用到的纯路径推导：面包屑显示、平台分隔符、草稿与层级的匹配、
 * 以及失败文本的归一化。全部无状态，组件与 hook 共用；这里不碰 React。
 */
import { DirectoryBrowseError } from 'coding-client-runtime/client'
import type { DirectoryEntry, DirectoryListing } from 'coding-client-runtime/client'

/**
 * 失败文本：Host 业务错误用它自己的 message，其它抛出用错误文本。
 * @param error - 列举/建目录/改名/删除的失败值。
 * @returns 可直接放进对话框 alert 的文本。
 */
export function failureText(error: unknown): string {
  if (error instanceof DirectoryBrowseError) return error.rpcError.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * 面包屑显示用行：主目录子树内从本地化的 Home crumb 开始，之外显示完整祖先，
 * 根 crumb 以自己的路径标注。
 * @param listing - 当前层级的列举结果。
 * @param homeLabel - 本地化的「主目录」文案。
 * @returns 供头部渲染的 crumb 列表。
 */
export function displayCrumbs(listing: DirectoryListing, homeLabel: string): DirectoryEntry[] {
  const homeIndex = listing.crumbs.findIndex(crumb => crumb.path === listing.home)
  if (homeIndex === -1) return listing.crumbs
  const tail = listing.crumbs.slice(homeIndex + 1)
  return [{ name: homeLabel, path: listing.home, hidden: false }, ...tail]
}

/**
 * 层级的平台分隔符，取自 Host 标注的 home 路径——绝不从输入文本或条目路径
 * 推断，那里反斜杠在 POSIX 上是合法名字字符。最后一步仍是启发式：名字里带
 * 反斜杠的 POSIX 主目录会被误读。
 * TODO: 改成 Host 在 `DirectoryListing` 上传一个 `separator` 字段，让平台事实
 * 逐字传递（取舍记录在目录选择能力 seam 设计记录里）。
 * @param listing - 当前层级的列举结果。
 * @returns `\\` 或 `/`。
 */
export function separatorOf(listing: DirectoryListing): '\\' | '/' {
  return listing.home.includes('\\') ? '\\' : '/'
}

/** 列举层级作为目录部分：它自己的路径，以分隔符结尾（根目录本来就是）。 */
export function levelDirectory(listing: DirectoryListing): string {
  const sep = separatorOf(listing)
  return listing.path.endsWith(sep) ? listing.path : `${listing.path}${sep}`
}

/** 草稿跟随扫描上一次发出的目录文本，以及 Host 应答它时的层级路径。 */
export interface ScannedDirectory {
  /** 草稿的目录部分，逐字按发出时的样子。 */
  readonly directory: string
  /** 回来的列举的 `path`。 */
  readonly landed: string
}

/**
 * 草稿的目录部分——截至最后一个分隔符——在没有键入任何分隔符时为 null
 * （那时还没有指向任何目录）。平台来自 `listing`：Windows 上前斜杠也分隔
 * （Host 的 `resolve` 接受两种），POSIX 上反斜杠是合法名字字符，从不是分隔符。
 * @param listing - 当前层级。
 * @param draft - 输入的路径草稿。
 * @returns 目录部分，或 null。
 */
export function draftDirectory(listing: DirectoryListing, draft: string): string | null {
  const cut = separatorOf(listing) === '\\'
    ? Math.max(draft.lastIndexOf('\\'), draft.lastIndexOf('/'))
    : draft.lastIndexOf('/')
  return cut === -1 ? null : draft.slice(0, cut + 1)
}

/**
 * 草稿相对某一层读出的结果：它指向的目录部分，以及（当 `listing` 正是那段
 * 目录文本所指的层级时）用末段对该层做前缀过滤的文本。层级响应某段目录文本
 * 的条件是它自己的路径就是那段文本，或者它正是那段文本刚扫描出来的层级
 * （`scanned`）：Host 会 `resolve` 收到的路径，于是 `..` 段与 Windows 正向
 * 斜杠能到达路径拼写不同的同一层级。
 * @param listing - 用来读草稿的层级。
 * @param draft - 当前路径草稿。
 * @param scanned - 上一次草稿跟随扫描的目录文本与落地路径。
 * @returns 草稿的目录部分（未键入分隔符时为 null）与其过滤尾段（该层不应答时为 null）。
 */
export function readDraft(
  listing: DirectoryListing,
  draft: string,
  scanned: ScannedDirectory | null,
): { directory: string | null; tail: string | null } {
  const directory = draftDirectory(listing, draft)
  if (directory === null) return { directory: null, tail: null }
  const answers = directory === levelDirectory(listing)
    || (scanned !== null && scanned.directory === directory && scanned.landed === listing.path)
  return { directory, tail: answers ? draft.slice(directory.length) : null }
}
