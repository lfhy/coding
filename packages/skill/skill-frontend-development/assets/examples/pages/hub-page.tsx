/**
 * Hub surface: the user picks one of several ways to do the same job. The current state is a focus band,
 * the ways are comparable rows, and reference material is a quiet link list — never a wall of equal cards.
 * Copy the shape into the project's own page layer and map the `--ui-*` seams onto its tokens.
 */
import { useState } from 'react'
import styles from './hub-page.module.css'

export interface HubEntry {
  readonly id: string
  readonly name: string
  /** One line saying what it is and who it is for: this is the comparison. */
  readonly summary: string
  readonly requirement: string
  readonly connected: boolean
}

export interface HubPageProps {
  readonly entries: readonly HubEntry[]
  readonly attention?: { readonly title: string; readonly detail: string } | undefined
  readonly onConnect?: (id: string) => void
  readonly onReview?: () => void
}

export function HubPage({ entries, attention, onConnect, onReview }: HubPageProps) {
  const [selected, setSelected] = useState(entries[0]?.id ?? '')
  const connected = entries.filter(entry => entry.connected).length

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1 className={styles.title}>Access methods</h1>
          {/* The subtitle says what the page is for; it is not a slogan and not a feature list. */}
          <p className={styles.subtitle}>Connect your own tool through one of three protocols, then check it here.</p>
        </div>
        <button type="button" className={styles.primary} onClick={() => { onConnect?.(selected) }}>
          Create connection
        </button>
      </header>

      {/* Focus band: the user's own situation, and the one thing that needs attention. */}
      <section className={styles.focus} aria-labelledby="hub-focus-title">
        <div className={styles.focusMain}>
          <h2 id="hub-focus-title" className={styles.focusTitle}>
            Connected {connected} of {entries.length}
          </h2>
          <p className={styles.focusMeta}>Checked 4 minutes ago · changes take effect on the next request.</p>
          <ul className={styles.statusRow}>
            {entries.map(entry => (
              <li key={entry.id} className={styles.status} data-state={entry.connected ? 'on' : 'off'}>
                <span className={styles.dot} aria-hidden="true" />
                {entry.name}
                <span className={styles.statusText}>{entry.connected ? 'connected' : 'not connected'}</span>
              </li>
            ))}
          </ul>
        </div>
        {attention === undefined ? null : (
          <div className={styles.attention}>
            <div>
              <div className={styles.attentionTitle}>{attention.title}</div>
              <div className={styles.focusMeta}>{attention.detail}</div>
            </div>
            <button type="button" className={styles.secondary} onClick={() => { onReview?.() }}>Review</button>
          </div>
        )}
      </section>

      {/* Entry rows: peers compared at a glance. One row per way, not one card per way. */}
      <section className={styles.entries} aria-labelledby="hub-entries-title">
        <h2 id="hub-entries-title" className={styles.regionTitle}>Ways to connect</h2>
        <div className={styles.rowList} role="list">
          {entries.map(entry => (
            <div key={entry.id} className={styles.row} role="listitem">
              <span className={styles.rowName} title={entry.name}>
                <span className={styles.rowMark} aria-hidden="true" />
                {entry.name}
              </span>
              <span className={styles.rowSummary} title={entry.summary}>{entry.summary}</span>
              <span className={styles.rowMeta}>{entry.requirement}</span>
              <button
                type="button"
                className={styles.rowAction}
                onClick={() => { setSelected(entry.id); onConnect?.(entry.id) }}
              >
                {entry.connected ? 'Manage' : 'Set up'}
                <span aria-hidden="true">›</span>
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Reference stays quiet: links, not cards. */}
      <footer className={styles.reference}>
        <a className={styles.link} href="#reference">API reference</a>
        <a className={styles.link} href="#status">Status</a>
        <a className={styles.link} href="#changelog">Changelog</a>
      </footer>
    </div>
  )
}
