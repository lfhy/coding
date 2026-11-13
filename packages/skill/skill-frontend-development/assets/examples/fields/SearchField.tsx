/**
 * Search field primitive: product-styled input with its own clear action.
 * Never ship <input type="search"> raw — the platform draws the magnifier, clear button and box.
 */
import { useRef, useState, type ChangeEvent } from 'react'
import styles from './fields.module.css'

export interface SearchFieldProps {
  readonly label: string
  readonly value: string
  readonly placeholder?: string
  readonly onChange: (value: string) => void
  /** Called when the query is cleared, so the caller can reset filters and scroll. */
  readonly onClear?: () => void
}

export function SearchField({ label, value, placeholder, onChange, onClear }: SearchFieldProps) {
  const [draft, setDraft] = useState(value)
  const input = useRef<HTMLInputElement>(null)

  const commit = (next: string): void => {
    setDraft(next)
    onChange(next)
  }
  const clear = (): void => {
    commit('')
    onClear?.()
    input.current?.focus()
  }

  return (
    <div className={styles.search} role="search">
      <input
        ref={input}
        className={styles.input}
        type="text"
        role="searchbox"
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(event: ChangeEvent<HTMLInputElement>) => { commit(event.target.value) }}
        onKeyDown={(event) => { if (event.key === 'Escape' && draft !== '') { event.preventDefault(); clear() } }}
      />
      {draft === '' ? null : (
        <button type="button" className={styles.clear} aria-label={`Clear ${label.toLowerCase()}`} onClick={clear}>×</button>
      )}
    </div>
  )
}
