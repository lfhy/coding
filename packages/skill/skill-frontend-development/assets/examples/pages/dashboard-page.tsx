/**
 * Dashboard shell: the page is exactly one viewport tall, stat cards stay put, and every panel owns
 * its own scroll area. Adding rows to a list must never make the document taller.
 */
import { useState } from 'react'
import styles from './dashboard-page.module.css'

export interface ActivityRow {
  readonly id: string
  readonly title: string
  readonly meta: string
}

export interface DashboardPageProps {
  readonly stats: readonly { readonly label: string; readonly value: string; readonly hint: string }[]
  readonly activity: readonly ActivityRow[]
  readonly nodes: readonly { readonly name: string; readonly status: string; readonly seen: string }[]
}

export function DashboardPage({ stats, activity, nodes }: DashboardPageProps) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Overview</h1>
        <button type="button" className={styles.primary}>New node</button>
      </header>
      <div className={styles.stats}>
        {stats.map(stat => (
          <section key={stat.label} className={styles.stat}>
            <div className={styles.statLabel}>{stat.label}</div>
            <div className={styles.statValue}>{stat.value}</div>
            <div className={styles.statHint}>{stat.hint}</div>
          </section>
        ))}
      </div>
      <div className={styles.panels}>
        <Panel title="Nodes" action="View all">
          <ul className={styles.list}>
            {nodes.map(node => (
              <li key={node.name} className={styles.row}>
                <span className={styles.rowTitle} title={node.name}>{node.name}</span>
                <span className={styles.rowMeta}>{node.status}</span>
                <span className={styles.rowMeta}>{node.seen}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Recent activity" action="View all">
          <ul className={styles.list}>
            {activity.map(row => (
              <li key={row.id} className={styles.row}>
                <span className={styles.rowTitle} title={row.title}>{row.title}</span>
                <span className={styles.rowMeta}>{row.meta}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  )
}

/** Panel with a fixed header and one bounded scroll body; the card itself never grows with rows. */
function Panel({ title, action, children }: { title: string; action: string; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <section className={styles.panel} data-expanded={expanded ? 'true' : undefined}>
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>{title}</h2>
        <button type="button" className={styles.link} onClick={() => { setExpanded(value => !value) }}>
          {expanded ? 'Collapse' : action}
        </button>
      </header>
      <div className={styles.panelBody}>{children}</div>
    </section>
  )
}
