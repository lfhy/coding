/** 侧栏搜索只投影当前选项卡的可见范围，Host 内容命中不能绕过归属过滤。 */
import { useMemo } from 'react'
import clsx from 'clsx'
import type { SessionId, SessionSearchResultItem, WorkspaceView } from 'coding-client-runtime/client'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import type { WorkspaceViewMode } from './stores.ts'
import { deriveSearchResults } from './tree.ts'
import { SearchResultItem } from './rows/Rows.tsx'
import css from './WorkspaceBrowser.module.css'

/** 与内容搜索协议相同的 UTF-16 长度上限。 */
export const SEARCH_QUERY_MAX_CODE_UNITS = 500

/**
 * 删除 NUL 并按协议截断，避免拆开代理项对。
 * @param value - 用户或程序设置的查询。
 * @returns 可作为受控字段与 RPC 参数的查询。
 */
export function sanitizeSearchQuery(value: string): string {
  const withoutNul = value.replaceAll('\0', '')
  if (withoutNul.length <= SEARCH_QUERY_MAX_CODE_UNITS) return withoutNul
  let end = SEARCH_QUERY_MAX_CODE_UNITS
  const last = withoutNul.charCodeAt(end - 1)
  const next = withoutNul.charCodeAt(end)
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--
  return withoutNul.slice(0, end)
}

/** 搜索结果保持请求局部，不写入运行时会话或浏览偏好。 */
export interface RemoteSearchState {
  query: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  items: readonly SessionSearchResultItem[]
  hasMore: boolean
}

/**
 * 合并当前范围的名称与内容命中，保留既有加载、空态与失败提示。
 * @param props - 当前范围、会话快照入口及当前请求结果。
 * @returns 有界的搜索列表。
 */
export function SearchResults({
  useSessions, conversationVisible, open, workspaces, archivedSessionIds, query, remote, resultLimit, view, t,
}: Pick<WorkspaceBrowserProps, 'useSessions' | 'open' | 't' | 'conversationVisible'> & {
  workspaces: readonly WorkspaceView[]
  archivedSessionIds: readonly SessionId[]
  query: string
  remote: RemoteSearchState
  resultLimit: number
  view: WorkspaceViewMode
}) {
  const list = useSessions(state => state)
  const currentRemote = remote.query === query
    ? remote
    : { query, status: 'loading' as const, items: [], hasMore: false }
  const results = useMemo(
    () => deriveSearchResults(list, workspaces, query, archivedSessionIds, currentRemote, resultLimit, view),
    [list, workspaces, query, archivedSessionIds, currentRemote, resultLimit, view],
  )
  const pending = currentRemote.status === 'loading'
  const failed = currentRemote.status === 'error'

  return (
    <div className={clsx(css.treeBody, css.wide)}>
      <div className={css.list}>
        <div className={css.searchTree} role="tree" aria-label={t('search.results.aria')}>
          {results.items.map(result => (
            <SearchResultItem
              key={result.id}
              result={result}
              currentId={conversationVisible ? list.current : undefined}
              onOpen={open}
              t={t}
            />
          ))}
        </div>
        {pending && <div className={css.searchStatus} role="status">{t('search.pending')}</div>}
        {failed && <div className={css.searchWarning} role="status">{t('search.unavailable')}</div>}
        {!pending && results.items.length === 0 && <div className={css.empty}>{t('search.noMatches')}</div>}
        {results.hasMore && <div className={css.searchStatus}>{t('search.hasMore', { n: resultLimit })}</div>}
      </div>
      <span className={css.fade} />
    </div>
  )
}
