/**
 * Select primitive: button + listbox popup so the closed and open states share the product theme.
 * A raw <select> keeps the platform arrow and native popup, which is why it is not used directly.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import styles from './fields.module.css'

export interface SelectOption {
  readonly value: string
  readonly label: string
}

export interface SelectProps {
  readonly label: string
  readonly value: string
  readonly options: readonly SelectOption[]
  readonly onChange: (value: string) => void
}

export function Select({ label, value, options, onChange }: SelectProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const selected = options.find(option => option.value === value)

  useEffect(() => {
    if (!open) return undefined
    setActive(Math.max(0, options.findIndex(option => option.value === value)))
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [open, options, value])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape') { setOpen(false); return }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(options.length - 1, index + 1)); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); return }
    if (event.key === 'Enter' && open) {
      event.preventDefault()
      const picked = options[active]
      if (picked !== undefined) { onChange(picked.value); setOpen(false) }
    }
  }

  return (
    <div className={styles.field} ref={root}>
      <span className={styles.label}>{label}</span>
      <button type="button" className={styles.select} role="combobox" aria-label={label}
        aria-expanded={open} aria-haspopup="listbox" onClick={() => { setOpen(current => !current) }} onKeyDown={onKeyDown}>
        <span className={styles.value}>{selected?.label ?? '—'}</span>
        <span className={styles.caret} aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul className={styles.listbox} role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <li key={option.value}>
              <button type="button" role="option" aria-selected={option.value === value}
                className={styles.option} data-active={index === active ? 'true' : undefined}
                onMouseEnter={() => { setActive(index) }}
                onClick={() => { onChange(option.value); setOpen(false) }}>
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
