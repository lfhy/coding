/**
 * Modal dialog for a focused decision or a short form (create, rename, confirm, change password).
 * It owns Escape, backdrop dismissal, focus entry, and focus restore; the page only toggles `open`.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import styles from './Dialog.module.css'

export interface DialogProps {
  readonly open: boolean
  readonly title: string
  readonly children: ReactNode
  /** Footer actions: submit and cancel live here, not in the page body. */
  readonly footer?: ReactNode
  readonly onClose: () => void
  readonly width?: number
}

export function Dialog({ open, title, children, footer, onClose, width = 420 }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return undefined
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Focus the first field so keyboard users land inside the dialog.
    panel.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      restoreTo.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className={styles.backdrop} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div
        ref={panel}
        className={styles.panel}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>×</button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer === undefined ? null : <footer className={styles.footer}>{footer}</footer>}
      </div>
    </div>
  )
}
