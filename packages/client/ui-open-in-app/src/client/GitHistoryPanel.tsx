/** 当前会话的只读 Git 提交树；受限条数来自 Host，切换标签不发起后台轮询。 */
import { useEffect, useState, type CSSProperties } from 'react'
import { IconRefreshOutline16 } from 'coding-client-ui-primitives'
import type { GitCommit, GitHistory } from 'coding-host-apiproxy/api'
import type { WorkspaceWorkbenchProps } from './WorkspaceWorkbench.tsx'
import css from './GitHistoryPanel.module.css'

interface Props {
  shown: boolean
  history: (query: { count: number }, signal: AbortSignal) => Promise<GitHistory | null>
  t: WorkspaceWorkbenchProps['t']
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; history: GitHistory | null }
  | { phase: 'error' }

const PAGE_SIZE = 60
const MAX_VISIBLE = 300

interface GraphRow { commit: GitCommit; lane: number; tracks: number[]; junctions: number[] }

/** 按 Git 父边分配图列，并保留已经跨越当前行的分支轨。 */
function graphRows(commits: readonly GitCommit[]): GraphRow[] {
  const pending: string[] = []
  return commits.map((commit) => {
    const found = pending.indexOf(commit.id)
    const lane = found < 0 ? pending.length : found
    if (found < 0) pending.push(commit.id)
    const tracks = pending.map((_id, index) => index)
    pending.splice(lane, 1)
    const junctions: number[] = []
    for (const parent of commit.parents) {
      let index = pending.indexOf(parent)
      if (index < 0) {
        index = pending.length
        pending.push(parent)
      }
      junctions.push(index)
    }
    return { commit, lane, tracks, junctions }
  })
}

/**
 * 绘制当前会话仓库的有界 DAG，允许用户显式刷新和读取更早提交。
 * @param props - 可见性、Host Git 历史请求与本地化文本。
 * @returns 只读提交树与加载、空、非仓库和失败状态。
 */
export function GitHistoryPanel({ shown, history, t }: Props): React.JSX.Element {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [count, setCount] = useState(PAGE_SIZE)
  const [revision, setRevision] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [copyError, setCopyError] = useState(false)
  const [search, setSearch] = useState('')
  useEffect(() => {
    if (!shown) return
    const request = new AbortController()
    setState({ phase: 'loading' })
    void history({ count }, request.signal).then((value) => {
      if (!request.signal.aborted) setState({ phase: 'ready', history: value })
    }, () => {
      if (!request.signal.aborted) setState({ phase: 'error' })
    })
    return () => { request.abort() }
  }, [shown, count, revision, history])

  const loaded = state.phase === 'ready' ? state.history : null
  const rows = loaded === null ? [] : graphRows(loaded.commits)
  const searchTerm = search.trim().toLocaleLowerCase()
  const visibleRows = searchTerm === '' ? rows : rows.filter(({ commit }) =>
    [commit.subject, commit.author, commit.id, ...commit.refs].some(value => value.toLocaleLowerCase().includes(searchTerm)))
  const copyHash = async (id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id)
      setCopyError(false)
    } catch { setCopyError(true) }
  }
  return <section className={css.root} aria-label={t('workbench.menu.review')}>
    <header className={css.header}>
      <label className={css.search}>
        <span className={css.visuallyHidden}>{t('history.search')}</span>
        <input type="search" value={search} placeholder={t('history.search')}
          onChange={(event) => { setSearch(event.currentTarget.value) }} />
      </label>
      {loaded !== null && <span className={css.branch}>{loaded.current ?? 'HEAD'}</span>}
      <button type="button" className={css.refresh} aria-label={t('history.refresh')}
        title={t('history.refresh')} onClick={() => { setRevision(value => value + 1) }}>
        <IconRefreshOutline16 size={16} />
      </button>
    </header>
    {state.phase === 'loading' && <p className={css.message} role="status">{t('history.loading')}</p>}
    {state.phase === 'error' && <div className={css.message} role="alert">
      <span>{t('history.error')}</span>
      <button type="button" className={css.action} onClick={() => { setRevision(value => value + 1) }}>
        {t('history.retry')}
      </button>
    </div>}
    {state.phase === 'ready' && loaded === null &&
      <p className={css.message} role="status">{t('history.noRepository')}</p>}
    {state.phase === 'ready' && loaded !== null && rows.length === 0 &&
      <p className={css.message} role="status">{t('history.empty')}</p>}
    {state.phase === 'ready' && loaded !== null && rows.length > 0 && <div className={css.scroll}>
      {visibleRows.length === 0 && <p className={css.message} role="status">{t('history.noMatches')}</p>}
      <ol className={css.commits} aria-label={t('workbench.menu.review')}>
        {visibleRows.map(({ commit, lane, tracks, junctions }) => <li key={commit.id} className={css.commit}
          style={{ '--history-lanes': String(Math.max(1, ...tracks.map(index => index + 1), ...junctions.map(index => index + 1))) } as CSSProperties}>
          <span className={css.graph} aria-hidden="true">
            {tracks.map(index => <span key={index} className={css.track}
              style={{ '--history-lane': String(index) } as CSSProperties} />)}
            {junctions.filter(index => index !== lane).map(index => <span key={index} className={css.junction}
              style={{ '--history-lane': String(Math.min(index, lane)),
                '--history-width': `${String(Math.abs(index - lane) * 18 + 2)}px` } as CSSProperties} />)}
            <span className={css.dot} style={{ '--history-lane': String(lane) } as CSSProperties} />
          </span>
          <div className={css.details}>
            <button type="button" className={css.summary} title={commit.subject}
              aria-expanded={expanded === commit.id} onClick={() => { setExpanded(value => value === commit.id ? null : commit.id) }}>
              {commit.subject}
            </button>
            <div className={css.meta}>
              <code title={commit.id}>{commit.id.slice(0, 8)}</code>
              <span>{commit.author}</span>
              <time dateTime={commit.authoredAt}>{new Date(commit.authoredAt).toLocaleString()}</time>
            </div>
            {commit.refs.length > 0 && <div className={css.refs}>
              {commit.refs.map(ref => <span className={css.ref} key={ref}>{ref}</span>)}
            </div>}
            {expanded === commit.id && <div className={css.expanded}>
              <code>{commit.id}</code>
              <button type="button" className={css.action} onClick={() => { void copyHash(commit.id) }}>
                {t('history.copyHash')}
              </button>
              {copyError && <span role="alert">{t('history.copyError')}</span>}
            </div>}
          </div>
        </li>)}
      </ol>
      {loaded.truncated && searchTerm === '' && count < MAX_VISIBLE && <button type="button" className={css.more}
        onClick={() => { setCount(value => Math.min(value + PAGE_SIZE, MAX_VISIBLE)) }}>
        {t('history.more')}
      </button>}
      {loaded.truncated && searchTerm === '' && count >= MAX_VISIBLE && <p className={css.limit} role="status">{t('history.earlier')}</p>}
    </div>}
  </section>
}
