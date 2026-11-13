/**
 * List surface: the page owns 100dvh, the header and filter toolbar stay put, only the body scrolls.
 * Rows are one line and one height; long names ellipsize. Swap the plain list for the project's
 * virtualizer once a page can exceed a viewport of rows.
 */
import { useMemo, useState } from 'react'
import styles from './list-page.module.css'

export interface ListRow {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly updatedAt: string
}

export interface ListPageProps {
  readonly rows: readonly ListRow[]
  readonly loading?: boolean
  readonly onSearch?: (query: string) => void
}

export function ListPage({ rows, loading = false, onSearch }: ListPageProps) {
  const [query, setQuery] = useState('')
  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return keyword === '' ? rows : rows.filter(row => row.name.toLowerCase().includes(keyword))
  }, [rows, query])

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Projects</h1>
        <button type="button" className={styles.primary}>New project</button>
      </header>
      <div className={styles.toolbar}>
        <input
          className={styles.search}
          value={query}
          placeholder="Search projects"
          aria-label="Search projects"
          onChange={(event) => {
            setQuery(event.target.value)
            onSearch?.(event.target.value)
          }}
        />
      </div>
      <div className={styles.viewport} role="list">
        {visible.length === 0 && !loading ? (
          <p className={styles.empty}>No project matches that search.</p>
        ) : null}
        {visible.map(row => (
          <div key={row.id} className={styles.row} role="listitem">
            <span className={styles.name} title={row.name}>{row.name}</span>
            {/* 行内单元格是同一条垂直中线的：图标盒固定尺寸，文字与它的中心对齐。 */}
            <span className={styles.statusCell}>
              <span className={styles.dot} aria-hidden="true" />
              <span className={styles.status}>{row.status}</span>
            </span>
            <span className={styles.meta}>{row.updatedAt}</span>
          </div>
        ))}
        {loading ? <p className={styles.more}>Loading more…</p> : null}
      </div>
    </div>
  )
}
