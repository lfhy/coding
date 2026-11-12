/**
 * Child tabs: sibling views inside one page or drawer, one panel at a time.
 * Copy into the project's shared UI layer and keep the ARIA wiring unchanged.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import styles from './Tabs.module.css'

export interface TabItem {
  readonly id: string
  readonly label: string
  readonly content: ReactNode
}

export interface TabsProps {
  readonly items: readonly TabItem[]
  readonly value: string
  /** Keys the selection so the page can restore the last viewed section. */
  readonly onChange: (id: string) => void
  readonly label: string
  readonly orientation?: 'horizontal' | 'vertical'
}

export function Tabs({ items, value, onChange, label, orientation = 'horizontal' }: TabsProps) {
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const active = items.find(item => item.id === value)

  const step = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = items.findIndex(item => item.id === value)
    if (index < 0) return
    const forward = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight'
    const backward = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft'
    const offset = event.key === forward ? 1 : event.key === backward ? -1 : 0
    if (offset === 0) return
    event.preventDefault()
    const next = items[(index + offset + items.length) % items.length]
    if (next === undefined) return
    onChange(next.id)
    buttons.current.get(next.id)?.focus()
  }

  return (
    <div className={styles.root} data-orientation={orientation}>
      <div className={styles.list} role="tablist" aria-label={label} aria-orientation={orientation} onKeyDown={step}>
        {items.map(item => (
          <button
            key={item.id}
            ref={(node) => { if (node !== null) buttons.current.set(item.id, node) }}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={item.id === value}
            aria-controls={`panel-${item.id}`}
            tabIndex={item.id === value ? 0 : -1}
            className={styles.tab}
            onClick={() => { onChange(item.id) }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {active === undefined ? null : (
        <div
          className={styles.panel}
          role="tabpanel"
          id={`panel-${active.id}`}
          aria-labelledby={`tab-${active.id}`}
          tabIndex={0}
        >
          {active.content}
        </div>
      )}
    </div>
  )
}
